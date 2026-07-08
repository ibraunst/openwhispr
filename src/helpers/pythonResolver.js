const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

/**
 * Resolves a Python 3 interpreter that has the speaker-diarization
 * dependencies (torch, torchaudio, pyannote) installed.
 *
 * Packaged GUI apps on macOS get a minimal PATH (/usr/bin:/bin:...), so a bare
 * execFile("python3", ...) resolves to the system interpreter, which almost
 * never has torch. This resolver probes the user's login-shell python plus the
 * common install locations and validates each candidate before use.
 */

const DEPS_CHECK = [
  "-c",
  "import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ('torch','torchaudio','pyannote')) else 1)",
];

let cachedInterpreter = null; // cache successful resolution only

function execFileP(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

async function loginShellPython() {
  if (process.platform === "win32") return null;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileP(shell, ["-lc", "command -v python3"], { timeout: 8000 });
    const candidate = stdout.trim().split("\n").pop();
    return candidate && fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function frameworkPythons() {
  // python.org installers live here; newest version first
  const versionsDir = "/Library/Frameworks/Python.framework/Versions";
  try {
    return fs
      .readdirSync(versionsDir)
      .filter((v) => /^\d+\.\d+$/.test(v))
      .sort((a, b) => parseFloat(b) - parseFloat(a))
      .map((v) => path.join(versionsDir, v, "bin", "python3"));
  } catch {
    return [];
  }
}

async function hasDiarizationDeps(python) {
  try {
    await execFileP(python, DEPS_CHECK, { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveDiarizationPython() {
  if (cachedInterpreter) return cachedInterpreter;

  const candidates = [];
  if (process.env.CUSTOMWHISPR_PYTHON) candidates.push(process.env.CUSTOMWHISPR_PYTHON);

  const shellPython = await loginShellPython();
  if (shellPython) candidates.push(shellPython);

  if (process.platform === "darwin") {
    candidates.push(
      ...frameworkPythons(),
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3"
    );
  } else if (process.platform === "win32") {
    candidates.push("python3", "python");
  } else {
    candidates.push("/usr/local/bin/python3", "/usr/bin/python3");
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    // Bare command names (Windows) are resolved by execFile itself
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;

    if (await hasDiarizationDeps(candidate)) {
      debugLogger.info("Resolved diarization Python interpreter", { python: candidate }, "meeting");
      cachedInterpreter = candidate;
      return candidate;
    }
    debugLogger.debug("Python candidate missing diarization deps", { python: candidate }, "meeting");
  }

  debugLogger.error(
    "No Python interpreter with diarization dependencies found",
    { probed: [...seen] },
    "meeting"
  );
  return null;
}

module.exports = { resolveDiarizationPython };
