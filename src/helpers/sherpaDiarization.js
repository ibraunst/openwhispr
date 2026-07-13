const fs = require("fs");
const path = require("path");
const { utilityProcess } = require("electron");
const debugLogger = require("./debugLogger");
const sidecarPidFile = require("./sidecarPidFile");
const { resolveBinaryPath } = require("../utils/serverUtils");

/**
 * Main-process manager for the sherpa-onnx diarization engine (Tier 6).
 *
 * Forks src/workers/sherpaDiarizationEngine.js as a utilityProcess — the
 * worker owns the CLI spawn, CAM++ embeddings, voicebank matching and
 * transcript merge; this side only resolves paths, enforces the same 15-min
 * timeout/kill discipline as the Python engine, and keeps the sidecar pid
 * registry aware of the diarize CLI so a stale process is reaped on restart.
 *
 * Contract is identical to the Python engine: the worker rewrites
 * transcript.json in place (segments[].speaker + speakers[] metadata) and the
 * caller reads the result from the file, never from stdout.
 */

const RUN_TIMEOUT_MS = 15 * 60 * 1000;

const SEGMENTATION_MODEL_RELPATH = path.join(
  "sherpa-onnx-pyannote-segmentation-3-0",
  "model.onnx"
);
const EMBEDDING_MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";

function getDiarizeBinaryPath() {
  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName =
    process.platform === "win32"
      ? `sherpa-onnx-diarize-${platformArch}.exe`
      : `sherpa-onnx-diarize-${platformArch}`;
  return resolveBinaryPath(binaryName);
}

function getModelsDir() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", "diarization-models"));
  }
  candidates.push(path.resolve(__dirname, "..", "..", "resources", "bin", "diarization-models"));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, SEGMENTATION_MODEL_RELPATH))) return dir;
  }
  return null;
}

function getEngineScriptPath() {
  return path.join(__dirname, "..", "workers", "sherpaDiarizationEngine.js");
}

function isAvailable() {
  const modelsDir = getModelsDir();
  return Boolean(
    getDiarizeBinaryPath() &&
      modelsDir &&
      fs.existsSync(path.join(modelsDir, EMBEDDING_MODEL_FILE)) &&
      fs.existsSync(getEngineScriptPath())
  );
}

function unavailableReason() {
  if (!getDiarizeBinaryPath()) return "sherpa-onnx diarization binary not found";
  const modelsDir = getModelsDir();
  if (!modelsDir) return "speaker segmentation model not found";
  if (!fs.existsSync(path.join(modelsDir, EMBEDDING_MODEL_FILE))) {
    return "speaker embedding model not found";
  }
  return null;
}

/**
 * Run the sherpa diarization engine. Resolves when the worker exits cleanly
 * (transcript.json has been rewritten); rejects on failure or timeout.
 */
function run({
  systemAudioPath,
  micAudioPath,
  transcriptPath,
  voiceDbPath,
  numSpeakers,
  maxSpeakers,
  meThreshold,
  matchThreshold,
  clusterThreshold,
  readOnlyBank,
  primaryIsMic,
  allowedSpeakers,
}) {
  const binPath = getDiarizeBinaryPath();
  const modelsDir = getModelsDir();
  if (!binPath || !modelsDir) {
    return Promise.reject(new Error(unavailableReason() || "sherpa engine unavailable"));
  }

  const args = [
    "--system-audio",
    systemAudioPath,
    "--mic-audio",
    micAudioPath,
    "--transcript",
    transcriptPath,
    "--voice-db",
    voiceDbPath,
    "--diarize-bin",
    binPath,
    "--seg-model",
    path.join(modelsDir, SEGMENTATION_MODEL_RELPATH),
    "--emb-model",
    path.join(modelsDir, EMBEDDING_MODEL_FILE),
  ];
  if (numSpeakers) args.push("--num-speakers", String(numSpeakers));
  if (Number.isInteger(maxSpeakers) && maxSpeakers >= 2) {
    args.push("--max-speakers", String(maxSpeakers));
  }
  if (Number.isFinite(meThreshold)) args.push("--similarity", String(meThreshold));
  if (Number.isFinite(matchThreshold)) {
    args.push("--voicebank-threshold", String(matchThreshold));
  }
  if (Number.isFinite(clusterThreshold)) {
    args.push("--cluster-threshold", String(clusterThreshold));
  }
  if (readOnlyBank) args.push("--read-only-bank");
  if (primaryIsMic) args.push("--primary-is-mic");
  // Attendee names/emails — named voiceprints outside this list must not
  // label clusters (a saved voice can't belong to someone not in the room).
  if (Array.isArray(allowedSpeakers) && allowedSpeakers.length > 0) {
    args.push("--allowed-speakers", JSON.stringify(allowedSpeakers));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let cliPid = null;
    let stderrTail = "";

    const child = utilityProcess.fork(getEngineScriptPath(), args, {
      serviceName: "customwhispr-sherpa-diarization",
      stdio: "pipe",
    });

    const killCli = () => {
      if (cliPid) {
        try {
          process.kill(cliPid, "SIGKILL");
        } catch {
          // Already dead.
        }
        sidecarPidFile.clear("diarize");
        cliPid = null;
      }
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killCli();
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => {
      debugLogger.error("Sherpa diarization timed out, killing worker", {
        timeoutMs: RUN_TIMEOUT_MS,
      }, "meeting");
      try {
        child.kill();
      } catch {
        // Best effort.
      }
      finish(new Error("Sherpa diarization timed out after 15 minutes"));
    }, RUN_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) debugLogger.info("sherpa diarization summary", { line }, "meeting");
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "diarize-cli-pid" && Number.isInteger(event.pid)) {
            cliPid = event.pid;
            sidecarPidFile.write("diarize", cliPid);
          }
          debugLogger.debug("sherpa diarization event", event, "meeting");
        } catch {
          debugLogger.debug("sherpa diarization stderr", { line }, "meeting");
        }
      }
    });

    child.on("exit", (code) => {
      if (code === 0) {
        finish(null);
      } else {
        const tail = stderrTail.trim().split("\n").slice(-6).join("\n");
        finish(new Error(tail || `Sherpa diarization worker exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      finish(new Error(`Failed to start sherpa diarization worker: ${err.message}`));
    });
  });
}

const ENROLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * "Learn voice from this recording": extract a voiceprint for ONE speaker
 * from known time spans of an existing recording and upsert it into the
 * bank. Runs the same worker script in enroll-only mode — no diarization
 * CLI, no transcript write. Resolves with the worker's result JSON
 * ({ voiceprint_id, label, seconds, segments }).
 */
function enrollVoice({ audioPath, spans, label, voiceDbPath }) {
  const modelsDir = getModelsDir();
  if (!modelsDir) {
    return Promise.reject(new Error(unavailableReason() || "sherpa engine unavailable"));
  }

  const args = [
    "--system-audio",
    audioPath,
    "--voice-db",
    voiceDbPath,
    "--emb-model",
    path.join(modelsDir, EMBEDDING_MODEL_FILE),
    "--enroll-label",
    label,
    "--enroll-spans",
    JSON.stringify(spans),
  ];

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderrTail = "";

    const child = utilityProcess.fork(getEngineScriptPath(), args, {
      serviceName: "customwhispr-voice-enroll",
      stdio: "pipe",
    });

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best effort.
      }
      finish(new Error("Voice enrollment timed out"));
    }, ENROLL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) debugLogger.debug("voice enroll event", { line }, "meeting");
      }
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderrTail.trim().split("\n").slice(-6).join("\n");
        finish(new Error(tail || `Voice enrollment worker exited with code ${code}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        if (!result.ok) throw new Error(result.error || "Enrollment produced no result");
        finish(null, result);
      } catch (err) {
        finish(new Error(`Unreadable enrollment result: ${err.message}`));
      }
    });

    child.on("error", (err) => {
      finish(new Error(`Failed to start voice enrollment worker: ${err.message}`));
    });
  });
}

module.exports = {
  isAvailable,
  unavailableReason,
  run,
  enrollVoice,
  getDiarizeBinaryPath,
  getModelsDir,
};
