// Per-channel utterance segmentation for the live meeting coach. One tap per
// channel (mic = ME, system audio = THEM): a lightweight energy VAD cuts
// speech into utterances at pauses, each gets transcribed (Parakeet) and
// emitted with simple delivery stats. The mic tap also tracks pitch so the
// coach can spot statements that rise at the end.
import type { CoachProsody, CoachUtterance } from "../types/coach";

export const COACH_SAMPLE_RATE = 16000;
const FRAME = 512; // 32 ms
const FRAME_MS = (FRAME / COACH_SAMPLE_RATE) * 1000;
const PREROLL_FRAMES = 10; // ~320 ms kept before speech onset
const ONSET_FRAMES = 3; // ~96 ms of voicing starts an utterance
const END_SILENCE_MS = 650;
const MAX_UTTERANCE_MS = 15000;
const MIN_VOICED_MS = 400;
const MIN_THRESHOLD = 0.008;
const NOISE_MULTIPLIER = 3.5;
const PITCH_MIN_LAG = Math.floor(COACH_SAMPLE_RATE / 400); // 400 Hz
const PITCH_MAX_LAG = Math.ceil(COACH_SAMPLE_RATE / 70); // 70 Hz
const PITCH_MIN_CORR = 0.45;
const END_RISE_FRAMES = 12; // last ~400 ms of voiced speech
const MAX_PENDING_TRANSCRIPTIONS = 4;

function detectPitch(frame: Float32Array): number | null {
  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
  if (energy < 1e-4) return null;
  let bestCorr = 0;
  let bestLag = -1;
  for (let lag = PITCH_MIN_LAG; lag <= PITCH_MAX_LAG; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < frame.length; i++) sum += frame[i] * frame[i + lag];
    const corr = sum / energy;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return bestCorr >= PITCH_MIN_CORR && bestLag > 0 ? COACH_SAMPLE_RATE / bestLag : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function encodeWav(frames: Int16Array[]): ArrayBuffer {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, COACH_SAMPLE_RATE, true);
  view.setUint32(28, COACH_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, total * 2, true);
  let off = 44;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) {
      view.setInt16(off, f[i], true);
      off += 2;
    }
  }
  return buffer;
}

interface UtteranceBuild {
  frames: Int16Array[];
  startFrame: number;
  voicedFrames: number;
  dbValues: number[];
  pitches: number[];
  pitchFrames: number[];
  lastVoicedFrame: number;
  silenceRun: number;
  longestPauseFrames: number;
}

export interface CoachChannelTapOptions {
  speaker: "me" | "them";
  /** Recording-timeline offset (ms) of this tap's first sample */
  offsetMs: number;
  trackPitch: boolean;
  transcribe: (wav: ArrayBuffer) => Promise<string | null>;
  onUtterance: (utterance: CoachUtterance) => void;
  isActive: () => boolean;
  onError?: (error: Error) => void;
}

export class CoachChannelTap {
  private opts: CoachChannelTapOptions;
  private frameBuf = new Int16Array(FRAME);
  private frameFloat = new Float32Array(FRAME);
  private frameFill = 0;
  private frameIndex = 0;
  private noiseFloor = 0.003;
  private onsetRun = 0;
  private preroll: Int16Array[] = [];
  private current: UtteranceBuild | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private dropped = 0;

  constructor(opts: CoachChannelTapOptions) {
    this.opts = opts;
  }

  push(chunk: ArrayBuffer) {
    const samples = new Int16Array(chunk);
    for (let i = 0; i < samples.length; i++) {
      this.frameBuf[this.frameFill++] = samples[i];
      if (this.frameFill === FRAME) {
        this.processFrame();
        this.frameFill = 0;
      }
    }
  }

  /** Emit whatever is mid-utterance (recording stop). */
  flush() {
    if (this.current) this.finalize();
  }

  getStats() {
    return { frames: this.frameIndex, dropped: this.dropped };
  }

  private processFrame() {
    const idx = this.frameIndex++;
    const frame = this.frameBuf.slice();
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = frame[i] / 32768;
      this.frameFloat[i] = v;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / FRAME);
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * NOISE_MULTIPLIER);
    const voiced = rms > threshold;

    if (!this.current) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (voiced) {
        this.onsetRun += 1;
        if (this.onsetRun >= ONSET_FRAMES) {
          // The preroll ends with this frame, so the clip starts at its head
          const frames = this.preroll;
          this.preroll = [];
          this.begin(idx - frames.length + 1, frames);
        }
      } else {
        this.onsetRun = 0;
        // Track the noise floor only while nobody is speaking
        this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03;
      }
      return;
    }

    const u = this.current;
    u.frames.push(frame);
    if (voiced) {
      u.voicedFrames += 1;
      u.lastVoicedFrame = idx;
      u.dbValues.push(20 * Math.log10(Math.max(rms, 1e-6)));
      if (this.opts.trackPitch) {
        const pitch = detectPitch(this.frameFloat);
        if (pitch) {
          u.pitches.push(pitch);
          u.pitchFrames.push(idx);
        }
      }
      if (u.silenceRun > u.longestPauseFrames) u.longestPauseFrames = u.silenceRun;
      u.silenceRun = 0;
    } else {
      u.silenceRun += 1;
    }

    const durationMs = (idx - u.startFrame) * FRAME_MS;
    if (u.silenceRun * FRAME_MS >= END_SILENCE_MS) {
      this.finalize();
    } else if (durationMs >= MAX_UTTERANCE_MS) {
      // Long monologue: emit and keep listening, the next clip starting
      // at the following frame
      this.finalize();
      this.begin(idx + 1, []);
    }
  }

  private begin(startFrame: number, frames: Int16Array[]) {
    this.onsetRun = 0;
    this.current = {
      frames,
      startFrame,
      voicedFrames: 0,
      dbValues: [],
      pitches: [],
      pitchFrames: [],
      lastVoicedFrame: startFrame + frames.length - 1,
      silenceRun: 0,
      longestPauseFrames: 0,
    };
  }

  private finalize() {
    const u = this.current;
    this.current = null;
    if (!u) return;
    const voicedMs = u.voicedFrames * FRAME_MS;
    if (voicedMs < MIN_VOICED_MS) return;

    // Trim trailing silence beyond ~200 ms so the clip ends at the speech
    const keepTail = Math.ceil(200 / FRAME_MS);
    const trailing = Math.max(0, u.silenceRun - keepTail);
    const frames = trailing ? u.frames.slice(0, u.frames.length - trailing) : u.frames;

    const startMs = this.opts.offsetMs + u.startFrame * FRAME_MS;
    const endMs = this.opts.offsetMs + (u.lastVoicedFrame + 1) * FRAME_MS;

    let endRiseSemitones: number | null = null;
    const pitchMedian = median(u.pitches);
    if (pitchMedian && u.pitches.length >= 8) {
      const tailFrom = u.lastVoicedFrame - END_RISE_FRAMES;
      const tail = u.pitches.filter((_, i) => u.pitchFrames[i] >= tailFrom);
      const tailMedian = median(tail);
      if (tailMedian && tail.length >= 3) {
        endRiseSemitones = 12 * Math.log2(tailMedian / pitchMedian);
      }
    }
    const meanDb = u.dbValues.length
      ? u.dbValues.reduce((a, b) => a + b, 0) / u.dbValues.length
      : null;

    const prosody: CoachProsody = {
      voicedMs: Math.round(voicedMs),
      meanDb: meanDb != null ? Math.round(meanDb * 10) / 10 : null,
      pitchMedianHz: pitchMedian ? Math.round(pitchMedian) : null,
      endRiseSemitones: endRiseSemitones != null ? Math.round(endRiseSemitones * 10) / 10 : null,
      longestPauseMs: Math.round(u.longestPauseFrames * FRAME_MS),
    };

    // Transcriptions are serialized per channel; if the engine falls behind,
    // drop new clips rather than build an ever-growing, ever-staler backlog.
    if (this.pending >= MAX_PENDING_TRANSCRIPTIONS) {
      this.dropped += 1;
      return;
    }
    const wav = encodeWav(frames);
    this.pending += 1;
    this.queue = this.queue.then(async () => {
      try {
        if (!this.opts.isActive()) return;
        const text = (await this.opts.transcribe(wav))?.trim();
        if (text && this.opts.isActive()) {
          this.opts.onUtterance({
            speaker: this.opts.speaker,
            text,
            startMs: Math.round(startMs),
            endMs: Math.round(endMs),
            prosody,
          });
        }
      } catch (err) {
        this.opts.onError?.(err as Error);
      } finally {
        this.pending -= 1;
      }
    });
  }
}
