const { execFileSync } = require("child_process");
const debugLogger = require("./debugLogger");
const sidecarPidFile = require("./sidecarPidFile");

const EXPECTED_BINARY_FRAGMENTS = {
  parakeet: "sherpa-onnx-ws",
  whisper: "whisper-server",
  llama: "llama-server",
  // The meeting coach's local fallback model (separate instance)
  "llama-coach": "llama-server",
  audiotap: "macos-audio-tap",
  diarize: "sherpa-onnx-diarize",
};

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function processCommand(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).toString();
      const match = out.match(/^"([^"]+)"/);
      return match ? match[1] : "";
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// Runs at startup, before any sidecar spawns. A stalled or force-quit previous run
// can leave a sidecar bound to its port; this SIGTERMs any pid file it wrote whose
// command line still matches the expected binary (skips a pid that's been reused by
// an unrelated process since).
function reapStaleSidecars() {
  const entries = sidecarPidFile.readAll();
  for (const { name, pid } of entries) {
    const fragment = EXPECTED_BINARY_FRAGMENTS[name];
    if (fragment && isProcessAlive(pid) && processCommand(pid).includes(fragment)) {
      debugLogger.warn("Reaping stale sidecar", { name, pid });
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead.
      }
    }
    sidecarPidFile.clear(name);
  }
}

module.exports = { reapStaleSidecars };
