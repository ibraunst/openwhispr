#!/usr/bin/env node
/**
 * sherpaDiarizationEngine.js — sherpa-onnx speaker diarization & identification
 * worker (Tier 6 A/B alternative to python/speaker_engine.py).
 *
 * Forked as an Electron utilityProcess by src/helpers/sherpaDiarization.js so
 * the fbank/FFT math never runs on the main thread. Pure Node — no Electron
 * imports — every path arrives via argv.
 *
 * Pipeline (mirrors speaker_engine.py step for step):
 *   1. Diarize the primary meeting WAV via the sherpa-onnx-offline-speaker-
 *      diarization CLI (pyannote-segmentation-3.0 ONNX + CAM++ + clustering)
 *   2. Consolidate over-split clusters by CAM++ embedding similarity and
 *      enforce the optional --max-speakers cap
 *   3. Extract a CAM++ embedding from the voiced windows of the mic WAV,
 *      compare each cluster against it (cosine) — matches become "Me"
 *   4. Resolve remaining clusters via the persistent sherpa VoiceBank
 *      (SQLite; CAM++ space — never shared with the pyannote bank)
 *   5. Merge speaker labels onto transcript.json with the exact rules of
 *      speaker_engine.py merge_transcript (best overlap, else closest
 *      midpoint) so an engine A/B never measures merge differences
 *
 * The labeled transcript (segments[].speaker + speakers[] metadata) is
 * written back to --transcript; stdout carries only a compact JSON summary.
 * Progress/diagnostics go to stderr as JSON event lines.
 */

const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ME_LABEL = "Me";
const MIN_SEGMENT_DURATION = 0.5; // absolute floor for any embedding input
// CAM++ embeddings are unnormalized and sub-1s inputs produce huge-norm junk
// vectors that dominate a cluster average (measured: including 0.5-1s
// segments pushed different-speaker centroid cosine from 0.49 to 0.92).
// Embeddings are L2-normalized before averaging AND segments under this
// length are excluded from cluster centroids.
const EMBED_MIN_SEGMENT_SECONDS = 1.0;
const MAX_EMBEDDING_SECONDS = 8; // CAM++ input cap (upstream-proven envelope)
// Clusters whose averaged CAM++ embeddings are at least this similar are the
// same person split by over-clustering (sherpa's fast clustering fragments
// more than pyannote). Calibrated on archived meeting audio (kaldi+CMN
// frontend): same-person cluster pairs land 0.55-0.89, different-person
// major pairs stay ≤0.17.
const CONSOLIDATE_SIMILARITY = 0.55;
// Two clusters that BOTH carry substantial speech are almost never the same
// person at borderline similarity — fragments are what consolidation exists
// for. Without this guard, agglomerative chaining (each merge drifts the
// centroid toward the next candidate) collapsed a 58-min meeting's two
// dominant speakers into one cluster via a 0.55-0.62 merge chain.
const MAJOR_CLUSTER_SECONDS = 60;
const MAJOR_MERGE_SIMILARITY = 0.75;
// Clusters with less than this much embedded speech produce junk centroids
// (a 2s cluster sat at 0.66 cosine to a different speaker in calibration) —
// they are force-merged into their most similar cluster instead of being
// labeled or enrolled as phantom guests.
const MIN_CLUSTER_SECONDS = 3;
const CLI_TIMEOUT_MS = 14 * 60 * 1000; // manager SIGKILLs the worker at 15 min

// ---------------------------------------------------------------------------
// stderr event logging (the manager forwards these to debugLogger)
// ---------------------------------------------------------------------------

function emit(event, extra) {
  try {
    process.stderr.write(JSON.stringify({ event, ...(extra || {}) }) + "\n");
  } catch {
    // Never let logging kill the pipeline.
  }
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// WAV reading (16 kHz mono s16le from ffmpegUtils.convertToWav)
// ---------------------------------------------------------------------------

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`Not a WAV file: ${filePath}`);
  }

  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buf.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error(`No data chunk in WAV: ${filePath}`);
  if (sampleRate !== 16000 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `Expected 16kHz mono s16 WAV, got ${sampleRate}Hz/${channels}ch/${bitsPerSample}bit: ${filePath}`
    );
  }

  return { buf, dataOffset, numSamples: Math.floor(dataLength / 2), sampleRate };
}

function sliceSamples(wav, startSec, endSec) {
  const startSample = Math.max(0, Math.floor(startSec * wav.sampleRate));
  const endSample = Math.min(wav.numSamples, Math.floor(endSec * wav.sampleRate));
  const n = endSample - startSample;
  if (n <= 0) return new Float32Array(0);
  const out = new Float32Array(n);
  const base = wav.dataOffset + startSample * 2;
  for (let i = 0; i < n; i++) {
    out[i] = wav.buf.readInt16LE(base + i * 2) / 32768;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kaldi-parity 80-dim log-mel fbank + per-utterance CMN — matches what
// 3D-Speaker's CAM++ was trained on (torchaudio kaldi fbank: povey window,
// pre-emphasis 0.97, per-frame DC removal, int16-range samples, continuous
// mel weights, mean normalization). The upstream OpenWhispr fbank (hamming,
// no preemph, [-1,1] scale, integer-floored mel bins, no CMN) measured far
// worse speaker discrimination on real meeting audio, so it was replaced.
// ---------------------------------------------------------------------------

const FBANK_SAMPLE_RATE = 16000;
const FBANK_NUM_MELS = 80;
const FBANK_FRAME_LENGTH = Math.round((FBANK_SAMPLE_RATE * 25) / 1000);
const FBANK_FRAME_SHIFT = Math.round((FBANK_SAMPLE_RATE * 10) / 1000);
const FBANK_FFT_SIZE = 512;
const PREEMPHASIS = 0.97;

let _melFilterbank = null;
function getMelFilterbank() {
  if (_melFilterbank) return _melFilterbank;

  const numBins = FBANK_FFT_SIZE / 2 + 1;
  const mel = (f) => 1127 * Math.log(1 + f / 700);
  const melLow = mel(20);
  const melHigh = mel(FBANK_SAMPLE_RATE / 2);
  const melDelta = (melHigh - melLow) / (FBANK_NUM_MELS + 1);

  _melFilterbank = new Array(FBANK_NUM_MELS);
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    const left = melLow + m * melDelta;
    const center = left + melDelta;
    const right = center + melDelta;
    const filter = new Float32Array(numBins);
    for (let k = 0; k < numBins; k++) {
      const melK = mel((k * FBANK_SAMPLE_RATE) / FBANK_FFT_SIZE);
      if (melK > left && melK < right) {
        filter[k] =
          melK <= center ? (melK - left) / (center - left) : (right - melK) / (right - center);
      }
    }
    _melFilterbank[m] = filter;
  }

  return _melFilterbank;
}

let _poveyWindow = null;
function getPoveyWindow() {
  if (_poveyWindow) return _poveyWindow;
  _poveyWindow = new Float32Array(FBANK_FRAME_LENGTH);
  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    _poveyWindow[i] = Math.pow(
      0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME_LENGTH - 1)),
      0.85
    );
  }
  return _poveyWindow;
}

function realFFT(frame) {
  const n = FBANK_FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < frame.length && i < n; i++) re[i] = frame[i];

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
      }
    }
  }

  const numBins = n / 2 + 1;
  const powerSpectrum = new Float32Array(numBins);
  for (let i = 0; i < numBins; i++) {
    powerSpectrum[i] = re[i] * re[i] + im[i] * im[i];
  }
  return powerSpectrum;
}

function computeFbank(samples) {
  const numFrames = Math.max(
    0,
    Math.floor((samples.length - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT) + 1
  );
  if (numFrames === 0) return null;

  const povey = getPoveyWindow();
  const melBank = getMelFilterbank();
  const features = new Float32Array(numFrames * FBANK_NUM_MELS);
  const frame = new Float32Array(FBANK_FRAME_LENGTH);

  for (let f = 0; f < numFrames; f++) {
    const start = f * FBANK_FRAME_SHIFT;
    // int16-range samples (kaldi convention — CAM++ was trained on this scale)
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
      frame[i] = (samples[start + i] || 0) * 32768;
    }
    // per-frame DC removal
    let mean = 0;
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) mean += frame[i];
    mean /= FBANK_FRAME_LENGTH;
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) frame[i] -= mean;
    // pre-emphasis (backwards, kaldi-style x[0] handling)
    for (let i = FBANK_FRAME_LENGTH - 1; i > 0; i--) frame[i] -= PREEMPHASIS * frame[i - 1];
    frame[0] -= PREEMPHASIS * frame[0];
    // povey window
    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) frame[i] *= povey[i];

    const power = realFFT(frame);
    for (let m = 0; m < FBANK_NUM_MELS; m++) {
      let energy = 0;
      const filter = melBank[m];
      for (let k = 0; k < power.length; k++) {
        energy += filter[k] * power[k];
      }
      features[f * FBANK_NUM_MELS + m] = Math.log(Math.max(energy, 1.1921e-7));
    }
  }

  // per-utterance cepstral mean normalization (3D-Speaker mean_nor=True)
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    let mu = 0;
    for (let f = 0; f < numFrames; f++) mu += features[f * FBANK_NUM_MELS + m];
    mu /= numFrames;
    for (let f = 0; f < numFrames; f++) features[f * FBANK_NUM_MELS + m] -= mu;
  }

  return { features, numFrames };
}

// ---------------------------------------------------------------------------
// CAM++ embedding extraction (onnxruntime-node)
// ---------------------------------------------------------------------------

class Embedder {
  constructor() {
    this.ort = null;
    this.session = null;
    this.inputName = null;
  }

  async load(modelPath) {
    this.ort = require("onnxruntime-node");
    const threads = Math.min(4, Math.max(2, Math.floor((os.cpus()?.length || 4) / 2)));
    this.session = await this.ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: threads,
      executionMode: "sequential",
    });
    this.inputName = this.session.inputNames[0];
  }

  async extract(samples) {
    const capped =
      samples.length > MAX_EMBEDDING_SECONDS * FBANK_SAMPLE_RATE
        ? samples.subarray(samples.length - MAX_EMBEDDING_SECONDS * FBANK_SAMPLE_RATE)
        : samples;
    if (capped.length < MIN_SEGMENT_DURATION * FBANK_SAMPLE_RATE) return null;

    const fbank = computeFbank(capped);
    if (!fbank) return null;

    const feeds = {
      [this.inputName]: new this.ort.Tensor("float32", fbank.features, [
        1,
        fbank.numFrames,
        FBANK_NUM_MELS,
      ]),
    };
    const results = await this.session.run(feeds);
    const output = results[Object.keys(results)[0]];
    return new Float32Array(output.data);
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-12 ? 0 : dot / denom;
}

function normalizeEmbedding(emb) {
  let norm = 0;
  for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return emb;
  const out = new Float32Array(emb.length);
  for (let i = 0; i < emb.length; i++) out[i] = emb[i] / norm;
  return out;
}

// Spherical mean: inputs must be L2-normalized so no single high-norm
// embedding can dominate the centroid.
function averageEmbeddings(embeddings) {
  const dim = embeddings[0].length;
  const avg = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  return avg;
}

// ---------------------------------------------------------------------------
// VoiceBank — persistent SQLite store, CAM++ embedding space only.
// Same schema as the pyannote bank but a separate DB file: the two models'
// embedding spaces are incompatible and must never be mixed.
// ---------------------------------------------------------------------------

const VOICEBANK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS voice_prints (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    embedding     BLOB NOT NULL,
    meeting_count INTEGER NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

// Anonymous auto-assigned labels — carry no identity, so the attendee
// constraint never applies to them.
const GENERIC_LABEL_RE = /^guest \d+$/i;

// Fold a display name or email into a comparable key: emails drop the
// domain, dots/underscores become spaces, case is ignored — so
// "paul.timmermann@toptal.com", "Paul Timmermann" and "paul_timmermann"
// all collapse to "paul timmermann".
function normalizeSpeakerKey(value) {
  let v = String(value || "").trim().toLowerCase();
  const at = v.indexOf("@");
  if (at > 0) v = v.slice(0, at);
  return v.replace(/[._\s]+/g, " ").trim();
}

class VoiceBank {
  constructor(dbPath) {
    const Database = require("better-sqlite3");
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.exec(VOICEBANK_SCHEMA);
  }

  getAll() {
    return this.db
      .prepare("SELECT id, label, embedding, meeting_count FROM voice_prints")
      .all()
      .map((row) => ({
        id: row.id,
        label: row.label,
        embedding: new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4
        ),
        meetingCount: row.meeting_count,
      }));
  }

  // allowedKeys (Set of normalized attendee keys, or null = no constraint):
  // a NAMED voiceprint may only match when its owner is on the meeting's
  // attendee list — a saved voice must never label someone who isn't even
  // in the meeting. Anonymous "Guest N" prints stay matchable everywhere.
  findMatch(embedding, threshold, allowedKeys) {
    let best = null;
    let bestSim = -1;
    let blocked = null;
    let blockedSim = -1;
    for (const vp of this.getAll()) {
      const sim = cosineSimilarity(embedding, vp.embedding);
      if (sim <= threshold) continue;
      const isAllowed =
        !allowedKeys ||
        GENERIC_LABEL_RE.test(vp.label) ||
        allowedKeys.has(normalizeSpeakerKey(vp.label));
      if (isAllowed) {
        if (sim > bestSim) {
          bestSim = sim;
          best = vp;
        }
      } else if (sim > blockedSim) {
        blockedSim = sim;
        blocked = vp;
      }
    }
    if (best) emit("voicebank-match", { label: best.label, similarity: Number(bestSim.toFixed(3)) });
    if (blocked && blockedSim > bestSim) {
      emit("voicebank-match-blocked", {
        label: blocked.label,
        similarity: Number(blockedSim.toFixed(3)),
        reason: "not-an-attendee",
      });
    }
    return best;
  }

  upsert(vp) {
    this.db
      .prepare(
        `INSERT INTO voice_prints (id, label, embedding, meeting_count, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           embedding = excluded.embedding,
           meeting_count = excluded.meeting_count,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(vp.id, vp.label, Buffer.from(vp.embedding.buffer, vp.embedding.byteOffset, vp.embedding.byteLength), vp.meetingCount);
  }

  nextGuestNumber() {
    const rows = this.db
      .prepare("SELECT label FROM voice_prints WHERE label LIKE 'Guest %'")
      .all();
    let maxN = 0;
    for (const { label } of rows) {
      const n = parseInt(label.split(" ", 2)[1], 10);
      if (Number.isInteger(n)) maxN = Math.max(maxN, n);
    }
    return maxN + 1;
  }

  close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Diarization via the sherpa-onnx CLI
// ---------------------------------------------------------------------------

function runDiarizeCli({ binPath, segModel, embModel, wavPath, numSpeakers, clusterThreshold }) {
  const threads = Math.min(8, Math.max(2, Math.floor((os.cpus()?.length || 4) / 2)));
  const args = [
    `--segmentation.pyannote-model=${segModel}`,
    `--embedding.model=${embModel}`,
    `--segmentation.num-threads=${threads}`,
    `--embedding.num-threads=${threads}`,
    `--clustering.num-clusters=${numSpeakers || -1}`,
    `--clustering.cluster-threshold=${clusterThreshold}`,
    "--min-duration-on=0.2",
    "--min-duration-off=0.5",
    wavPath,
  ];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    emit("diarize-cli-pid", { pid: proc.pid });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Diarization CLI timed out after ${CLI_TIMEOUT_MS / 60000} minutes`));
    }, CLI_TIMEOUT_MS);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start diarization CLI: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`Diarization CLI exited with code ${code}: ${stderr.slice(-500).trim()}`)
        );
        return;
      }

      const segments = [];
      const lineRegex = /^(\d+\.?\d*)\s+--\s+(\d+\.?\d*)\s+(speaker_\d+)$/;
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(lineRegex);
        if (match) {
          segments.push({
            speaker: match[3],
            start: parseFloat(match[1]),
            end: parseFloat(match[2]),
          });
        }
      }
      resolve(segments);
    });
  });
}

// ---------------------------------------------------------------------------
// Cluster consolidation — sherpa's fast clustering over-splits speakers, so
// merge clusters whose CAM++ embeddings agree, then enforce --max-speakers
// by merging the most similar remaining pair until the cap holds.
// ---------------------------------------------------------------------------

function consolidateClusters(clusterEmbeddings, clusterWeights, maxSpeakers) {
  // clusterEmbeddings: Map rawLabel -> Float32Array (averaged)
  // clusterWeights:    Map rawLabel -> total embedded duration (seconds)
  const mapping = new Map(); // rawLabel -> canonical rawLabel
  for (const label of clusterEmbeddings.keys()) mapping.set(label, label);

  const canonical = () => [...new Set(mapping.values())];

  const resolve = (label) => {
    let cur = label;
    while (mapping.get(cur) !== cur) cur = mapping.get(cur);
    return cur;
  };

  for (;;) {
    const labels = canonical();
    if (labels.length < 2) break;

    // Best pair overall (cap enforcement fallback) and best QUALIFYING pair —
    // a pair of major clusters (both ≥60s) qualifies only at high similarity,
    // anything involving a fragment qualifies at the base threshold.
    let bestPair = null;
    let bestSim = -1;
    let bestAllowedPair = null;
    let bestAllowedSim = -1;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const sim = cosineSimilarity(
          clusterEmbeddings.get(labels[i]),
          clusterEmbeddings.get(labels[j])
        );
        if (sim > bestSim) {
          bestSim = sim;
          bestPair = [labels[i], labels[j]];
        }
        const bothMajor =
          (clusterWeights.get(labels[i]) || 0) >= MAJOR_CLUSTER_SECONDS &&
          (clusterWeights.get(labels[j]) || 0) >= MAJOR_CLUSTER_SECONDS;
        const required = bothMajor ? MAJOR_MERGE_SIMILARITY : CONSOLIDATE_SIMILARITY;
        if (sim >= required && sim > bestAllowedSim) {
          bestAllowedSim = sim;
          bestAllowedPair = [labels[i], labels[j]];
        }
      }
    }

    const overCap = maxSpeakers && labels.length > maxSpeakers;
    // Sub-3s clusters can't be labeled or enrolled meaningfully — always fold
    // the smallest one into its most similar neighbor.
    const runt = labels
      .filter((l) => (clusterWeights.get(l) || 0) < MIN_CLUSTER_SECONDS)
      .sort((a, b) => (clusterWeights.get(a) || 0) - (clusterWeights.get(b) || 0))[0];

    if (bestAllowedPair) {
      bestPair = bestAllowedPair;
      bestSim = bestAllowedSim;
    } else if (overCap) {
      // Cap must hold — merge the globally most similar pair even if it
      // wouldn't otherwise qualify (calendar attendee count is trusted).
    } else if (runt) {
      let bestTarget = null;
      let bestTargetSim = -Infinity;
      for (const l of labels) {
        if (l === runt) continue;
        const sim = cosineSimilarity(clusterEmbeddings.get(runt), clusterEmbeddings.get(l));
        if (sim > bestTargetSim) {
          bestTargetSim = sim;
          bestTarget = l;
        }
      }
      bestPair = [bestTarget, runt];
      bestSim = bestTargetSim;
    } else {
      break;
    }

    // Merge the lighter cluster into the heavier one, weighted by duration.
    let [a, b] = bestPair;
    if ((clusterWeights.get(a) || 0) < (clusterWeights.get(b) || 0)) [a, b] = [b, a];
    const wA = clusterWeights.get(a) || 1;
    const wB = clusterWeights.get(b) || 1;
    const embA = clusterEmbeddings.get(a);
    const embB = clusterEmbeddings.get(b);
    const merged = new Float32Array(embA.length);
    for (let i = 0; i < merged.length; i++) {
      merged[i] = (embA[i] * wA + embB[i] * wB) / (wA + wB);
    }
    clusterEmbeddings.set(a, merged);
    clusterWeights.set(a, wA + wB);
    clusterEmbeddings.delete(b);
    clusterWeights.delete(b);
    for (const [raw, target] of mapping) {
      if (resolve(target) === b || target === b) mapping.set(raw, a);
    }
    emit("clusters-merged", { into: a, from: b, similarity: Number(bestSim.toFixed(3)) });
  }

  const finalMapping = new Map();
  for (const raw of mapping.keys()) finalMapping.set(raw, resolve(raw));
  return finalMapping;
}

// ---------------------------------------------------------------------------
// Mic embedding from voiced windows only. The Python engine embeds the whole
// mic file — long silences pollute the embedding badly enough that is-me has
// never fired in production. Selecting the highest-energy windows keeps the
// comparison on actual speech.
// ---------------------------------------------------------------------------

function extractVoicedMicSamples(micWav) {
  const windowSec = 1.0;
  const windowSamples = Math.floor(windowSec * micWav.sampleRate);
  const numWindows = Math.floor(micWav.numSamples / windowSamples);
  if (numWindows === 0) return null;

  const windows = [];
  for (let w = 0; w < numWindows; w++) {
    const base = micWav.dataOffset + w * windowSamples * 2;
    let sumSq = 0;
    // Stride 4 samples — RMS estimate, not exact, is plenty for ranking.
    for (let i = 0; i < windowSamples; i += 4) {
      const v = micWav.buf.readInt16LE(base + i * 2);
      sumSq += v * v;
    }
    windows.push({ index: w, rms: Math.sqrt(sumSq / Math.ceil(windowSamples / 4)) });
  }

  const peak = Math.max(...windows.map((w) => w.rms));
  const floor = Math.max(300, peak * 0.25); // ~0.009 full-scale — below is noise
  const voiced = windows
    .filter((w) => w.rms >= floor)
    .sort((a, b) => b.rms - a.rms)
    .slice(0, MAX_EMBEDDING_SECONDS)
    .sort((a, b) => a.index - b.index);

  if (voiced.length < 2) return null; // under 2s of speech → unreliable voiceprint

  const out = new Float32Array(voiced.length * windowSamples);
  let offset = 0;
  for (const w of voiced) {
    const slice = sliceSamples(micWav, w.index * windowSec, (w.index + 1) * windowSec);
    out.set(slice, offset);
    offset += slice.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mic-channel "Me" intervals. With the CoreAudio tap, system audio contains
// only REMOTE voices — the user's own speech never appears in any diarized
// cluster, so cluster-vs-mic-embedding matching can't label "Me" (Tier 5
// finding). The mic recording is echo-gated (user-or-silence), so its voiced
// intervals ARE the user's turns: they join the merge as Me segments and
// compete on overlap exactly like any diarized cluster. Skipped when the mic
// was already the primary diarization source (solo recordings).
//
// Leak guard: the renderer's echo gate can miss speaker leak entirely
// (measured on a real recording: open-speaker playback reached the mic at
// 0.86-0.88 envelope correlation with system audio while the gate muted only
// 160ms — every leaked interval became a false "Me"). Since the user's voice
// is never in the tap, a mic interval whose energy envelope tracks the system
// channel is leak, not the user. Genuine double-talk correlates far lower
// (the mic is a mixture), so the 0.6 cutoff keeps it.
// ---------------------------------------------------------------------------

const LEAK_ENVELOPE_WINDOW_SEC = 0.05;
const LEAK_MAX_LAG_WINDOWS = 8; // ±400ms — covers tap-vs-mic buffering skew
// During a continuous remote monologue the envelope is nearly flat, so a
// short-window correlation is noise — the estimate needs enough context to
// include speech/pause structure. Measured on the leaked recording: ±0.5s
// context let most leaked intervals under the cutoff; per-minute windows sat
// at 0.86-0.88.
const LEAK_CONTEXT_SEC = 4;
const LEAK_CORRELATION_CUTOFF = 0.45;
// Only mic intervals that overlap system-side diarized speech can be leak at
// all (nothing was playing otherwise) — intervals in system silence are
// always the user.
const LEAK_MIN_SYSTEM_COVERAGE = 0.5;
// Second-stage identity guard. Envelope correlation misses leak when the
// playback path shifts (measured: leaked stretches at r≈0 whose mic-audio
// CAM++ embeddings matched their source system cluster at 0.79-0.84). The
// user's voice is never in the tap, so a mic chunk that sounds like ANY
// system cluster is leak, full stop. Chunked so a long interval spanning a
// remote turn change can't hide behind a blended embedding.
const LEAK_IDENTITY_CUTOFF = 0.5;
const LEAK_ID_CHUNK_SEC = 4;

function computeEnvelope(wav, startSec, endSec) {
  const win = Math.floor(LEAK_ENVELOPE_WINDOW_SEC * wav.sampleRate);
  const first = Math.max(0, Math.floor((startSec * wav.sampleRate) / win));
  const last = Math.min(
    Math.floor(wav.numSamples / win),
    Math.ceil((endSec * wav.sampleRate) / win)
  );
  const env = new Float64Array(Math.max(0, last - first));
  for (let w = first; w < last; w++) {
    const base = wav.dataOffset + w * win * 2;
    let sum = 0;
    for (let i = 0; i < win; i += 4) {
      sum += Math.abs(wav.buf.readInt16LE(base + i * 2));
    }
    env[w - first] = sum / Math.ceil(win / 4);
  }
  return env;
}

function normalizedCorrelation(a, b, lag) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, count = 0;
  const n = Math.min(a.length, b.length);
  for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) {
    const x = a[i + Math.max(0, lag)];
    const y = b[i + Math.max(0, -lag)];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; count++;
  }
  if (count < 8) return 0;
  const cov = sxy / count - (sx / count) * (sy / count);
  const varA = sxx / count - (sx / count) ** 2;
  const varB = syy / count - (sy / count) ** 2;
  if (varA < 1e-9 || varB < 1e-9) return 0;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Max envelope correlation between the system and mic channels over an
 * interval plus wide context (small lag search in both directions). High
 * correlation = the mic heard the speakers, not the user.
 */
function intervalLeakCorrelation(systemWav, micWav, interval) {
  const start = Math.max(0, interval.start - LEAK_CONTEXT_SEC);
  const end = interval.end + LEAK_CONTEXT_SEC;
  const sysEnv = computeEnvelope(systemWav, start, end);
  const micEnv = computeEnvelope(micWav, start, end);
  // System silent during the interval → nothing to leak; correlation is noise.
  let sysMean = 0;
  for (const v of sysEnv) sysMean += v;
  sysMean /= Math.max(1, sysEnv.length);
  if (sysMean < 100) return 0;
  let best = 0;
  for (let lag = -LEAK_MAX_LAG_WINDOWS; lag <= LEAK_MAX_LAG_WINDOWS; lag++) {
    const r = normalizedCorrelation(sysEnv, micEnv, lag);
    if (r > best) best = r;
  }
  return best;
}

/**
 * Concatenate mic audio from the given (leak-free) intervals for voiceprint
 * extraction, longest intervals first, capped at the CAM++ input limit.
 */
function extractSamplesFromIntervals(micWav, intervals) {
  if (!intervals || intervals.length === 0) return null;
  const maxSamples = MAX_EMBEDDING_SECONDS * micWav.sampleRate;
  const sorted = [...intervals].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const chunks = [];
  let total = 0;
  for (const interval of sorted) {
    if (total >= maxSamples) break;
    const slice = sliceSamples(micWav, interval.start, interval.end);
    const take = Math.min(slice.length, maxSamples - total);
    chunks.push(slice.subarray(0, take));
    total += take;
  }
  if (total < MIN_SEGMENT_DURATION * micWav.sampleRate) return null;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Fraction of a mic interval covered by system-side diarized speech. */
function systemSpeechCoverage(interval, systemSegments) {
  const duration = interval.end - interval.start;
  if (duration <= 0) return 0;
  let covered = 0;
  for (const seg of systemSegments) {
    const overlap = Math.min(interval.end, seg.end) - Math.max(interval.start, seg.start);
    if (overlap > 0) covered += overlap;
  }
  return Math.min(1, covered / duration);
}

function detectMicSpeechIntervals(micWav) {
  const windowSec = 0.3;
  const windowSamples = Math.floor(windowSec * micWav.sampleRate);
  const numWindows = Math.floor(micWav.numSamples / windowSamples);
  if (numWindows === 0) return [];

  const rms = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const base = micWav.dataOffset + w * windowSamples * 2;
    let sumSq = 0;
    for (let i = 0; i < windowSamples; i += 4) {
      const v = micWav.buf.readInt16LE(base + i * 2);
      sumSq += v * v;
    }
    rms[w] = Math.sqrt(sumSq / Math.ceil(windowSamples / 4));
  }

  let peak = 0;
  for (const v of rms) peak = Math.max(peak, v);
  const floor = Math.max(300, peak * 0.15);

  const MAX_GAP_SEC = 0.6;
  const MIN_INTERVAL_SEC = 0.8;
  const intervals = [];
  let current = null;
  for (let w = 0; w < numWindows; w++) {
    if (rms[w] >= floor) {
      const start = w * windowSec;
      const end = start + windowSec;
      if (current && start - current.end <= MAX_GAP_SEC) {
        current.end = end;
      } else {
        if (current && current.end - current.start >= MIN_INTERVAL_SEC) intervals.push(current);
        current = { start, end };
      }
    }
  }
  if (current && current.end - current.start >= MIN_INTERVAL_SEC) intervals.push(current);
  return intervals;
}

// ---------------------------------------------------------------------------
// Transcript merge — EXACT port of speaker_engine.py merge_transcript
// ---------------------------------------------------------------------------

function mergeTranscript(transcript, diarizedSegments) {
  const tSegments = Array.isArray(transcript.segments) ? transcript.segments : [];
  if (tSegments.length === 0) {
    emit("warning", { message: "Transcript has no segments to merge" });
    return transcript;
  }

  for (const tSeg of tSegments) {
    const tStart = typeof tSeg.start === "number" ? tSeg.start : 0;
    const tEnd = typeof tSeg.end === "number" ? tSeg.end : tStart;
    const tMid = (tStart + tEnd) / 2;

    let bestLabel = "Unknown";
    let bestOverlap = 0;

    for (const dSeg of diarizedSegments) {
      const overlap = Math.max(0, Math.min(tEnd, dSeg.end) - Math.max(tStart, dSeg.start));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestLabel = dSeg.resolvedLabel;
      }
    }

    if (bestOverlap === 0 && diarizedSegments.length > 0) {
      let closest = null;
      let closestDist = Infinity;
      for (const dSeg of diarizedSegments) {
        const dist = Math.abs((dSeg.start + dSeg.end) / 2 - tMid);
        if (dist < closestDist) {
          closestDist = dist;
          closest = dSeg;
        }
      }
      if (closest) bestLabel = closest.resolvedLabel;
    }

    tSeg.speaker = bestLabel;
  }

  return transcript;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const required = [
    "system-audio",
    "mic-audio",
    "transcript",
    "voice-db",
    "diarize-bin",
    "seg-model",
    "emb-model",
  ];
  for (const key of required) {
    if (!args[key]) throw new Error(`Missing required argument --${key}`);
  }
  for (const key of ["system-audio", "mic-audio", "transcript", "diarize-bin", "seg-model", "emb-model"]) {
    if (!fs.existsSync(args[key])) throw new Error(`File not found for --${key}: ${args[key]}`);
  }

  const numSpeakers = args["num-speakers"] ? parseInt(args["num-speakers"], 10) : null;
  const maxSpeakers = args["max-speakers"] ? parseInt(args["max-speakers"], 10) : null;
  // Defaults calibrated on archived meeting audio with the kaldi+CMN
  // frontend — same-person centroids land 0.55-0.89, different-person ≤0.17.
  const meThreshold = args.similarity ? parseFloat(args.similarity) : 0.5;
  const matchThreshold = args["voicebank-threshold"] ? parseFloat(args["voicebank-threshold"]) : 0.5;
  const clusterThreshold = args["cluster-threshold"] ? parseFloat(args["cluster-threshold"]) : 0.85;
  const readOnlyBank = Boolean(args["read-only-bank"]);
  const primaryIsMic = Boolean(args["primary-is-mic"]);

  // Meeting attendees (JSON array of names/emails). When present, named
  // voiceprints outside this list are excluded from bank matching.
  let allowedKeys = null;
  if (args["allowed-speakers"]) {
    try {
      const parsed = JSON.parse(args["allowed-speakers"]);
      if (Array.isArray(parsed)) {
        const keys = parsed.map(normalizeSpeakerKey).filter(Boolean);
        if (keys.length > 0) allowedKeys = new Set(keys);
      }
    } catch (err) {
      emit("warning", { message: `Unparseable --allowed-speakers, constraint skipped: ${err.message}` });
    }
  }

  const transcript = JSON.parse(fs.readFileSync(args.transcript, "utf8"));

  // 1. Diarize
  emit("stage", { stage: "diarize" });
  const rawSegments = await runDiarizeCli({
    binPath: args["diarize-bin"],
    segModel: args["seg-model"],
    embModel: args["emb-model"],
    wavPath: args["system-audio"],
    numSpeakers,
    clusterThreshold,
  });
  emit("diarized", {
    segments: rawSegments.length,
    rawClusters: new Set(rawSegments.map((s) => s.speaker)).size,
  });

  if (rawSegments.length === 0) {
    // Mirror speaker_engine.py: no speech → transcript untouched.
    emit("warning", { message: "No speech segments detected in system audio" });
    process.stdout.write(
      JSON.stringify({ ok: true, segments: (transcript.segments || []).length, speakers: [] }) + "\n"
    );
    return;
  }

  // 2. Per-cluster CAM++ embeddings from the primary audio
  emit("stage", { stage: "embeddings" });
  const embedder = new Embedder();
  await embedder.load(args["emb-model"]);

  const systemWav = readWav(args["system-audio"]);
  const clusterSegmentEmbeddings = new Map(); // rawLabel -> Float32Array[]
  const clusterWeights = new Map(); // rawLabel -> embedded seconds
  for (const seg of rawSegments) {
    if (seg.end - seg.start < EMBED_MIN_SEGMENT_SECONDS) continue;
    const samples = sliceSamples(systemWav, seg.start, seg.end);
    const emb = await embedder.extract(samples);
    if (!emb) continue;
    if (!clusterSegmentEmbeddings.has(seg.speaker)) {
      clusterSegmentEmbeddings.set(seg.speaker, []);
      clusterWeights.set(seg.speaker, 0);
    }
    clusterSegmentEmbeddings.get(seg.speaker).push(normalizeEmbedding(emb));
    clusterWeights.set(
      seg.speaker,
      clusterWeights.get(seg.speaker) + Math.min(seg.end - seg.start, MAX_EMBEDDING_SECONDS)
    );
  }

  const clusterEmbeddings = new Map();
  for (const [label, embs] of clusterSegmentEmbeddings) {
    clusterEmbeddings.set(label, averageEmbeddings(embs));
  }

  // 3. Consolidate over-split clusters (skip when an exact count was forced —
  //    the CLI's clustering already honored it)
  let clusterMapping = new Map();
  for (const label of clusterEmbeddings.keys()) clusterMapping.set(label, label);
  if (!numSpeakers) {
    emit("stage", { stage: "consolidate" });
    clusterMapping = consolidateClusters(clusterEmbeddings, clusterWeights, maxSpeakers);
  }
  for (const seg of rawSegments) {
    seg.canonical = clusterMapping.get(seg.speaker) || seg.speaker;
  }
  emit("consolidated", { clusters: new Set(clusterMapping.values()).size });

  // 4. Mic voiceprint for is-me
  emit("stage", { stage: "mic-embedding" });
  let micEmbedding = null;
  let meIntervals = null; // leak-guarded mic intervals; reused for Me injection
  try {
    const micWav = readWav(args["mic-audio"]);
    if (primaryIsMic) {
      // Solo recording: the mic IS the diarized audio, no leak concept — use
      // the loudest voiced windows.
      const voicedSamples = extractVoicedMicSamples(micWav);
      if (voicedSamples) micEmbedding = await embedder.extract(voicedSamples);
    } else {
      // Leak guards run BEFORE anything consumes the mic channel.
      // Stage 1 (cheap): an interval is suspect only when remote speech was
      // actually playing over it (system diarization coverage); drop it when
      // the mic envelope tracks the system channel.
      const candidates = detectMicSpeechIntervals(micWav);
      const envelopeKept = [];
      let envelopeDropped = 0;
      for (const interval of candidates) {
        const coverage = systemSpeechCoverage(interval, rawSegments);
        const r =
          coverage >= LEAK_MIN_SYSTEM_COVERAGE
            ? intervalLeakCorrelation(systemWav, micWav, interval)
            : 0;
        if (r >= LEAK_CORRELATION_CUTOFF) {
          envelopeDropped++;
        } else {
          envelopeKept.push(interval);
        }
      }
      // Stage 2 (identity): a mic chunk whose CAM++ embedding matches ANY
      // system cluster is that remote voice reaching the mic — the user is
      // never in the tap. Catches leak the envelope check misses.
      const centroids = [...new Set(clusterMapping.values())]
        .map((label) => clusterEmbeddings.get(label))
        .filter(Boolean);
      const survivors = [];
      let identityDropped = 0;
      for (const interval of envelopeKept) {
        const duration = interval.end - interval.start;
        const numChunks = Math.max(1, Math.ceil(duration / LEAK_ID_CHUNK_SEC));
        const chunkLen = duration / numChunks;
        for (let c = 0; c < numChunks; c++) {
          const chunk = {
            start: interval.start + c * chunkLen,
            end: interval.start + (c + 1) * chunkLen,
          };
          let isLeak = false;
          if (centroids.length > 0) {
            const samples = sliceSamples(micWav, chunk.start, chunk.end);
            const emb =
              samples.length >= MIN_SEGMENT_DURATION * micWav.sampleRate
                ? await embedder.extract(samples)
                : null;
            if (emb) {
              const normalized = normalizeEmbedding(emb);
              for (const centroid of centroids) {
                if (cosineSimilarity(normalized, centroid) >= LEAK_IDENTITY_CUTOFF) {
                  isLeak = true;
                  break;
                }
              }
            }
          }
          if (isLeak) {
            identityDropped++;
          } else {
            const previous = survivors[survivors.length - 1];
            if (previous && chunk.start - previous.end < 0.05) {
              previous.end = chunk.end;
            } else {
              survivors.push({ start: chunk.start, end: chunk.end });
            }
          }
        }
      }
      meIntervals = survivors;

      // Voiceprint from leak-free intervals ONLY. A whole-file extraction is
      // poisoned by exactly the leak just filtered — measured: a leaked
      // remote monologue cluster matched the poisoned voiceprint at 0.52 and
      // the whole cluster became "Me". Two safety gates on the residue:
      //  - too little clean audio (<5s) can't identify anyone — a 1s leak
      //    fragment once built a voiceprint that flipped a whole remote
      //    cluster to "Me"
      //  - a voiceprint that itself sounds like a system cluster means the
      //    "clean" residue is still leak → the mic channel is untrusted
      //    entirely (no cluster is-me, no Me injection)
      const cleanSec = meIntervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
      if (cleanSec >= 5) {
        const voicedSamples = extractSamplesFromIntervals(micWav, meIntervals);
        if (voicedSamples) micEmbedding = await embedder.extract(voicedSamples);
        if (micEmbedding && centroids.length > 0) {
          const normalized = normalizeEmbedding(micEmbedding);
          for (const centroid of centroids) {
            if (cosineSimilarity(normalized, centroid) >= LEAK_IDENTITY_CUTOFF) {
              emit("warning", {
                message:
                  "Leak-filtered mic audio still sounds like a meeting speaker — mic channel untrusted, Me detection disabled; check speaker/headphone setup",
              });
              micEmbedding = null;
              meIntervals = [];
              break;
            }
          }
        }
      } else if (candidates.length > 0) {
        emit("warning", {
          message: `Only ${cleanSec.toFixed(1)}s of leak-free mic audio (${candidates.length} voiced intervals detected) — Me detection disabled for this recording`,
        });
        meIntervals = [];
      }
      emit("mic-me-intervals", {
        count: meIntervals.length,
        cleanSec: Math.round(cleanSec),
        envelopeDropped,
        identityDropped,
        candidates: candidates.length,
      });
    }
  } catch (err) {
    emit("warning", { message: `Mic embedding failed: ${err.message}` });
  }
  if (!micEmbedding) {
    emit("warning", { message: "No usable mic voiceprint — is-me detection disabled" });
  }

  // 5. Resolve labels: Me → voicebank match → new Guest N
  emit("stage", { stage: "identify" });
  const voiceBank = new VoiceBank(args["voice-db"]);
  const labelMap = new Map(); // canonical cluster -> resolved label
  const speakerMeta = new Map(); // resolved label -> meta
  let nextGuest = voiceBank.nextGuestNumber();

  try {
    for (const canonicalLabel of new Set(clusterMapping.values())) {
      const avgEmb = clusterEmbeddings.get(canonicalLabel);
      if (!avgEmb) continue;

      const micSim = micEmbedding ? cosineSimilarity(avgEmb, micEmbedding) : -1;
      emit("cluster-mic-similarity", {
        cluster: canonicalLabel,
        similarity: Number(micSim.toFixed(4)),
      });

      if (micEmbedding && micSim >= meThreshold) {
        labelMap.set(canonicalLabel, ME_LABEL);
        if (!speakerMeta.has(ME_LABEL)) {
          speakerMeta.set(ME_LABEL, {
            label: ME_LABEL,
            voiceprint_id: null,
            is_new: false,
            is_me: true,
          });
        }
        continue;
      }

      const match = voiceBank.findMatch(avgEmb, matchThreshold, allowedKeys);
      if (match) {
        if (!readOnlyBank) {
          match.meetingCount += 1;
          const alpha = 1 / match.meetingCount;
          const updated = new Float32Array(match.embedding.length);
          for (let i = 0; i < updated.length; i++) {
            updated[i] = (1 - alpha) * match.embedding[i] + alpha * avgEmb[i];
          }
          match.embedding = updated;
          voiceBank.upsert(match);
        }
        labelMap.set(canonicalLabel, match.label);
        if (!speakerMeta.has(match.label)) {
          speakerMeta.set(match.label, {
            label: match.label,
            voiceprint_id: match.id,
            is_new: false,
            is_me: false,
          });
        }
      } else {
        const guestLabel = `Guest ${nextGuest}`;
        nextGuest += 1;
        let voiceprintId = null;
        if (!readOnlyBank) {
          voiceprintId = crypto.randomUUID();
          voiceBank.upsert({
            id: voiceprintId,
            label: guestLabel,
            embedding: avgEmb,
            meetingCount: 1,
          });
        }
        labelMap.set(canonicalLabel, guestLabel);
        speakerMeta.set(guestLabel, {
          label: guestLabel,
          voiceprint_id: voiceprintId,
          is_new: true,
          is_me: false,
        });
      }
    }
  } finally {
    voiceBank.close();
  }

  // Clusters that never produced a labelable embedding (all segments <1s)
  // stay out of the merge — a whisper segment near them falls back to the
  // nearest labeled speaker instead of surfacing as "Unknown (speaker_XX)".
  const diarizedSegments = rawSegments
    .filter((seg) => labelMap.has(seg.canonical))
    .map((seg) => ({
      start: seg.start,
      end: seg.end,
      resolvedLabel: labelMap.get(seg.canonical),
    }));

  // Inject the user's own turns from the mic channel — the leak-guarded
  // intervals computed at the mic-embedding stage. Skipped for solo
  // recordings (primaryIsMic), where the embedding-based is-me above covers
  // it.
  if (!primaryIsMic && meIntervals && meIntervals.length > 0) {
    for (const interval of meIntervals) {
      diarizedSegments.push({
        start: interval.start,
        end: interval.end,
        resolvedLabel: ME_LABEL,
      });
    }
    if (!speakerMeta.has(ME_LABEL)) {
      speakerMeta.set(ME_LABEL, {
        label: ME_LABEL,
        voiceprint_id: null,
        is_new: false,
        is_me: true,
      });
    }
  }

  // 6. Merge onto the transcript and persist (segments + speakers metadata)
  emit("stage", { stage: "merge" });
  const merged = mergeTranscript(transcript, diarizedSegments);
  merged.speakers = [...speakerMeta.values()];
  fs.writeFileSync(args.transcript, JSON.stringify(merged, null, 2), "utf8");

  const speakerCounts = {};
  for (const seg of diarizedSegments) {
    speakerCounts[seg.resolvedLabel] = (speakerCounts[seg.resolvedLabel] || 0) + 1;
  }
  emit("speaker-breakdown", { counts: speakerCounts });

  process.stdout.write(
    JSON.stringify({
      ok: true,
      segments: (merged.segments || []).length,
      speakers: merged.speakers,
    }) + "\n"
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      emit("error", { message: err.message, stack: err.stack });
      process.stderr.write(`sherpa diarization engine failed: ${err.message}\n`);
      process.exit(1);
    });
}

// Exported for the standalone eval harness (scripts/, tests) — the app only
// ever runs this file as a forked worker.
module.exports = {
  readWav,
  sliceSamples,
  computeFbank,
  Embedder,
  VoiceBank,
  cosineSimilarity,
  normalizeEmbedding,
  averageEmbeddings,
  consolidateClusters,
  extractVoicedMicSamples,
  detectMicSpeechIntervals,
  intervalLeakCorrelation,
  mergeTranscript,
  runDiarizeCli,
};
