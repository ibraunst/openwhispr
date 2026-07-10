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

  findMatch(embedding, threshold) {
    let best = null;
    let bestSim = -1;
    for (const vp of this.getAll()) {
      const sim = cosineSimilarity(embedding, vp.embedding);
      if (sim > threshold && sim > bestSim) {
        bestSim = sim;
        best = vp;
      }
    }
    if (best) emit("voicebank-match", { label: best.label, similarity: Number(bestSim.toFixed(3)) });
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

    let bestPair = null;
    let bestSim = -1;
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
      }
    }

    const overCap = maxSpeakers && labels.length > maxSpeakers;
    // Sub-3s clusters can't be labeled or enrolled meaningfully — always fold
    // the smallest one into its most similar neighbor.
    const runt = labels
      .filter((l) => (clusterWeights.get(l) || 0) < MIN_CLUSTER_SECONDS)
      .sort((a, b) => (clusterWeights.get(a) || 0) - (clusterWeights.get(b) || 0))[0];
    if (bestSim < CONSOLIDATE_SIMILARITY && !overCap) {
      if (!runt) break;
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
// ---------------------------------------------------------------------------

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
  try {
    const micWav = readWav(args["mic-audio"]);
    const voicedSamples = extractVoicedMicSamples(micWav);
    if (voicedSamples) micEmbedding = await embedder.extract(voicedSamples);
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

      const match = voiceBank.findMatch(avgEmb, matchThreshold);
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

  const diarizedSegments = rawSegments.map((seg) => ({
    start: seg.start,
    end: seg.end,
    resolvedLabel: labelMap.get(seg.canonical) || `Unknown (${seg.speaker})`,
  }));

  // Inject the user's own turns from the mic channel (see
  // detectMicSpeechIntervals) — unless the mic was already diarized as the
  // primary audio, where the embedding-based is-me above covers it.
  if (!primaryIsMic) {
    try {
      const micWavForIntervals = readWav(args["mic-audio"]);
      const meIntervals = detectMicSpeechIntervals(micWavForIntervals);
      emit("mic-me-intervals", { count: meIntervals.length });
      if (meIntervals.length > 0) {
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
    } catch (err) {
      emit("warning", { message: `Mic Me-interval detection failed: ${err.message}` });
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
  mergeTranscript,
  runDiarizeCli,
};
