import logger from "./logger";

const TAP_SAMPLE_RATE = 24000;
// Bound the worklet's jitter buffer so a stalled AudioContext can't grow
// latency without limit; overflow drops the oldest audio (audible skip,
// but keeps system audio time-aligned with the live mic for diarization).
const MAX_BUFFERED_SECONDS = 2;

// AudioWorklet that plays queued PCM chunks (already converted to Float32)
// and emits silence when the queue runs dry. Runs inside the tap
// AudioContext; fed via port messages from the IPC chunk listener.
const TAP_PLAYER_WORKLET = `
class TapPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.port.onmessage = (event) => {
      const int16 = new Int16Array(event.data);
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
      this.queue.push(f32);
      this.queuedSamples += f32.length;
      const maxSamples = sampleRate * ${MAX_BUFFERED_SECONDS};
      while (this.queuedSamples > maxSamples && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.queuedSamples -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let written = 0;
    while (written < out.length && this.queue.length) {
      const head = this.queue[0];
      const available = head.length - this.offset;
      const n = Math.min(out.length - written, available);
      out.set(head.subarray(this.offset, this.offset + n), written);
      written += n;
      this.offset += n;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    this.queuedSamples -= written;
    return true;
  }
}
registerProcessor("tap-pcm-player", TapPcmPlayer);
`;

interface ActiveTap {
  stream: MediaStream;
  context: AudioContext;
  unsubChunk: () => void;
  unsubError: () => void;
  stopped: boolean;
}

let activeTap: ActiveTap | null = null;

async function teardownTap(tap: ActiveTap): Promise<void> {
  if (tap.stopped) return;
  tap.stopped = true;
  if (activeTap === tap) activeTap = null;
  try {
    tap.unsubChunk();
  } catch {}
  try {
    tap.unsubError();
  } catch {}
  try {
    await window.electronAPI?.meetingTapStop?.();
  } catch (err) {
    logger.warn("meetingTapStop failed", { error: (err as Error).message }, "audio");
  }
  try {
    await tap.context.close();
  } catch {}
}

/**
 * Native CoreAudio tap path: the main process spawns macos-audio-tap and
 * forwards s16le mono PCM chunks over IPC; here they're wrapped into a real
 * MediaStream so the whole downstream graph (mix recorder, split recorders,
 * echo gate, live-transcript tap) works unchanged.
 */
async function getNativeTapStream(): Promise<MediaStream | null> {
  const api = window.electronAPI;
  if (!api?.meetingTapStart || !api.checkSystemAudioAccess) return null;

  const access = await api.checkSystemAudioAccess().catch(() => null);
  if (!access?.supported) return null;

  if (!access.granted) {
    if (access.status === "denied") {
      // Persisted denial: a probe won't re-show the consent dialog, the user
      // has to flip the toggle in System Settings. Fall back to loopback.
      logger.warn("System audio tap permission denied; falling back to loopback", {}, "audio");
      return null;
    }
    // First use: the probe run triggers the macOS consent dialog and waits
    // for the user's answer (up to 60s in the main process).
    const request = await api.requestSystemAudioAccess?.().catch(() => null);
    if (!request?.granted) {
      logger.warn(
        "System audio tap access not granted",
        { status: request?.status, error: request?.error },
        "audio"
      );
      return null;
    }
  }

  if (activeTap) {
    logger.warn("Native tap already active; tearing down stale instance", {}, "audio");
    await teardownTap(activeTap);
  }

  let context: AudioContext | null = null;
  let unsubChunk: (() => void) | null = null;
  let unsubError: (() => void) | null = null;
  try {
    context = new AudioContext({ sampleRate: TAP_SAMPLE_RATE });
    // Keep the context off the physical output device (Bluetooth HFP routing
    // changes can stall contexts attached to the default output).
    const ctxWithSink = context as AudioContext & {
      setSinkId?: (sink: { type: string }) => Promise<void>;
    };
    if (typeof ctxWithSink.setSinkId === "function") {
      await ctxWithSink.setSinkId({ type: "none" }).catch(() => {});
    }
    await context.resume().catch(() => {});

    const workletUrl = URL.createObjectURL(
      new Blob([TAP_PLAYER_WORKLET], { type: "application/javascript" })
    );
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const player = new AudioWorkletNode(context, "tap-pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const destination = context.createMediaStreamDestination();
    player.connect(destination);

    unsubChunk =
      api.onMeetingTapChunk?.((chunk) => {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (u8.byteLength < 2) return;
        // Copy into an aligned, transferable ArrayBuffer for the worklet.
        const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength - (u8.byteLength % 2));
        player.port.postMessage(buf, [buf]);
      }) ?? null;
    unsubError =
      api.onMeetingTapError?.((message) => {
        // Keep recording: the mixed recorder just receives silence from this
        // leg, matching the old loopback behavior when system audio went
        // quiet. Diarization's RMS fallback handles a silent system track.
        logger.error("System audio tap runtime error", { message }, "audio");
      }) ?? null;

    const started = await api.meetingTapStart();
    if (!started?.success) {
      throw new Error(started?.error || "meeting-tap-start failed");
    }

    const tap: ActiveTap = {
      stream: destination.stream,
      context,
      unsubChunk: unsubChunk ?? (() => {}),
      unsubError: unsubError ?? (() => {}),
      stopped: false,
    };
    activeTap = tap;

    // All existing teardown paths stop tracks directly rather than calling
    // stopSystemAudioStream, so ride the track's own stop().
    for (const track of destination.stream.getTracks()) {
      const originalStop = track.stop.bind(track);
      track.stop = () => {
        originalStop();
        void teardownTap(tap);
      };
    }

    logger.debug(
      "Native system audio tap stream started",
      { sampleRate: started.sampleRate ?? TAP_SAMPLE_RATE },
      "audio"
    );
    return destination.stream;
  } catch (err) {
    logger.error(
      "Native system audio tap failed; falling back to loopback",
      { error: (err as Error).message },
      "audio"
    );
    try {
      unsubChunk?.();
      unsubError?.();
    } catch {}
    try {
      await window.electronAPI?.meetingTapStop?.();
    } catch {}
    try {
      await context?.close();
    } catch {}
    return null;
  }
}

/**
 * Legacy loopback path: getDisplayMedia (CoreAudio-tap-backed loopback on
 * Electron 39+/macOS). Kept as the fallback when the native tap is
 * unsupported, unavailable, or fails to start.
 */
async function getLoopbackStream(): Promise<MediaStream | null> {
  try {
    // Disable all audio processing — echo cancellation and noise suppression
    // on loopback audio can cancel out the captured system audio entirely,
    // especially when Bluetooth headphones change the audio routing.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: true,
    });

    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    logger.debug(
      "Display media stream obtained",
      {
        audioTracks: audioTracks.length,
        videoTracks: videoTracks.length,
        audioSettings: audioTracks[0]?.getSettings(),
      },
      "audio"
    );

    if (!audioTracks.length) {
      logger.error("No audio track in display media stream", {}, "audio");
      videoTracks.forEach((t) => t.stop());
      return null;
    }

    // Belt-and-suspenders: also apply constraints directly on the track
    // in case getDisplayMedia ignored the initial constraints.
    try {
      await audioTracks[0].applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
    } catch {}

    // ScreenCaptureKit requires active video frame consumption to pump the capture
    // session. Without a consumer, the loopback audio track produces silence even
    // though the track is "live" — video tracks merely staying un-stopped is not
    // enough. Attach the stream to a hidden muted <video> element so Chromium
    // pulls frames and keeps the session active.
    const videoSink = document.createElement("video");
    videoSink.srcObject = new MediaStream(videoTracks);
    videoSink.muted = true;
    videoSink.play().catch(() => {});

    audioTracks[0].addEventListener("ended", () => {
      logger.error("System audio track ended unexpectedly", {}, "audio");
      videoSink.srcObject = null;
    });

    return stream;
  } catch (err) {
    logger.error("Failed to capture system audio", { error: (err as Error).message }, "audio");
    return null;
  }
}

/**
 * Capture system audio. Prefers the native CoreAudio tap (macOS 14.2+, no
 * Screen Recording grant, no purple indicator); falls back to getDisplayMedia
 * loopback when the tap is unsupported or fails.
 * Returns null if all capture strategies fail.
 */
export async function getSystemAudioStream(): Promise<MediaStream | null> {
  const nativeStream = await getNativeTapStream();
  if (nativeStream) return nativeStream;
  return getLoopbackStream();
}

/**
 * Stop all tracks (audio + video) on a system audio stream.
 * Track stop() also tears down the native tap when the stream came from it.
 */
export function stopSystemAudioStream(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch {}
}
