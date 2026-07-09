/**
 * Acoustic echo-leak gate for meeting recordings.
 *
 * When the user records a meeting without headphones, the other
 * participants' voices come out of the speakers and back in through the
 * microphone. The mic split recording is diarization's identity channel
 * (its whole-file embedding decides "who is Me"), so that leak pollutes
 * speaker attribution: the embedding becomes a blend of everyone and
 * matches no one, and on mic-primary (solo/silent-system) recordings the
 * echo spawns phantom guest clusters.
 *
 * Port of upstream OpenWhispr's MeetingEchoLeakDetector (1.6.8, thresholds
 * as of 1.7.0) reduced to the acoustic core: each mic frame is explained as
 * a scaled, delayed copy of recently captured system audio via a lag-swept
 * normalized cross-correlation and a least-squares residual. Frames that
 * are almost entirely explained by the system signal are render bleed and
 * get muted; frames where a meaningful residual (the user's own voice)
 * survives on top of the system signal are double-talk and are never muted
 * — nor is anything else for a short window after them, so speech onsets
 * that begin under far-end audio aren't clipped.
 *
 * The detector must always analyze the RAW mic signal, never a gated or
 * echo-cancelled one — cancelling the correlation it looks for blinds it.
 */

type GateState = "clean_local" | "suspected_render_bleed" | "double_talk";

const ANALYSIS_FRAME_MS = 40;
const MAX_SYSTEM_HISTORY_MS = 6000;
const MAX_LAG_MS = 500;
const LAG_STEP_SAMPLES = 120;
const LAG_FINE_STEP_SAMPLES = 12;
const MIC_HISTORY_MS = 1000;
const CHUNK_MUTE_WINDOW_MS = 260;

const MIN_RMS = 0.006;
const MIN_SYSTEM_RMS = 0.004;

// suspected_render_bleed classification
const BLEED_CORRELATION = 0.6;
const BLEED_RESIDUAL = 0.45;
const BLEED_EXPLAINED = 0.5;
const BLEED_MIC_TO_SYSTEM_RATIO = 1.3;

// double_talk classification (own voice on top of system audio)
const DOUBLE_TALK_CORRELATION = 0.45;
const DOUBLE_TALK_EXPLAINED = 0.3;
const DOUBLE_TALK_RESIDUAL = 0.2;
const DOUBLE_TALK_MIC_TO_SYSTEM_RATIO = 1.16;

// Muting requires much stronger evidence than classification
const STRONG_BLEED_CORRELATION = 0.75;
const STRONG_BLEED_RESIDUAL = 0.32;
const STRONG_BLEED_EXPLAINED = 0.65;
const STRONG_BLEED_MIC_TO_SYSTEM_RATIO = 1.25;

interface FrameAnalysis {
  rms: number;
  correlation: number;
  residualRatio: number;
  explainedRatio: number;
  systemRms: number;
  micToSystemRatio: number | null;
  state: GateState;
}

interface MicHistoryEntry {
  at: number;
  state: GateState;
  rms: number;
}

export interface EchoGateSummary {
  totalFrames: number;
  mutedFrames: number;
  bleedFrames: number;
  doubleTalkFrames: number;
  mutedMs: number;
}

export class EchoLeakGate {
  private readonly frameSize: number;
  private readonly maxLagSamples: number;

  private readonly systemBuffer: Float32Array;
  private systemLength = 0;

  private pendingMic: Float32Array;
  private pendingMicLength = 0;

  private micHistory: MicHistoryEntry[] = [];
  private muted = false;

  private totalFrames = 0;
  private mutedFrames = 0;
  private bleedFrames = 0;
  private doubleTalkFrames = 0;

  constructor(private readonly sampleRate: number) {
    this.frameSize = Math.round((sampleRate * ANALYSIS_FRAME_MS) / 1000);
    this.maxLagSamples = Math.round((sampleRate * MAX_LAG_MS) / 1000);
    this.systemBuffer = new Float32Array(
      Math.round((sampleRate * MAX_SYSTEM_HISTORY_MS) / 1000)
    );
    this.pendingMic = new Float32Array(this.frameSize * 4);
  }

  recordSystemChunk(samples: Float32Array): void {
    const capacity = this.systemBuffer.length;
    if (samples.length >= capacity) {
      this.systemBuffer.set(samples.subarray(samples.length - capacity));
      this.systemLength = capacity;
      return;
    }
    const overflow = this.systemLength + samples.length - capacity;
    if (overflow > 0) {
      this.systemBuffer.copyWithin(0, overflow, this.systemLength);
      this.systemLength -= overflow;
    }
    this.systemBuffer.set(samples, this.systemLength);
    this.systemLength += samples.length;
  }

  /**
   * Feed raw (pre-gate) mic samples. Returns whether the mic should
   * currently be muted, reflecting the most recent completed analysis frame.
   */
  processMicChunk(samples: Float32Array): boolean {
    // Grow the pending buffer if a large chunk arrives
    if (this.pendingMicLength + samples.length > this.pendingMic.length) {
      const grown = new Float32Array(
        Math.max(this.pendingMic.length * 2, this.pendingMicLength + samples.length)
      );
      grown.set(this.pendingMic.subarray(0, this.pendingMicLength));
      this.pendingMic = grown;
    }
    this.pendingMic.set(samples, this.pendingMicLength);
    this.pendingMicLength += samples.length;

    let offset = 0;
    while (this.pendingMicLength - offset >= this.frameSize) {
      const frame = this.pendingMic.subarray(offset, offset + this.frameSize);
      this.analyzeFrame(frame);
      offset += this.frameSize;
    }
    if (offset > 0) {
      this.pendingMic.copyWithin(0, offset, this.pendingMicLength);
      this.pendingMicLength -= offset;
    }
    return this.muted;
  }

  getSummary(): EchoGateSummary {
    return {
      totalFrames: this.totalFrames,
      mutedFrames: this.mutedFrames,
      bleedFrames: this.bleedFrames,
      doubleTalkFrames: this.doubleTalkFrames,
      mutedMs: Math.round(this.mutedFrames * ANALYSIS_FRAME_MS),
    };
  }

  private analyzeFrame(frame: Float32Array): void {
    this.totalFrames += 1;
    const now = Date.now();

    let energyMic = 0;
    for (let i = 0; i < frame.length; i += 1) {
      energyMic += frame[i] * frame[i];
    }
    const rms = Math.sqrt(energyMic / frame.length);

    const analysis: FrameAnalysis = {
      rms,
      correlation: 0,
      residualRatio: 1,
      explainedRatio: 0,
      systemRms: 0,
      micToSystemRatio: null,
      state: "clean_local",
    };

    if (rms >= MIN_RMS && energyMic > 0) {
      // Sweep the mic frame against the recent system-audio window at
      // increasing lags to absorb loopback/graph latency: a coarse pass to
      // locate the correlation peak, then a fine pass around it (the peak
      // can sit between coarse grid points). Keep the best alignment's
      // least-squares fit.
      let bestLag = -1;
      for (let lag = 0; lag <= this.maxLagSamples; lag += LAG_STEP_SAMPLES) {
        if (this.evaluateLag(frame, energyMic, lag, analysis)) bestLag = lag;
        if (this.systemLength - frame.length - lag < 0) break;
      }
      if (bestLag >= 0) {
        const from = Math.max(0, bestLag - LAG_STEP_SAMPLES + LAG_FINE_STEP_SAMPLES);
        const to = bestLag + LAG_STEP_SAMPLES - LAG_FINE_STEP_SAMPLES;
        for (let lag = from; lag <= to; lag += LAG_FINE_STEP_SAMPLES) {
          if (lag !== bestLag) this.evaluateLag(frame, energyMic, lag, analysis);
        }
      }
      analysis.micToSystemRatio =
        analysis.systemRms > 0 ? rms / analysis.systemRms : null;
      analysis.state = this.resolveState(analysis);
    }

    if (analysis.state === "suspected_render_bleed") this.bleedFrames += 1;
    if (analysis.state === "double_talk") this.doubleTalkFrames += 1;

    this.micHistory.push({ at: now, state: analysis.state, rms });
    const cutoff = now - MIC_HISTORY_MS;
    while (this.micHistory.length && this.micHistory[0].at < cutoff) {
      this.micHistory.shift();
    }

    this.muted = this.shouldMute(analysis, now);
    if (this.muted) this.mutedFrames += 1;
  }

  /**
   * Correlate the mic frame against the system window at one lag; if it
   * beats the analysis's current best correlation, record its least-squares
   * fit (how much of the mic the system signal explains) and return true.
   */
  private evaluateLag(
    frame: Float32Array,
    energyMic: number,
    lag: number,
    analysis: FrameAnalysis
  ): boolean {
    const start = this.systemLength - frame.length - lag;
    if (start < 0) return false;

    const candidate = this.systemBuffer.subarray(start, start + frame.length);
    let energySystem = 0;
    let dot = 0;
    for (let i = 0; i < frame.length; i += 1) {
      energySystem += candidate[i] * candidate[i];
      dot += frame[i] * candidate[i];
    }
    if (energySystem <= 0) return false;

    const corr = dot / Math.sqrt(energyMic * energySystem);
    if (corr <= analysis.correlation) return false;

    const alpha = dot / energySystem;
    let residualEnergy = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const residual = frame[i] - alpha * candidate[i];
      residualEnergy += residual * residual;
    }

    analysis.correlation = corr;
    analysis.residualRatio = residualEnergy / energyMic;
    analysis.explainedRatio = Math.max(0, Math.min(1, 1 - residualEnergy / energyMic));
    analysis.systemRms = Math.sqrt(energySystem / candidate.length);
    return true;
  }

  private resolveState(analysis: FrameAnalysis): GateState {
    const { correlation, residualRatio, explainedRatio, rms, systemRms, micToSystemRatio } =
      analysis;

    // Mic quiet, or no system reference playing → nothing to gate
    if (rms < MIN_RMS || systemRms < MIN_SYSTEM_RMS) {
      return "clean_local";
    }

    if (
      correlation >= BLEED_CORRELATION &&
      residualRatio <= BLEED_RESIDUAL &&
      explainedRatio >= BLEED_EXPLAINED &&
      (micToSystemRatio == null || micToSystemRatio <= BLEED_MIC_TO_SYSTEM_RATIO)
    ) {
      return "suspected_render_bleed";
    }

    if (
      correlation >= DOUBLE_TALK_CORRELATION &&
      explainedRatio >= DOUBLE_TALK_EXPLAINED &&
      (residualRatio >= DOUBLE_TALK_RESIDUAL ||
        (micToSystemRatio != null && micToSystemRatio >= DOUBLE_TALK_MIC_TO_SYSTEM_RATIO))
    ) {
      return "double_talk";
    }

    return "clean_local";
  }

  private shouldMute(analysis: FrameAnalysis, now: number): boolean {
    if (analysis.state !== "suspected_render_bleed") return false;

    // Speech-onset protection: any recent audible double-talk vetoes muting,
    // so the user's voice starting under far-end audio is never clipped.
    const windowStart = now - CHUNK_MUTE_WINDOW_MS;
    for (const entry of this.micHistory) {
      if (entry.at >= windowStart && entry.rms >= MIN_RMS && entry.state === "double_talk") {
        return false;
      }
    }

    return (
      analysis.correlation >= STRONG_BLEED_CORRELATION &&
      analysis.residualRatio <= STRONG_BLEED_RESIDUAL &&
      analysis.explainedRatio >= STRONG_BLEED_EXPLAINED &&
      (analysis.micToSystemRatio == null ||
        analysis.micToSystemRatio <= STRONG_BLEED_MIC_TO_SYSTEM_RATIO)
    );
  }
}

/** Convert a PCM16 ArrayBuffer (from the meeting worklet tap) to Float32. */
export function pcm16ToFloat32(chunk: ArrayBuffer): Float32Array {
  const samples = new Int16Array(chunk);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = samples[i] / 32768;
  }
  return out;
}
