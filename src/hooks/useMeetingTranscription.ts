import { useState, useEffect, useRef, useCallback } from "react";
import type React from "react";
import { getSettings } from "../stores/settingsStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { getSystemAudioStream } from "../utils/systemAudio";
import { EchoLeakGate, pcm16ToFloat32 } from "../utils/echoLeakGate";
import logger from "../utils/logger";

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  isPaused: boolean;
  canPause: boolean;
  isLocalProcessing: boolean;
  isDiarizing: boolean;
  transcript: string;
  diarizedTranscript: string;
  diarizationError: string | null;
  partialTranscript: string;
  error: string | null;
  diarizationNoteIdRef: React.MutableRefObject<number | null>;
  diarizationAttendeesRef: React.MutableRefObject<string | null>;
  baseTranscriptRef: React.MutableRefObject<string | null>;
  overrideDiarizedTranscript: (transcript: string) => void;
  prepareTranscription: () => Promise<void>;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
  pauseTranscription: () => void;
  resumeTranscription: () => void;
}

const MEETING_AUDIO_BUFFER_SIZE = 800;
const MEETING_STOP_FLUSH_TIMEOUT_MS = 50;

const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

const getMeetingTranscriptionOptions = () => {
  const {
    cloudTranscriptionMode,
    cloudTranscriptionModel,
    openaiApiKey,
    useLocalWhisper,
    localTranscriptionProvider,
    meetingTranscriptionProvider,
    whisperModel,
    parakeetModel,
  } = getSettings();

  const hasOpenAIKey = !!openaiApiKey && openaiApiKey.trim() !== "";
  const canUseCloud =
    cloudTranscriptionMode === "customwhispr" ||
    (cloudTranscriptionMode === "byok" && hasOpenAIKey);

  // A dedicated meeting model overrides the dictation setup entirely —
  // it always runs locally with the chosen engine.
  const meetingOverride =
    meetingTranscriptionProvider && meetingTranscriptionProvider !== "same"
      ? meetingTranscriptionProvider
      : null;

  if (meetingOverride || useLocalWhisper || !canUseCloud) {
    return {
      provider: "local" as const,
      localProvider: meetingOverride || localTranscriptionProvider || "whisper",
      whisperModel,
      parakeetModel,
    };
  }

  const model = REALTIME_MODELS.has(cloudTranscriptionModel)
    ? cloudTranscriptionModel
    : "gpt-4o-mini-transcribe";
  const mode = cloudTranscriptionMode === "byok" ? "byok" : "customwhispr";
  return { provider: "openai-realtime" as const, model, mode };
};

// Live preview chunking (local mode). Parakeet transcribes each flushed
// chunk while the meeting records; the end-of-meeting full pass replaces it.
const LIVE_SAMPLE_RATE = 16000;
const LIVE_MIN_FLUSH_SEC = 4;
const LIVE_MAX_FLUSH_SEC = 10;
const LIVE_QUIET_RMS = 0.01;
const LIVE_QUIET_TAIL_MS = 250;

const encodeWavPcm16 = (
  chunks: Int16Array[],
  totalSamples: number,
  sampleRate: number
): ArrayBuffer => {
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, totalSamples * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      view.setInt16(off, c[i], true);
      off += 2;
    }
  }
  return buffer;
};

const getMeetingWorkletBlobUrl = (() => {
  let blobUrl: string | null = null;

  return () => {
    if (blobUrl) return blobUrl;

    const code = `
const BUFFER_SIZE = ${MEETING_AUDIO_BUFFER_SIZE};
class MeetingPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this.port.postMessage(partial.buffer, [partial.buffer]);
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
        }
        this._stopped = true;
      }
    };
  }
  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("meeting-pcm-processor", MeetingPCMProcessor);
`;

    blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return blobUrl;
  };
})();

const getMeetingMicConstraints = async (): Promise<MediaStreamConstraints> => {
  const { preferBuiltInMic, selectedMicDeviceId } = getSettings();
  const micProcessing = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  };

  if (preferBuiltInMic) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const builtInMic = devices.find(
        (device) => device.kind === "audioinput" && isBuiltInMicrophone(device.label)
      );

      if (builtInMic?.deviceId) {
        return {
          audio: {
            deviceId: { exact: builtInMic.deviceId },
            ...micProcessing,
          },
        };
      }
    } catch (err) {
      logger.debug(
        "Failed to enumerate microphones for meeting transcription",
        { error: (err as Error).message },
        "meeting"
      );
    }
  }

  if (selectedMicDeviceId && selectedMicDeviceId !== "default") {
    return {
      audio: {
        deviceId: { exact: selectedMicDeviceId },
        ...micProcessing,
      },
    };
  }

  return { audio: micProcessing };
};

/**
 * Detach an AudioContext from hardware output to avoid Bluetooth routing issues.
 * When BT headphones become the default output, the OS drops to the HFP profile
 * and the context's render thread can stall on the sample-rate mismatch — the
 * MediaStreamDestination then produces silence and the recording is empty.
 * These contexts only capture/process (nothing audible is connected), so a
 * "none" sink keeps them rendering without coupling to any physical device.
 */
const detachFromOutputDevice = async (ctx: AudioContext) => {
  if ("setSinkId" in ctx) {
    try {
      await (ctx as AudioContext & { setSinkId: (sink: unknown) => Promise<void> }).setSinkId({
        type: "none",
      });
    } catch {}
  }
};

const createAudioPipeline = async ({
  stream,
  context,
  label,
  onChunk,
}: {
  stream: MediaStream;
  context: AudioContext;
  label: string;
  onChunk: (chunk: ArrayBuffer) => void;
}) => {
  if (context.state === "suspended") {
    await context.resume();
  }

  await context.audioWorklet.addModule(getMeetingWorkletBlobUrl());

  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "meeting-pcm-processor");
  let chunkCount = 0;

  processor.port.onmessage = (event) => {
    const chunk = event.data;
    if (!(chunk instanceof ArrayBuffer)) return;

    if (chunkCount < 10 || chunkCount % 50 === 0) {
      const samples = new Int16Array(chunk);
      let maxAmplitude = 0;
      for (let i = 0; i < samples.length; i++) {
        const normalized = Math.abs(samples[i]) / 0x7fff;
        if (normalized > maxAmplitude) maxAmplitude = normalized;
      }

      logger.debug(
        `${label} audio chunk`,
        { maxAmplitude: maxAmplitude.toFixed(6), samples: samples.length },
        "meeting"
      );
    }

    chunkCount++;
    onChunk(chunk);
  };

  source.connect(processor);
  processor.connect(context.destination);

  return { source, processor };
};

const flushAndDisconnectProcessor = async (processor: AudioWorkletNode | null) => {
  if (!processor) return;

  try {
    processor.port.postMessage("stop");
    await new Promise((resolve) => {
      window.setTimeout(resolve, MEETING_STOP_FLUSH_TIMEOUT_MS);
    });
  } catch {}

  processor.port.onmessage = null;
  processor.disconnect();
};

// getSystemAudioStream imported from ../utils/systemAudio

interface DiarizedSegmentResult {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

interface DiarizedSpeakerMeta {
  label: string;
  voiceprint_id: string | null;
  is_new: boolean;
  is_me: boolean;
}

/**
 * If exactly one brand-new guest was detected and the calendar event has exactly
 * one attendee besides the user, name the guest after that attendee: rename the
 * voiceprint (so future meetings recognize them) and relabel the segments.
 * Any ambiguity (multiple guests, multiple attendees) skips auto-naming — the
 * user can rename manually from the transcript view.
 */
async function autoNameLoneGuest(
  segments: DiarizedSegmentResult[],
  speakers: DiarizedSpeakerMeta[],
  attendeesJson: string | null
): Promise<DiarizedSegmentResult[]> {
  if (!attendeesJson) return segments;

  const newGuests = speakers.filter((s) => s.is_new && s.voiceprint_id);
  if (newGuests.length !== 1) return segments;

  let attendees: { name?: string | null; email?: string | null }[];
  try {
    attendees = JSON.parse(attendeesJson);
  } catch {
    logger.warn("Malformed attendees JSON, skipping guest auto-naming", {}, "meeting");
    return segments;
  }
  if (!Array.isArray(attendees)) return segments;

  const ownEmails = new Set(
    (getSettings().gcalAccounts || [])
      .map((a) => a.email?.toLowerCase())
      .filter((e): e is string => !!e)
  );
  const others = attendees.filter((a) => !(a.email && ownEmails.has(a.email.toLowerCase())));
  if (others.length !== 1) return segments;

  const name = (others[0].name || others[0].email || "").trim();
  if (!name) return segments;

  const guest = newGuests[0];
  try {
    const result = await window.electronAPI?.voicebankRename?.({
      id: guest.voiceprint_id!,
      newLabel: name,
    });
    if (!result?.success) {
      logger.warn("Voicebank rename failed during auto-naming", { error: result?.error }, "meeting");
      return segments;
    }
  } catch (err) {
    logger.warn("Voicebank rename error during auto-naming", { error: (err as Error).message }, "meeting");
    return segments;
  }

  logger.info("Auto-named guest from calendar attendee", { guest: guest.label, name }, "meeting");
  return segments.map((seg) => (seg.speaker === guest.label ? { ...seg, speaker: name } : seg));
}

export function formatDiarizedTranscript(segments: { start: number; end: number; text: string; speaker?: string }[]): string {
  const lines: string[] = [];
  let currentSpeaker = "";
  let currentText = "";

  for (const seg of segments) {
    const speaker = seg.speaker || "Unknown";
    const text = seg.text.trim();
    if (!text) continue;

    if (speaker === currentSpeaker) {
      currentText += " " + text;
    } else {
      if (currentSpeaker) {
        lines.push(`**${currentSpeaker}:** ${currentText}`);
      }
      currentSpeaker = speaker;
      currentText = text;
    }
  }

  if (currentSpeaker && currentText) {
    lines.push(`**${currentSpeaker}:** ${currentText}`);
  }

  return lines.join("\n\n");
}

export function useMeetingTranscription(): UseMeetingTranscriptionReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isLocalProcessing, setIsLocalProcessing] = useState(false);
  const [isDiarizing, setIsDiarizing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [diarizedTranscript, setDiarizedTranscript] = useState("");
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Pause/resume — local recordings only (cloud realtime timestamps would
  // drift out of alignment with the split diarization audio)
  const [isPaused, setIsPaused] = useState(false);
  const [canPause, setCanPause] = useState(false);
  const isPausedRef = useRef(false);

  // Ref for the note ID to receive the diarized transcript — set by the consumer component
  const diarizationNoteIdRef = useRef<number | null>(null);
  // Calendar attendees JSON for the current meeting — set by the consumer component,
  // used to auto-name a lone new guest after diarization. Lives in the hook (not the
  // component) so it survives unmount during the 30s+ diarization run.
  const diarizationAttendeesRef = useRef<string | null>(null);
  // Transcript already on the note when a recording is manually (re)started —
  // e.g. picking a meeting back up after an interrupted session. The new
  // session's transcript is APPENDED after it instead of overwriting it.
  const baseTranscriptRef = useRef<string | null>(null);

  // Cloud path refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Local path refs
  const localMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const localChunksRef = useRef<Blob[]>([]);
  const localMixContextRef = useRef<AudioContext | null>(null);
  // Live transcript preview (local mode): 16 kHz tap on the mixed stream
  const liveContextRef = useRef<AudioContext | null>(null);
  const liveProcessorRef = useRef<AudioWorkletNode | null>(null);
  const liveSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localModeRef = useRef(false);

  // Echo-leak gate (local mode): correlates the raw mic against recently
  // played system audio and mutes render bleed on the mic split recording —
  // diarization's identity channel. The mixed recording stays raw.
  const echoGateRef = useRef<{
    context: AudioContext;
    sources: MediaStreamAudioSourceNode[];
    processors: AudioWorkletNode[];
    gate: EchoLeakGate;
  } | null>(null);

  // Split audio recording refs (for speaker diarization)
  const systemRecorderRef = useRef<MediaRecorder | null>(null);
  const systemChunksRef = useRef<Blob[]>([]);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const meetingIdRef = useRef<string>("");
  const recordingStartedAtRef = useRef<number>(0);

  const startSplitRecorder = useCallback(
    (stream: MediaStream, chunksRef: React.MutableRefObject<Blob[]>): MediaRecorder | null => {
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) return null;

      chunksRef.current = [];
      // Create an audio-only stream to avoid MediaRecorder issues with video tracks
      const audioOnly = new MediaStream(audioTracks);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      try {
        const recorder = new MediaRecorder(audioOnly, { mimeType });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start();
        return recorder;
      } catch (err) {
        logger.error("Failed to start split recorder", { error: (err as Error).message }, "meeting");
        return null;
      }
    },
    []
  );

  const stopSplitRecorder = (
    recorder: MediaRecorder | null,
    chunksRef: React.MutableRefObject<Blob[]>
  ): Promise<Blob> => {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(new Blob(chunksRef.current, { type: "audio/webm;codecs=opus" }));
        return;
      }
      // Capture chunks ref before cleanup can null the recorder
      const chunks = chunksRef;
      recorder.onstop = () => {
        resolve(new Blob(chunks.current, { type: "audio/webm;codecs=opus" }));
      };
      try {
        recorder.stop();
      } catch {
        resolve(new Blob(chunks.current, { type: "audio/webm;codecs=opus" }));
      }
    });
  };

  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isPreparedRef = useRef(false);
  const preparePromiseRef = useRef<Promise<void> | null>(null);
  const ipcCleanupsRef = useRef<Array<() => void>>([]);

  const cleanup = useCallback(async () => {
    // Stop split recorders
    for (const ref of [systemRecorderRef, micRecorderRef]) {
      if (ref.current && ref.current.state !== "inactive") {
        try { ref.current.stop(); } catch {}
      }
      ref.current = null;
    }

    // Stop local recorder if active
    if (localMediaRecorderRef.current) {
      try {
        if (localMediaRecorderRef.current.state !== "inactive") {
          localMediaRecorderRef.current.stop();
        }
      } catch {}
      localMediaRecorderRef.current = null;
    }

    if (liveProcessorRef.current) {
      await flushAndDisconnectProcessor(liveProcessorRef.current);
      liveProcessorRef.current = null;
    }

    if (liveSourceRef.current) {
      liveSourceRef.current.disconnect();
      liveSourceRef.current = null;
    }

    if (liveContextRef.current) {
      try {
        await liveContextRef.current.close();
      } catch {}
      liveContextRef.current = null;
    }

    if (echoGateRef.current) {
      const { context, sources, processors, gate } = echoGateRef.current;
      echoGateRef.current = null;
      for (const processor of processors) {
        await flushAndDisconnectProcessor(processor);
      }
      for (const source of sources) {
        try {
          source.disconnect();
        } catch {}
      }
      try {
        await context.close();
      } catch {}
      const summary = gate.getSummary();
      if (summary.totalFrames > 0) {
        logger.info("Echo gate summary", { ...summary }, "meeting");
      }
    }

    if (localMixContextRef.current) {
      try {
        await localMixContextRef.current.close();
      } catch {}
      localMixContextRef.current = null;
    }

    if (processorRef.current) {
      await flushAndDisconnectProcessor(processorRef.current);
      processorRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (micProcessorRef.current) {
      await flushAndDisconnectProcessor(micProcessorRef.current);
      micProcessorRef.current = null;
    }

    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }

    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
    }

    if (micStreamRef.current) {
      try {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      micStreamRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }

    if (micContextRef.current) {
      try {
        await micContextRef.current.close();
      } catch {}
      micContextRef.current = null;
    }

    ipcCleanupsRef.current.forEach((fn) => fn());
    ipcCleanupsRef.current = [];
    isPreparedRef.current = false;
  }, []);

  const stopTranscription = useCallback(async () => {
    if (!isRecordingRef.current) return;

    // Signal stop immediately so in-flight startTranscription can abort
    isRecordingRef.current = false;
    isStartingRef.current = false;
    setIsRecording(false);
    isPausedRef.current = false;
    setIsPaused(false);
    setCanPause(false);
    if (localModeRef.current) {
      // Clear the live preview text in the same render that flips recording
      // off — otherwise the component's auto-generate effect sees a non-empty
      // transcript in the gap before local processing starts and generates
      // notes from the rough live text.
      setTranscript("");
    }
    window.electronAPI?.meetingSetUserRecording?.(false);
    window.electronAPI?.setSleepBlocker?.(false);

    const wasLocalMode = localModeRef.current;
    localModeRef.current = false;

    // Capture split audio blobs before cleanup kills the streams
    const splitSystemPromise = stopSplitRecorder(systemRecorderRef.current, systemChunksRef);
    const splitMicPromise = stopSplitRecorder(micRecorderRef.current, micChunksRef);
    const currentMeetingId = meetingIdRef.current;
    // Consume this meeting's context NOW. The diarization IIFE below runs for
    // 30s+; if the user starts meeting B in that window, reading the shared
    // refs later would write meeting A's transcript into B's note and use B's
    // attendees for A's speaker auto-naming.
    meetingIdRef.current = "";
    const targetNoteId = diarizationNoteIdRef.current;
    const attendeesJson = diarizationAttendeesRef.current;
    const baseTranscript = baseTranscriptRef.current;
    diarizationNoteIdRef.current = null;
    diarizationAttendeesRef.current = null;
    baseTranscriptRef.current = null;
    // Resumed sessions append after the transcript that was already on the
    // note — overwriting would lose the first half of an interrupted meeting.
    const withBase = (text: string) => (baseTranscript ? `${baseTranscript}\n\n${text}` : text);
    const recordingDurationSec = recordingStartedAtRef.current
      ? (Date.now() - recordingStartedAtRef.current) / 1000
      : 30;
    recordingStartedAtRef.current = 0;

    if (wasLocalMode) {
      // Local path: stop MediaRecorder, wait for onstop, then transcribe
      const recorder = localMediaRecorderRef.current;

      const blobPromise = new Promise<Blob>((resolve) => {
        if (!recorder || recorder.state === "inactive") {
          resolve(new Blob(localChunksRef.current, { type: "audio/webm;codecs=opus" }));
          return;
        }
        recorder.onstop = () => {
          resolve(new Blob(localChunksRef.current, { type: "audio/webm;codecs=opus" }));
        };
        try {
          recorder.stop();
        } catch {
          resolve(new Blob(localChunksRef.current, { type: "audio/webm;codecs=opus" }));
        }
      });

      await cleanup();

      const blob = await blobPromise;
      localChunksRef.current = [];

      if (blob.size >= 1000) {
        logger.info("Local meeting recording complete, transcribing...", { size: blob.size }, "meeting");
        setIsLocalProcessing(true);

        try {
          const arrayBuffer = await blob.arrayBuffer();
          const { localProvider, whisperModel, parakeetModel } = getMeetingTranscriptionOptions() as {
            provider: "local";
            localProvider: string;
            whisperModel?: string;
            parakeetModel?: string;
          };
          const result = await window.electronAPI?.meetingTranscribeLocal?.(arrayBuffer, {
            localProvider,
            whisperModel,
            parakeetModel,
          });

          if (result?.success && result.transcript) {
            setTranscript(withBase(result.transcript));

            // Persist to the note here — the component's transition effect
            // can't (recording flipped off long before this state arrives),
            // and the component may already be unmounted.
            if (targetNoteId) {
              window.electronAPI
                ?.updateNote?.(targetNoteId, { transcript: withBase(result.transcript) })
                .catch((err: Error) =>
                  logger.error("Failed to persist local transcript to note", { error: err.message }, "meeting")
                );
            }

            // Save transcript.json for diarization — must be awaited so it exists before diarization runs.
            // whisper provides per-segment timestamps; without them a single
            // whole-meeting segment can only ever receive ONE speaker label.
            if (currentMeetingId) {
              const segments = result.segments?.length
                ? result.segments
                : [{ start: 0, end: recordingDurationSec, text: result.transcript }];
              try {
                await window.electronAPI?.meetingSaveTranscript?.({
                  meetingId: currentMeetingId,
                  segments,
                });
              } catch (err) {
                logger.error("Failed to save local transcript", { error: (err as Error).message }, "meeting");
              }
            }
          } else {
            setError(result?.error || "Transcription failed.");
            logger.error("Local meeting transcription failed", { error: result?.error }, "meeting");
          }
        } catch (err) {
          setError((err as Error).message);
          logger.error("Local meeting transcription error", { error: (err as Error).message }, "meeting");
        } finally {
          setIsLocalProcessing(false);
        }
      } else {
        setError("Recording was too short to transcribe.");
        logger.warn("Local meeting recording too short", { size: blob.size }, "meeting");
      }
    } else {
      // Cloud path
      await cleanup();

      try {
        const result = await window.electronAPI?.meetingTranscriptionStop?.();
        if (result?.success && result.transcript) {
          setTranscript(withBase(result.transcript));
          // Persist the complete final transcript (includes the last flushed
          // utterance, which the component's effect misses) — unmount-safe.
          if (targetNoteId) {
            window.electronAPI
              ?.updateNote?.(targetNoteId, { transcript: withBase(result.transcript) })
              .catch((err: Error) =>
                logger.error("Failed to persist cloud transcript to note", { error: err.message }, "meeting")
              );
          }
        }
        if (result?.error) {
          setError(result.error);
        }

        // Save timestamped segments for diarization (awaited so it's ready before diarization runs)
        if (result?.segments?.length && currentMeetingId) {
          try {
            await window.electronAPI?.meetingSaveTranscript?.({
              meetingId: currentMeetingId,
              segments: result.segments,
            });
          } catch (err) {
            logger.error("Failed to save cloud transcript", { error: (err as Error).message }, "meeting");
          }
        }
      } catch (err) {
        setError((err as Error).message);
        logger.error(
          "Meeting transcription stop failed",
          { error: (err as Error).message },
          "meeting"
        );
      }
    }

    // Save split audio then run speaker diarization automatically
    if (currentMeetingId) {
      (async () => {
        try {
          const [systemBlob, micBlob] = await Promise.all([splitSystemPromise, splitMicPromise]);
          if (systemBlob.size < 1000 && micBlob.size < 1000) return;

          const [systemBuf, micBuf] = await Promise.all([
            systemBlob.arrayBuffer(),
            micBlob.arrayBuffer(),
          ]);

          const saveResult = await window.electronAPI?.meetingSaveSplitAudio?.({
            systemBuffer: systemBuf,
            micBuffer: micBuf,
            meetingId: currentMeetingId,
          });

          if (!saveResult?.success) {
            logger.error("Failed to save split audio", { error: saveResult?.error }, "meeting");
            return;
          }

          // Link the note to its recording so the transcript view can offer
          // audio playback later (meeting-get-playback resolves the folder
          // from this id).
          if (targetNoteId) {
            window.electronAPI
              ?.updateNote?.(targetNoteId, { meeting_id: currentMeetingId })
              .catch((err: Error) =>
                logger.error("Failed to link recording to note", { error: err.message }, "meeting")
              );
          }

          logger.info("Split audio saved, running speaker diarization…", { meetingId: currentMeetingId }, "meeting");

          const { hfToken, diarizationMeThreshold, diarizationMatchThreshold } = getSettings() as {
            hfToken?: string;
            diarizationMeThreshold?: number;
            diarizationMatchThreshold?: number;
          };
          if (!hfToken) {
            logger.warn("Skipping diarization: no HuggingFace token configured", {}, "meeting");
            setDiarizationError("No HuggingFace token configured. Add one in Settings → API Keys to enable speaker identification.");
            return;
          }

          // Calendar attendee count caps the diarization cluster count
          // (max, never exact — no-shows are common). Only for scheduled
          // meetings: attendeesJson exists only when a calendar event was
          // matched, so unscheduled recordings stay uncapped.
          let maxSpeakers: number | undefined;
          if (attendeesJson) {
            try {
              const attendees = JSON.parse(attendeesJson);
              if (Array.isArray(attendees) && attendees.length >= 2) {
                maxSpeakers = attendees.length;
              }
            } catch {}
          }

          setIsDiarizing(true);
          const diarizeResult = await window.electronAPI?.meetingRunDiarization?.({
            meetingId: currentMeetingId,
            hfToken,
            maxSpeakers,
            meThreshold: diarizationMeThreshold,
            matchThreshold: diarizationMatchThreshold,
          });

          if (diarizeResult?.success && diarizeResult.transcript?.segments?.length) {
            logger.info("Speaker diarization complete", { meetingId: currentMeetingId }, "meeting");
            const segments = await autoNameLoneGuest(
              diarizeResult.transcript.segments,
              diarizeResult.transcript.speakers || [],
              attendeesJson
            );
            // Sync the (possibly auto-renamed) labels back to transcript.json —
            // the playback view renders speakers from that file, so a label
            // that only changed in memory would resurface as "Guest N" there.
            if (segments !== diarizeResult.transcript.segments) {
              await window.electronAPI
                ?.meetingSaveTranscript?.({ meetingId: currentMeetingId, segments })
                .catch((err: Error) =>
                  logger.error("Failed to sync renamed segments", { error: err.message }, "meeting")
                );
            }
            const formatted = withBase(formatDiarizedTranscript(segments));
            // Persist diarized transcript directly to the note via IPC — the
            // component may have unmounted, and targetNoteId was captured at
            // stop time so a newer meeting can't redirect this write.
            if (targetNoteId) {
              await window.electronAPI?.updateNote?.(targetNoteId, { transcript: formatted });
            }
            setDiarizedTranscript(formatted);
          } else {
            const errMsg = diarizeResult?.error || "Speaker diarization failed";
            logger.error("Speaker diarization failed", { error: errMsg }, "meeting");
            setDiarizationError(errMsg);
          }
        } catch (err) {
          const errMsg = (err as Error).message;
          logger.error("Split audio / diarization error", { error: errMsg }, "meeting");
          setDiarizationError(errMsg);
        } finally {
          setIsDiarizing(false);
        }
      })();
    }

    logger.info("Meeting transcription stopped", { wasLocalMode }, "meeting");
  }, [cleanup, startSplitRecorder]);

  // Stop requests from the pill's meeting indicator (main-process broadcast)
  useEffect(() => {
    const cleanup = window.electronAPI?.onMeetingStopRequested?.(() => {
      stopTranscription();
    });
    return () => cleanup?.();
  }, [stopTranscription]);

  // Pause/resume — local recordings only. MediaRecorder.pause() keeps writing
  // into the same blob (no gap in the file), so the final transcription and
  // diarization timestamps stay aligned with the recorded audio.
  const pauseTranscription = useCallback(() => {
    if (!isRecordingRef.current || !localModeRef.current || isPausedRef.current) return;
    try {
      if (localMediaRecorderRef.current?.state === "recording") {
        localMediaRecorderRef.current.pause();
      }
    } catch {}
    for (const ref of [systemRecorderRef, micRecorderRef]) {
      try {
        if (ref.current?.state === "recording") ref.current.pause();
      } catch {}
    }
    // Halt the live-transcript tap so paused air never reaches Parakeet
    liveContextRef.current?.suspend().catch(() => {});
    // The gated mic feed pauses with it (its recorder is paused anyway)
    echoGateRef.current?.context.suspend().catch(() => {});
    isPausedRef.current = true;
    setIsPaused(true);
    logger.info("Meeting recording paused", {}, "meeting");
  }, []);

  const resumeTranscription = useCallback(() => {
    if (!isRecordingRef.current || !isPausedRef.current) return;
    try {
      if (localMediaRecorderRef.current?.state === "paused") {
        localMediaRecorderRef.current.resume();
      }
    } catch {}
    for (const ref of [systemRecorderRef, micRecorderRef]) {
      try {
        if (ref.current?.state === "paused") ref.current.resume();
      } catch {}
    }
    liveContextRef.current?.resume().catch(() => {});
    echoGateRef.current?.context.resume().catch(() => {});
    isPausedRef.current = false;
    setIsPaused(false);
    logger.info("Meeting recording resumed", {}, "meeting");
  }, []);

  const prepareTranscription = useCallback(async () => {
    if (isPreparedRef.current || isRecordingRef.current || isStartingRef.current) return;
    if (preparePromiseRef.current) return;

    const options = getMeetingTranscriptionOptions();

    // Local mode: nothing to warm up
    if (options.provider === "local") {
      isPreparedRef.current = true;
      logger.info("Local meeting transcription ready (no warmup needed)", {}, "meeting");
      return;
    }

    // Cloud (OpenAI Realtime) meeting path is retired — see startTranscription.
    // Skip the warmup entirely rather than opening a WebSocket that can't work.
    if (options.provider === "openai-realtime") {
      logger.debug(
        "Skipping meeting transcription prepare — cloud path is retired",
        {},
        "meeting"
      );
      return;
    }

    logger.info("Meeting transcription preparing (pre-warming WebSocket)...", {}, "meeting");

    const promise = (async () => {
      try {
        const result = await window.electronAPI?.meetingTranscriptionPrepare?.(options);

        if (result?.success) {
          isPreparedRef.current = true;
          logger.info(
            "Meeting transcription prepared",
            { alreadyPrepared: result.alreadyPrepared },
            "meeting"
          );
        } else {
          logger.error("Meeting transcription prepare failed", { error: result?.error }, "meeting");
        }
      } catch (err) {
        logger.error(
          "Meeting transcription prepare error",
          { error: (err as Error).message },
          "meeting"
        );
      } finally {
        preparePromiseRef.current = null;
      }
    })();

    preparePromiseRef.current = promise;
    await promise;
  }, []);

  const startTranscription = useCallback(async () => {
    if (isRecordingRef.current || isStartingRef.current) return;
    isStartingRef.current = true;

    logger.info("Meeting transcription starting...", {}, "meeting");
    setTranscript("");
    setPartialTranscript("");
    setError(null);
    // Clear the previous meeting's diarization output — without this, meeting
    // B's note displays meeting A's speaker transcript until B's own
    // diarization completes.
    setDiarizedTranscript("");
    setDiarizationError(null);

    const options = getMeetingTranscriptionOptions();

    // Set recording state immediately for instant UI feedback
    isRecordingRef.current = true;
    recordingStartedAtRef.current = Date.now();
    setIsRecording(true);
    isPausedRef.current = false;
    setIsPaused(false);
    setCanPause(false);
    window.electronAPI?.meetingSetUserRecording?.(true);
    window.electronAPI?.setSleepBlocker?.(true);

    if (options.provider === "local") {
      // Local recording path: capture audio with MediaRecorder
      localModeRef.current = true;
      localChunksRef.current = [];

      try {
        const [stream, micResult] = await Promise.all([
          getSystemAudioStream(),
          getMeetingMicConstraints().then((constraints) =>
            navigator.mediaDevices.getUserMedia(constraints).catch((err) => {
              logger.error(
                "Mic capture failed, recording system audio only",
                { error: (err as Error).message },
                "meeting"
              );
              return null;
            })
          ),
        ]);

        // Abort if stop was called during setup
        if (!isRecordingRef.current) {
          stream?.getTracks().forEach((t) => t.stop());
          micResult?.getTracks().forEach((t) => t.stop());
          isStartingRef.current = false;
          localModeRef.current = false;
          return;
        }

        if (!stream) {
          setError("Could not capture system audio. Check Screen Recording permission.");
          micResult?.getTracks().forEach((t) => t.stop());
          isRecordingRef.current = false;
          isStartingRef.current = false;
          setIsRecording(false);
          localModeRef.current = false;
          return;
        }

        streamRef.current = stream;
        if (micResult) micStreamRef.current = micResult;

        // Mix system audio + mic into a single stream for MediaRecorder
        const mixContext = new AudioContext();
        await detachFromOutputDevice(mixContext);
        localMixContextRef.current = mixContext;
        const destination = mixContext.createMediaStreamDestination();

        const systemSource = mixContext.createMediaStreamSource(stream);
        systemSource.connect(destination);

        if (micResult) {
          const micSource = mixContext.createMediaStreamSource(micResult);
          micSource.connect(destination);
        }

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        const recorder = new MediaRecorder(destination.stream, { mimeType });
        localMediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) localChunksRef.current.push(e.data);
        };

        recorder.start();
        isStartingRef.current = false;
        setCanPause(true);

        // Start split recorders for speaker diarization
        meetingIdRef.current = `meeting-${Date.now()}`;
        const startedMeetingId = meetingIdRef.current;
        systemRecorderRef.current = startSplitRecorder(stream, systemChunksRef);
        let micGated = false;
        if (micResult) {
          // Echo-leak gate: without headphones the other participants'
          // voices leak from the speakers into the mic, polluting the mic
          // split recording that diarization uses to decide "who is Me".
          // Route the mic through a detector-controlled gain and record the
          // gated stream. Best-effort — any failure records the raw mic as
          // before; the mixed recording (whole-meeting transcript) is never
          // gated, so a misfire can't lose transcript content.
          let micRecordStream: MediaStream = micResult;
          let gateContext: AudioContext | null = null;
          try {
            gateContext = new AudioContext();
            await detachFromOutputDevice(gateContext);
            const gate = new EchoLeakGate(gateContext.sampleRate);

            const micGain = gateContext.createGain();
            const gateDest = gateContext.createMediaStreamDestination();
            const gainSource = gateContext.createMediaStreamSource(micResult);
            gainSource.connect(micGain);
            micGain.connect(gateDest);

            // Detector taps: the RAW mic (pre-gain — gating the detector's
            // own input would erase the correlation it looks for) and the
            // system reference.
            let muteTarget = 1;
            const micTap = await createAudioPipeline({
              stream: micResult,
              context: gateContext,
              label: "Echo gate mic",
              onChunk: (chunk) => {
                const muted = gate.processMicChunk(pcm16ToFloat32(chunk));
                const target = muted ? 0 : 1;
                if (target !== muteTarget) {
                  muteTarget = target;
                  micGain.gain.setTargetAtTime(target, gateContext!.currentTime, 0.015);
                }
              },
            });
            const systemTap = await createAudioPipeline({
              stream,
              context: gateContext,
              label: "Echo gate system",
              onChunk: (chunk) => {
                gate.recordSystemChunk(pcm16ToFloat32(chunk));
              },
            });

            if (!isRecordingRef.current || meetingIdRef.current !== startedMeetingId) {
              // Stop (or a new meeting) raced in during setup — discard
              await flushAndDisconnectProcessor(micTap.processor);
              await flushAndDisconnectProcessor(systemTap.processor);
              try {
                await gateContext.close();
              } catch {}
            } else {
              echoGateRef.current = {
                context: gateContext,
                sources: [gainSource, micTap.source, systemTap.source],
                processors: [micTap.processor, systemTap.processor],
                gate,
              };
              micRecordStream = gateDest.stream;
              micGated = true;
            }
          } catch (gateErr) {
            logger.warn(
              "Echo gate unavailable, recording raw mic",
              { error: (gateErr as Error).message },
              "meeting"
            );
            if (gateContext && echoGateRef.current?.context !== gateContext) {
              try {
                await gateContext.close();
              } catch {}
            }
          }

          if (isRecordingRef.current && meetingIdRef.current === startedMeetingId) {
            micRecorderRef.current = startSplitRecorder(micRecordStream, micChunksRef);
          }
        }

        logger.info(
          "Local meeting recording started",
          { mimeType, hasMic: !!micResult, micGated },
          "meeting"
        );

        // Live transcript preview: tap the mixed stream at 16 kHz and feed
        // ~4-10s chunks (cut at silence when possible) to Parakeet while the
        // meeting records. Best-effort — any failure disables the preview and
        // never touches the recording or the end-of-meeting full pass.
        try {
          const liveContext = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE });
          await detachFromOutputDevice(liveContext);
          liveContextRef.current = liveContext;

          let liveChunks: Int16Array[] = [];
          let liveSampleCount = 0;
          let quietTailMs = 0;
          let liveDisabled = false;
          let liveFailures = 0;
          let liveQueue: Promise<void> = Promise.resolve();
          const liveParakeetModel = getSettings().parakeetModel || undefined;

          const flushLive = () => {
            if (liveSampleCount === 0) return;
            const wav = encodeWavPcm16(liveChunks, liveSampleCount, LIVE_SAMPLE_RATE);
            liveChunks = [];
            liveSampleCount = 0;
            quietTailMs = 0;
            // Serialize chunk transcriptions so results append in order
            liveQueue = liveQueue.then(async () => {
              if (liveDisabled || !isRecordingRef.current) return;
              try {
                const res = await window.electronAPI?.meetingTranscribeLiveChunk?.(wav, {
                  parakeetModel: liveParakeetModel,
                });
                if (res?.success) {
                  liveFailures = 0;
                  const text = res.text?.trim();
                  if (text && isRecordingRef.current && localModeRef.current) {
                    setTranscript((prev) => (prev ? `${prev} ${text}` : text));
                  }
                } else {
                  liveFailures += 1;
                  if (res?.unavailable || liveFailures >= 2) {
                    liveDisabled = true;
                    logger.info(
                      "Live transcript preview disabled",
                      { error: res?.error },
                      "meeting"
                    );
                  }
                }
              } catch {
                liveFailures += 1;
                if (liveFailures >= 2) liveDisabled = true;
              }
            });
          };

          const { source: liveSource, processor: liveProcessor } = await createAudioPipeline({
            stream: destination.stream,
            context: liveContext,
            label: "Meeting live preview",
            onChunk: (chunk) => {
              if (!isRecordingRef.current || liveDisabled) return;
              const samples = new Int16Array(chunk);
              liveChunks.push(samples);
              liveSampleCount += samples.length;

              // Prefer cutting at a quiet moment so words aren't split
              let sum = 0;
              for (let i = 0; i < samples.length; i++) {
                const v = samples[i] / 32768;
                sum += v * v;
              }
              const rms = Math.sqrt(sum / samples.length);
              const chunkMs = (samples.length / LIVE_SAMPLE_RATE) * 1000;
              quietTailMs = rms < LIVE_QUIET_RMS ? quietTailMs + chunkMs : 0;

              const bufferedSec = liveSampleCount / LIVE_SAMPLE_RATE;
              if (
                (bufferedSec >= LIVE_MIN_FLUSH_SEC && quietTailMs >= LIVE_QUIET_TAIL_MS) ||
                bufferedSec >= LIVE_MAX_FLUSH_SEC
              ) {
                flushLive();
              }
            },
          });
          liveSourceRef.current = liveSource;
          liveProcessorRef.current = liveProcessor;
        } catch (liveErr) {
          logger.info(
            "Live transcript preview unavailable",
            { error: (liveErr as Error).message },
            "meeting"
          );
        }
      } catch (err) {
        logger.error("Local meeting recording setup failed", { error: (err as Error).message }, "meeting");
        isRecordingRef.current = false;
        isStartingRef.current = false;
        setIsRecording(false);
        localModeRef.current = false;
        await cleanup();
      }

      return;
    }

    // Cloud (OpenAI Realtime) meeting path is retired: OpenAI removed the
    // Realtime Beta API this depends on (2026-05-12), so it can no longer
    // connect. It used to fail silently deep inside the IPC round-trip below
    // with no user-visible message; surface a clear one up front instead of
    // letting the user wonder why "recording" produced nothing. Local is the
    // only supported meeting transcription path — see Settings > Transcription.
    if (options.provider === "openai-realtime") {
      logger.error(
        "Cloud meeting transcription is unavailable (OpenAI Realtime Beta API was removed)",
        {},
        "meeting"
      );
      setError(
        "Cloud meeting transcription is no longer available. Switch to a local model in Settings > Transcription > Meeting transcription model."
      );
      isRecordingRef.current = false;
      isStartingRef.current = false;
      setIsRecording(false);
      window.electronAPI?.meetingSetUserRecording?.(false);
      window.electronAPI?.setSleepBlocker?.(false);
      return;
    }

    // Wait for in-flight prepare to reuse the warm connection
    if (preparePromiseRef.current) {
      logger.debug("Waiting for in-flight prepare to finish...", {}, "meeting");
      await preparePromiseRef.current;
    }

    try {
      const startTime = performance.now();

      const [startResult, stream, micResult] = await Promise.all([
        window.electronAPI?.meetingTranscriptionStart?.(options),
        getSystemAudioStream(),
        getMeetingMicConstraints().then((constraints) =>
          navigator.mediaDevices.getUserMedia(constraints).catch((err) => {
            logger.error(
              "Mic capture failed, continuing with system audio only",
              { error: (err as Error).message },
              "meeting"
            );
            return null;
          })
        ),
      ]);

      const streamsMs = performance.now() - startTime;

      // Abort if stop was called during setup
      if (!isRecordingRef.current) {
        logger.info("Meeting transcription aborted during setup (stop called)", {}, "meeting");
        stream?.getTracks().forEach((t) => t.stop());
        micResult?.getTracks().forEach((t) => t.stop());
        isStartingRef.current = false;
        return;
      }

      if (!startResult?.success) {
        logger.error(
          "Meeting transcription IPC start failed",
          { error: startResult?.error },
          "meeting"
        );
        stream?.getTracks().forEach((track) => track.stop());
        micResult?.getTracks().forEach((track) => track.stop());
        isRecordingRef.current = false;
        isStartingRef.current = false;
        setIsRecording(false);
        return;
      }

      if (!stream) {
        logger.error("Could not capture system audio for meeting transcription", {}, "meeting");
        micResult?.getTracks().forEach((track) => track.stop());
        await window.electronAPI?.meetingTranscriptionStop?.();
        isRecordingRef.current = false;
        isStartingRef.current = false;
        setIsRecording(false);
        return;
      }
      streamRef.current = stream;

      const partialCleanup = window.electronAPI?.onMeetingTranscriptionPartial?.((text) => {
        setPartialTranscript(text);
      });
      if (partialCleanup) ipcCleanupsRef.current.push(partialCleanup);

      const finalCleanup = window.electronAPI?.onMeetingTranscriptionFinal?.((text) => {
        setTranscript(text);
        setPartialTranscript("");
      });
      if (finalCleanup) ipcCleanupsRef.current.push(finalCleanup);

      const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
        setError(err);
        logger.error("Meeting transcription stream error", { error: err }, "meeting");
      });
      if (errorCleanup) ipcCleanupsRef.current.push(errorCleanup);

      const pendingAudioChunks: ArrayBuffer[] = [];
      let socketReady = false;

      const audioContext = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = audioContext;

      const systemPipelinePromise = createAudioPipeline({
        stream,
        context: audioContext,
        label: "Meeting system",
        onChunk: (chunk) => {
          if (!isRecordingRef.current) return;
          const samples = new Int16Array(chunk);
          let hasSignal = false;
          for (let i = 0; i < samples.length; i++) {
            if (samples[i] !== 0) {
              hasSignal = true;
              break;
            }
          }
          if (!hasSignal) return;
          if (socketReady) {
            window.electronAPI?.meetingTranscriptionSend?.(chunk);
            return;
          }
          pendingAudioChunks.push(chunk.slice(0));
        },
      });

      let micPipelinePromise: Promise<void> | null = null;
      if (micResult) {
        micStreamRef.current = micResult;
        const micContext = new AudioContext({ sampleRate: 24000 });
        micContextRef.current = micContext;

        micPipelinePromise = createAudioPipeline({
          stream: micResult,
          context: micContext,
          label: "Meeting mic",
          onChunk: (chunk) => {
            if (!isRecordingRef.current) return;
            if (socketReady) {
              window.electronAPI?.meetingTranscriptionSend?.(chunk);
              return;
            }
            pendingAudioChunks.push(chunk.slice(0));
          },
        }).then(({ source, processor }) => {
          micSourceRef.current = source;
          micProcessorRef.current = processor;

          const micTrack = micResult.getAudioTracks()[0];
          logger.info(
            "Mic capture started for meeting transcription",
            {
              label: micTrack?.label,
              settings: micTrack?.getSettings(),
            },
            "meeting"
          );
        });
      }

      const [systemPipeline] = await Promise.all(
        [systemPipelinePromise, micPipelinePromise].filter(Boolean)
      );

      if (systemPipeline) {
        sourceRef.current = systemPipeline.source;
        processorRef.current = systemPipeline.processor;
      }

      // Abort if stop was called during pipeline setup
      if (!isRecordingRef.current) {
        logger.info(
          "Meeting transcription aborted during pipeline setup (stop called)",
          {},
          "meeting"
        );
        isStartingRef.current = false;
        await cleanup();
        return;
      }

      isStartingRef.current = false;
      socketReady = true;

      // Start split recorders for speaker diarization
      meetingIdRef.current = `meeting-${Date.now()}`;
      if (streamRef.current) {
        systemRecorderRef.current = startSplitRecorder(streamRef.current, systemChunksRef);
      }
      if (micStreamRef.current) {
        micRecorderRef.current = startSplitRecorder(micStreamRef.current, micChunksRef);
      }

      for (const chunk of pendingAudioChunks) {
        window.electronAPI?.meetingTranscriptionSend?.(chunk);
      }

      const totalMs = performance.now() - startTime;
      logger.info(
        "Meeting transcription started successfully",
        {
          bufferedChunks: pendingAudioChunks.length,
          streamsMs: Math.round(streamsMs),
          totalMs: Math.round(totalMs),
          wasPrepared: isPreparedRef.current,
        },
        "meeting"
      );
    } catch (err) {
      logger.error(
        "Meeting transcription setup failed",
        { error: (err as Error).message },
        "meeting"
      );
      isRecordingRef.current = false;
      isStartingRef.current = false;
      setIsRecording(false);
      await cleanup();
    }
  }, [cleanup]);

  // Auto-stop when the meeting app (e.g. Zoom) closes
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onMeetingProcessEnded?.(() => {
      if (isRecordingRef.current) {
        logger.info("Meeting app closed — auto-stopping transcription", {}, "meeting");
        void stopTranscription();
      }
    });
    return () => unsubscribe?.();
  }, [stopTranscription]);

  // Auto-stop when meeting detection engine signals end (silence, calendar, etc.)
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onMeetingAutoStopExecute?.(() => {
      if (isRecordingRef.current) {
        logger.info("Meeting auto-stop executed — stopping transcription", {}, "meeting");
        void stopTranscription();
      }
    });
    return () => unsubscribe?.();
  }, [stopTranscription]);

  useEffect(() => {
    getMeetingWorkletBlobUrl();
  }, []);

  useEffect(() => {
    return () => {
      // Don't reset isRecordingRef here — StrictMode double-mount would abort in-flight setup
      if (isRecordingRef.current) {
        // Run the full stop flow, not bare cleanup(): it releases the sleep
        // blocker and the detection engine's user-recording flag, and it
        // transcribes + persists what was recorded (all via refs/IPC, so it
        // completes safely after unmount). Bare cleanup() silently destroyed
        // the recording and left both main-process flags stuck on.
        void stopTranscription();
      }
    };
  }, [stopTranscription]);

  return {
    isRecording,
    isPaused,
    canPause,
    isLocalProcessing,
    isDiarizing,
    transcript,
    diarizedTranscript,
    diarizationError,
    partialTranscript,
    error,
    diarizationNoteIdRef,
    diarizationAttendeesRef,
    baseTranscriptRef,
    overrideDiarizedTranscript: setDiarizedTranscript,
    prepareTranscription,
    startTranscription,
    stopTranscription,
    pauseTranscription,
    resumeTranscription,
  };
}
