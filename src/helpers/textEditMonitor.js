const { spawn, execFile } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const POLL_INTERVAL_MS = 500;
const INITIAL_QUERY_DELAY_MS = 500; // Wait for paste to settle in target app
const INITIAL_QUERY_RETRIES = 4; // Retry if AXValue is empty (paste not yet processed)
const INITIAL_QUERY_RETRY_DELAY_MS = 300;

// AppleScript to enable AXEnhancedUserInterface on the target app.
// Chromium-based apps (Chrome, Electron, VS Code, Slack, etc.) don't build their
// accessibility tree until an assistive technology announces itself via this attribute.
// This is the same technique Grammarly uses on macOS.
const MACOS_AX_ENABLE_SCRIPT = (pid) =>
  `tell application "System Events"\n` +
  `\tset targetProc to first application process whose unix id is ${pid}\n` +
  `\ttry\n` +
  `\t\tset value of attribute "AXEnhancedUserInterface" of targetProc to true\n` +
  `\tend try\n` +
  `end tell`;

// AppleScript to read the focused text field value from a specific app by PID.
// Using PID avoids the problem where the Electron overlay is "frontmost".
// Tries AXValue first, then falls back to AXStringForRange for apps that
// implement parameterized text attributes but not AXValue directly.
const MACOS_AX_SCRIPT_BY_PID = (pid) =>
  `tell application "System Events"\n` +
  `\tset targetProc to first application process whose unix id is ${pid}\n` +
  `\tset focAttr to value of attribute "AXFocusedUIElement" of targetProc\n` +
  `\tif focAttr is missing value then return ""\n` +
  `\ttry\n` +
  `\t\tset val to value of attribute "AXValue" of focAttr\n` +
  `\t\tif val is not missing value and val is not "" then return val\n` +
  `\tend try\n` +
  `\ttry\n` +
  `\t\tset charCount to value of attribute "AXNumberOfCharacters" of focAttr\n` +
  `\t\tif charCount is greater than 0 then\n` +
  `\t\t\treturn value of attribute "AXSelectedText" of focAttr\n` +
  `\t\tend if\n` +
  `\tend try\n` +
  `\treturn ""\n` +
  `end tell`;

class TextEditMonitor extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.currentOriginalText = null;
    this.timeout = null;
    this._pollInterval = null;
    this._lastValue = null;
    this._stdoutBuffer = "";
    this.lastTargetPid = null;
    this._axEnhancedPid = null;
    this._targetIsChromium = false;
  }

  /**
   * macOS: capture the active app's PID via NSWorkspace before the overlay steals focus.
   * Must be called at hotkey press time, BEFORE showDictationPanel()/mainWindow.show().
   * NSWorkspace.frontmostApplication correctly identifies the key window owner,
   * ignoring panel-type windows like the customWhispr overlay.
   *
   * Also detects whether the target app is Electron/Chromium-based so we can skip
   * AX monitoring (which triggers the blue accessibility focus ring in those apps).
   */
  captureTargetPid() {
    if (process.platform !== "darwin") return;
    this._targetIsChromium = false;
    const script = [
      'ObjC.import("AppKit");',
      'ObjC.import("Foundation");',
      "var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
      "var pid = app.processIdentifier;",
      "var url = app.bundleURL;",
      'var isChromium = false;',
      "if (url) {",
      "  var fm = $.NSFileManager.defaultManager;",
      '  var fwPath = url.URLByAppendingPathComponent("Contents/Frameworks");',
      '  isChromium = fm.fileExistsAtPath(fwPath.URLByAppendingPathComponent("Electron Framework.framework").path)',
      '    || fm.fileExistsAtPath(fwPath.URLByAppendingPathComponent("Chromium Embedded Framework.framework").path)',
      '    || fm.fileExistsAtPath(fwPath.URLByAppendingPathComponent("Google Chrome Framework.framework").path);',
      "}",
      'JSON.stringify({ pid: pid, isChromium: isChromium });',
    ].join("\n");
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        this.lastTargetPid = null;
        this._targetIsChromium = false;
      } else {
        try {
          const info = JSON.parse(stdout.trim());
          const pid = parseInt(info.pid, 10);
          this.lastTargetPid = isNaN(pid) ? null : pid;
          this._targetIsChromium = !!info.isChromium;
        } catch {
          this.lastTargetPid = null;
          this._targetIsChromium = false;
        }
      }
      debugLogger.debug("[TextEditMonitor] Captured target PID", {
        pid: this.lastTargetPid,
        isChromium: this._targetIsChromium,
      });
    });
  }

  /**
   * Start monitoring the focused text field for edits after a paste.
   * Kills any existing monitor before starting a new one.
   * @param {string} originalText - The transcribed text that was pasted
   * @param {number} timeoutMs - How long to monitor (default 30s)
   */
  startMonitoring(originalText, timeoutMs = 30000, options = {}) {
    this.stopMonitoring();
    this.currentOriginalText = originalText;

    if (process.platform === "darwin") {
      // Skip monitoring for Electron/Chromium apps — AXObserver and AX queries
      // trigger their accessibility mode, causing a persistent blue focus ring.
      if (this._targetIsChromium) {
        debugLogger.debug("[TextEditMonitor] Skipping monitoring for Chromium app", {
          pid: options.targetPid,
        });
        this.currentOriginalText = null;
        return;
      }
      const resolved = this.resolveBinary();
      if (resolved) {
        this._startMacOSNative(originalText, timeoutMs, options.targetPid, resolved);
        return;
      }
      this._startMacOSPolling(originalText, timeoutMs, options.targetPid);
      return;
    }

    const resolved = this.resolveBinary();
    if (!resolved) {
      debugLogger.debug("[TextEditMonitor] No binary found for platform", {
        platform: process.platform,
      });
      this.currentOriginalText = null;
      return;
    }

    const { command, args } = resolved;
    debugLogger.debug("[TextEditMonitor] Resolved binary", { command, args });

    // For native binaries, verify executable permission
    if (command !== "python3") {
      try {
        fs.accessSync(command, fs.constants.X_OK);
      } catch {
        debugLogger.debug("[TextEditMonitor] Binary not executable", { command });
        this.currentOriginalText = null;
        return;
      }
    }

    debugLogger.debug("[TextEditMonitor] Spawning monitor", {
      textPreview: originalText.substring(0, 80),
    });

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send original text via stdin
    this.process.stdin.write(originalText + "\n");
    this.process.stdin.end();

    this._stdoutBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      debugLogger.debug("[TextEditMonitor] stdout", { data: chunk.trim() });
      this._handleProcessStdoutChunk(chunk);
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      debugLogger.debug("[TextEditMonitor] stderr", { data: data.trim() });
    });

    this.process.on("error", (err) => {
      debugLogger.debug("[TextEditMonitor] Process error", { error: err.message });
      this.process = null;
    });

    this.process.on("exit", (code, signal) => {
      debugLogger.debug("[TextEditMonitor] Process exited", { code, signal });
      this.process = null;
    });

    // Safety net timeout (binary also self-exits after its own timeout)
    this.timeout = setTimeout(() => this.stopMonitoring(), timeoutMs);
  }

  stopMonitoring() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    this._lastValue = null;
    this._stdoutBuffer = "";
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // ignore
      }
      this.process = null;
    }
    this.currentOriginalText = null;
    if (process.platform === "darwin" && this._axEnhancedPid) {
      this._resetAccessibility(this._axEnhancedPid);
      this._axEnhancedPid = null;
    }
  }

  _handleProcessStdoutChunk(chunk) {
    this._stdoutBuffer += chunk;
    const lines = this._stdoutBuffer.split(/\r?\n/);
    this._stdoutBuffer = lines.pop() || "";

    for (const rawLine of lines) {
      if (!rawLine) continue;
      this._handleProcessLine(rawLine);
    }
  }

  _decodeBase64Payload(encoded) {
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch (error) {
      debugLogger.debug("[TextEditMonitor] Failed to decode base64 payload", {
        error: error.message,
      });
      return null;
    }
  }

  _emitTextEdited(newFieldValue) {
    if (typeof newFieldValue !== "string" || this.currentOriginalText === null) {
      return;
    }

    debugLogger.debug("[TextEditMonitor] Text changed", {
      newFieldValue: newFieldValue.substring(0, 80),
    });
    this.emit("text-edited", {
      originalText: this.currentOriginalText,
      newFieldValue,
    });
  }

  _handleProcessLine(line) {
    if (line.startsWith("CHANGED_B64:")) {
      const decoded = this._decodeBase64Payload(line.slice("CHANGED_B64:".length));
      if (decoded !== null) {
        this._emitTextEdited(decoded);
      }
      return;
    }

    if (line.startsWith("CHANGED:")) {
      this._emitTextEdited(line.slice("CHANGED:".length));
      return;
    }

    if (line === "NO_ELEMENT" || line === "NO_VALUE") {
      debugLogger.debug("[TextEditMonitor] No target element", { status: line });
      this.stopMonitoring();
    }
  }

  /**
   * macOS: tell the target app that an assistive technology is present.
   * This causes Chromium/Electron apps to build their accessibility tree.
   * Tracks the PID so we can reset it in stopMonitoring().
   */
  _enableAccessibility(pid) {
    // Disabled: setting AXEnhancedUserInterface causes Chromium/Electron apps
    // (Claude Desktop, Chrome, VS Code, Slack) to show a blue accessibility
    // focus ring that persists until the app restarts. Auto-learn won't work
    // for these apps, but native apps (TextEdit, Pages) don't need this.
    this._axEnhancedPid = null;
    return Promise.resolve();
  }

  /**
   * macOS: reset AXEnhancedUserInterface on the target app after monitoring.
   * Chromium-based apps (Chrome, Electron) enter screen-reader mode when this
   * attribute is set to true, and stay in that mode indefinitely. In screen-reader
   * mode Chromium routes keyboard focus to new windows as they appear, which causes
   * our overlay to steal focus from the target app on subsequent hotkey presses.
   * Resetting to false restores normal focus behaviour.
   */
  _resetAccessibility(pid) {
    const script =
      `tell application "System Events"\n` +
      `\tset targetProc to first application process whose unix id is ${pid}\n` +
      `\ttry\n` +
      `\t\tset value of attribute "AXEnhancedUserInterface" of targetProc to false\n` +
      `\tend try\n` +
      `end tell`;
    execFile("osascript", ["-e", script], { timeout: 2000 }, (err) => {
      if (err) {
        debugLogger.debug("[TextEditMonitor] macOS: AXEnhancedUserInterface reset failed", {
          error: err.message,
        });
      } else {
        debugLogger.debug("[TextEditMonitor] macOS: AXEnhancedUserInterface reset", { pid });
      }
    });
  }

  /**
   * macOS: use the native Swift AXObserver binary for event-based text monitoring.
   * Falls back to osascript polling if the binary fails to start.
   */
  async _startMacOSNative(originalText, timeoutMs, targetPid, resolved) {
    if (!targetPid) {
      debugLogger.debug("[TextEditMonitor] macOS native: no target PID");
      this.stopMonitoring();
      return;
    }

    debugLogger.debug("[TextEditMonitor] macOS native: starting", {
      targetPid,
      textPreview: originalText.substring(0, 80),
    });

    await this._enableAccessibility(targetPid);
    if (this.currentOriginalText === null) return;

    await new Promise((r) => setTimeout(r, INITIAL_QUERY_DELAY_MS));
    if (this.currentOriginalText === null) return;

    const { command, args } = resolved;

    try {
      fs.accessSync(command, fs.constants.X_OK);
    } catch {
      debugLogger.debug(
        "[TextEditMonitor] macOS native: binary not executable, falling back to polling",
        { command }
      );
      this._startMacOSPolling(originalText, timeoutMs, targetPid);
      return;
    }

    this.process = spawn(command, [...args, String(targetPid)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdin.write(originalText + "\n");
    this.process.stdin.end();

    this._stdoutBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      debugLogger.debug("[TextEditMonitor] stdout", { data: chunk.trim() });
      this._handleProcessStdoutChunk(chunk);
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      debugLogger.debug("[TextEditMonitor] stderr", { data: data.trim() });
    });

    this.process.on("error", (err) => {
      debugLogger.debug("[TextEditMonitor] macOS native: process error, falling back to polling", {
        error: err.message,
      });
      this.process = null;
      if (this.currentOriginalText === null) return;
      this._startMacOSPolling(originalText, timeoutMs, targetPid);
    });

    this.process.on("exit", (code, signal) => {
      debugLogger.debug("[TextEditMonitor] Process exited", { code, signal });
      this.process = null;
    });

    this.timeout = setTimeout(() => this.stopMonitoring(), timeoutMs);
  }

  /**
   * macOS: query the focused text field value via osascript for a specific app PID.
   * Returns the field value string, or null on error.
   */
  _queryMacOSValue(pid) {
    return new Promise((resolve) => {
      const script = MACOS_AX_SCRIPT_BY_PID(pid);
      execFile("osascript", ["-e", script], { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          resolve(stdout.replace(/\n$/, ""));
        }
      });
    });
  }

  /**
   * macOS: poll the focused text field for changes using osascript.
   * Uses Apple-signed osascript binary which inherits accessibility trust.
   * @param {string} originalText - The pasted text
   * @param {number} timeoutMs - Monitoring timeout
   * @param {number|null} targetPid - PID of the app that received the paste
   */
  _startMacOSPolling(originalText, timeoutMs, targetPid) {
    if (!targetPid) {
      debugLogger.debug("[TextEditMonitor] macOS: no target PID");
      this.stopMonitoring();
      return;
    }

    debugLogger.debug("[TextEditMonitor] macOS: starting osascript polling", {
      targetPid,
      textPreview: originalText.substring(0, 80),
    });

    // Enable accessibility on the target app first (needed for Chromium/Electron apps),
    // then delay before querying to let the paste keystroke be processed.
    this._enableAccessibility(targetPid).then(() => {
      if (this.currentOriginalText === null) return; // guard against stopMonitoring()
      setTimeout(
        () => this._queryInitialValue(targetPid, originalText, timeoutMs),
        INITIAL_QUERY_DELAY_MS
      );
    });
  }

  /**
   * Query the initial AXValue with retries. The target app may not have processed
   * the pasted text yet, so an empty value is retried a few times before giving up.
   */
  async _queryInitialValue(targetPid, originalText, timeoutMs, attempt = 1) {
    // Guard against stopMonitoring() being called while we waited
    if (this.currentOriginalText === null) return;

    const initialValue = await this._queryMacOSValue(targetPid);
    if (this.currentOriginalText === null) return;

    if (initialValue === null) {
      debugLogger.debug("[TextEditMonitor] macOS: no focused element");
      this.stopMonitoring();
      return;
    }

    if (!initialValue) {
      if (attempt < INITIAL_QUERY_RETRIES) {
        debugLogger.debug("[TextEditMonitor] macOS: AXValue empty, retrying", {
          attempt,
          maxRetries: INITIAL_QUERY_RETRIES,
        });
        setTimeout(
          () => this._queryInitialValue(targetPid, originalText, timeoutMs, attempt + 1),
          INITIAL_QUERY_RETRY_DELAY_MS
        );
        return;
      }
      debugLogger.debug("[TextEditMonitor] macOS: no text value after retries");
      this.stopMonitoring();
      return;
    }

    this._lastValue = initialValue;
    debugLogger.debug("[TextEditMonitor] macOS: initial value", {
      valuePreview: initialValue.substring(0, 80),
      attempt,
    });

    this._pollInterval = setInterval(async () => {
      const currentValue = await this._queryMacOSValue(targetPid);
      // Guard against stopMonitoring() being called during the query
      if (this.currentOriginalText === null) return;

      if (currentValue === null) {
        debugLogger.debug("[TextEditMonitor] macOS: lost focused element");
        this.stopMonitoring();
        return;
      }

      if (currentValue !== this._lastValue) {
        this._lastValue = currentValue;
        debugLogger.debug("[TextEditMonitor] macOS: text changed", {
          newValuePreview: currentValue.substring(0, 80),
        });
        this.emit("text-edited", {
          originalText: this.currentOriginalText,
          newFieldValue: currentValue,
        });
      }
    }, POLL_INTERVAL_MS);

    this.timeout = setTimeout(() => this.stopMonitoring(), timeoutMs);
  }

  /**
   * Resolve the platform-specific binary.
   * Returns { command, args } or null if unavailable.
   */
  resolveBinary() {
    const platform = process.platform;

    if (platform === "linux") {
      const nativePath = this._findFile("linux-text-monitor");
      if (nativePath) return { command: nativePath, args: [] };
      const scriptPath = this._findFile("linux-text-monitor.py");
      return scriptPath ? { command: "python3", args: [scriptPath] } : null;
    }

    if (platform === "win32") {
      const binaryPath = this._findFile("windows-text-monitor.exe");
      return binaryPath ? { command: binaryPath, args: [] } : null;
    }

    if (platform === "darwin") {
      const nativePath = this._findFile("macos-text-monitor");
      if (nativePath) return { command: nativePath, args: [] }; // PID added at spawn time
      return null;
    }

    return null;
  }

  _findFile(fileName) {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", fileName),
      path.join(__dirname, "..", "..", "resources", fileName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, fileName),
        path.join(process.resourcesPath, "bin", fileName),
        path.join(process.resourcesPath, "resources", fileName),
        path.join(process.resourcesPath, "resources", "bin", fileName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", fileName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", fileName),
      ].forEach((c) => candidates.add(c));
    }

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = TextEditMonitor;
