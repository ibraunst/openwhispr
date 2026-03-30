import { useState, useEffect, useRef, useCallback } from "react";
import { getSettings } from "../stores/settingsStore";
import { isBuiltInMicrophone } from "../utils/audioDeviceUtils";
import { getSystemAudioStream } from "../utils/systemAudio";
import logger from "../utils/logger";

interface UseMeetingTranscriptionReturn {
  isRecording: boolean;
  isLocalProcessing: boolean;
  transcript: string;
  partialTranscript: string;
  error: string | null;
  prepareTranscription: () => Promise<void>;
  startTranscription: () => Promise<void>;
  stopTranscription: () => Promise<void>;
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
  } = getSettings();

  const hasOpenAIKey = !!openaiApiKey && openaiApiKey.trim() !== "";
  const canUseCloud =
    cloudTranscriptionMode === "customwhispr" ||
    (cloudTranscriptionMode === "byok" && hasOpenAIKey);

  if (useLocalWhisper || !canUseCloud) {
    return {
      provider: "local" as const,
      localProvider: localTranscriptionProvider || "whisper",
    };
  }

  const model = REALTIME_MODELS.has(cloudTranscriptionModel)
    ? cloudTranscriptionModel
    : "gpt-4o-mini-transcribe";
  const mode = cloudTranscriptionMode === "byok" ? "byok" : "customwhispr";
  return { provider: "openai-realtime" as const, model, mode };
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

export function useMeetingTranscription(): UseMeetingTranscriptionReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isLocalProcessing, setIsLocalProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

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
  const localModeRef = useRef(false);

  // Split audio recording refs (for speaker diarization)
  const systemRecorderRef = useRef<MediaRecorder | null>(null);
  const systemChunksRef = useRef<Blob[]>([]);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);
  const meetingIdRef = useRef<string>("");

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
    window.electronAPI?.meetingSetUserRecording?.(false);

    const wasLocalMode = localModeRef.current;
    localModeRef.current = false;

    // Capture split audio blobs before cleanup kills the streams
    const splitSystemPromise = stopSplitRecorder(systemRecorderRef.current, systemChunksRef);
    const splitMicPromise = stopSplitRecorder(micRecorderRef.current, micChunksRef);
    const currentMeetingId = meetingIdRef.current;

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
          const { localProvider } = getMeetingTranscriptionOptions() as { provider: "local"; localProvider: string };
          const result = await window.electronAPI?.meetingTranscribeLocal?.(arrayBuffer, { localProvider });

          if (result?.success && result.transcript) {
            setTranscript(result.transcript);

            // Save a single-segment transcript.json for diarization to enrich
            if (currentMeetingId) {
              const durationSec = (blob.size / (16000 * 2)) || 30;
              window.electronAPI?.meetingSaveTranscript?.({
                meetingId: currentMeetingId,
                segments: [{ start: 0, end: durationSec, text: result.transcript }],
              }).catch((err: Error) =>
                logger.error("Failed to save local transcript", { error: err.message }, "meeting")
              );
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
          setTranscript(result.transcript);
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

          logger.info("Split audio saved, running speaker diarization…", { meetingId: currentMeetingId }, "meeting");

          const { hfToken } = getSettings();
          if (!hfToken) {
            logger.warn("Skipping diarization: no HuggingFace token configured", {}, "meeting");
            return;
          }

          const diarizeResult = await window.electronAPI?.meetingRunDiarization?.({
            meetingId: currentMeetingId,
            hfToken,
          });

          if (diarizeResult?.success) {
            logger.info("Speaker diarization complete", { meetingId: currentMeetingId }, "meeting");
          } else {
            logger.error("Speaker diarization failed", { error: diarizeResult?.error }, "meeting");
          }
        } catch (err) {
          logger.error("Split audio / diarization error", { error: (err as Error).message }, "meeting");
        }
      })();
    }

    logger.info("Meeting transcription stopped", { wasLocalMode }, "meeting");
  }, [cleanup, startSplitRecorder]);

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

    const options = getMeetingTranscriptionOptions();

    // Set recording state immediately for instant UI feedback
    isRecordingRef.current = true;
    setIsRecording(true);
    window.electronAPI?.meetingSetUserRecording?.(true);

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

        // Start split recorders for speaker diarization
        meetingIdRef.current = `meeting-${Date.now()}`;
        systemRecorderRef.current = startSplitRecorder(stream, systemChunksRef);
        if (micResult) {
          micRecorderRef.current = startSplitRecorder(micResult, micChunksRef);
        }

        logger.info(
          "Local meeting recording started",
          { mimeType, hasMic: !!micResult },
          "meeting"
        );
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

    // Cloud (OpenAI Realtime) path — unchanged
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
        void cleanup();
      }
    };
  }, [cleanup]);

  return {
    isRecording,
    isLocalProcessing,
    transcript,
    partialTranscript,
    error,
    prepareTranscription,
    startTranscription,
    stopTranscription,
  };
}
