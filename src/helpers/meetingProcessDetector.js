const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const processListCache = require("./processListCache");

const POLL_INTERVAL_MS = 10 * 1000; // 10s for responsive meeting detection

// macOS: Subprocesses that indicate an active meeting (not just app open)
// These processes are spawned ONLY when a meeting/call is active
const DARWIN_MEETING_PROCESSES = [
  // Zoom: cpthost and aomhost only run during an active meeting. caphost runs at idle.
  { processName: "cpthost", processKey: "zoom", appName: "Zoom" },
  { processName: "aomhost", processKey: "zoom", appName: "Zoom" },
  { processName: "zoom shareagent", processKey: "zoom", appName: "Zoom" },
  
  // Other apps
  { processName: "ms-teams_modulehost", processKey: "teams", appName: "Microsoft Teams" },
  { processName: "meetingmanager", processKey: "webex", appName: "Webex" },
  // FaceTime: no reliable in-call-only subprocess exists (facetimemessagestored runs constantly
  // as a system daemon and matches "facetime"). FaceTime calls are detected via mic activity instead.
];

// Windows/Linux: Main process names (same approach as before)
const MEETING_APPS = {
  win32: [
    { processKey: "zoom", appName: "Zoom", imageName: "cpthost.exe" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "ms-teams_modulehost.exe" },
    { processKey: "webex", appName: "Webex", imageName: "webexmeetingsapp.exe" },
  ],
  linux: [
    { processKey: "zoom", appName: "Zoom", imageName: "zoom" },
    { processKey: "teams", appName: "Microsoft Teams", imageName: "teams" },
  ],
};

const APP_NAMES = {
  zoom: "Zoom",
  teams: "Microsoft Teams",
  webex: "Webex",
};

class MeetingProcessDetector extends EventEmitter {
  constructor() {
    super();
    this.pollInterval = null;
    this.detectedProcesses = new Map();
    this.dismissedProcesses = new Map();
    this.DISMISS_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
    this._polling = false;
  }

  start() {
    if (this.pollInterval) return;

    const mode = process.platform === "darwin" ? "subprocess-poll" : "process-poll";
    const monitored = process.platform === "darwin"
      ? DARWIN_MEETING_PROCESSES.map((p) => `${p.appName} (${p.processName})`)
      : (MEETING_APPS[process.platform] || []).map((a) => a.appName);

    debugLogger.info(
      "Process detector started",
      {
        platform: process.platform,
        mode,
        monitored,
        intervalMs: POLL_INTERVAL_MS,
      },
      "meeting"
    );

    this._poll();
    this.pollInterval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.detectedProcesses.clear();
    debugLogger.info("Stopped meeting process detector", {}, "meeting");
  }

  dismiss(processKey) {
    this.dismissedProcesses.set(processKey, Date.now());
    debugLogger.info("Process detection dismissed", { processKey }, "meeting");
  }

  clearDismiss(processKey) {
    this.dismissedProcesses.delete(processKey);
    debugLogger.debug("Process dismiss cleared", { processKey }, "meeting");
  }

  resetProcess(processKey) {
    this.detectedProcesses.delete(processKey);
    this.dismissedProcesses.delete(processKey);
    debugLogger.info("Process state fully reset for re-detection", { processKey }, "meeting");
  }

  _isDismissed(processKey) {
    if (!this.dismissedProcesses.has(processKey)) return false;
    const dismissedAt = this.dismissedProcesses.get(processKey);
    if (Date.now() - dismissedAt > this.DISMISS_TTL_MS) {
      this.dismissedProcesses.delete(processKey);
      return false;
    }
    return true;
  }

  getDetectedProcesses() {
    return Array.from(this.detectedProcesses.entries()).map(([processKey, { detectedAt }]) => ({
      processKey,
      appName: APP_NAMES[processKey] || processKey,
      detectedAt,
    }));
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const processList = await processListCache.getProcessList();

      if (process.platform === "darwin") {
        this._pollDarwin(processList);
      } else {
        this._pollGeneric(processList);
      }
    } catch (err) {
      debugLogger.warn("Poll error", { error: err.message }, "meeting");
    } finally {
      this._polling = false;
    }
  }

  _pollDarwin(processList) {
    // Track which process keys have an active meeting subprocess
    const activeKeys = new Set();

    for (const { processName, processKey, appName } of DARWIN_MEETING_PROCESSES) {
      const isRunning = processList.some(
        (p) => p === processName || p.includes(processName)
      );

      if (isRunning) {
        activeKeys.add(processKey);

        if (!this.detectedProcesses.has(processKey) && !this._isDismissed(processKey)) {
          const detectedAt = Date.now();
          this.detectedProcesses.set(processKey, { detectedAt });
          debugLogger.info(
            "Meeting subprocess detected",
            { processKey, appName, matchedProcess: processName },
            "meeting"
          );
          this.emit("meeting-process-detected", { processKey, appName, detectedAt });
        }
      }
    }

    // Emit ended for any previously detected process that no longer has active subprocesses
    // E.g. when cpthost exits, the meeting has ended
    for (const [processKey] of this.detectedProcesses) {
      if (!activeKeys.has(processKey)) {
        const appName = APP_NAMES[processKey] || processKey;
        this.detectedProcesses.delete(processKey);
        
        // Critical: auto-clear dismiss when the meeting ends! 
        // This ensures the next meeting triggers a new notification even if the app stays open.
        this.clearDismiss(processKey);
        
        debugLogger.info("Meeting subprocess ended", { processKey, appName }, "meeting");
        this.emit("meeting-process-ended", { processKey, appName });
      }
    }
  }

  _pollGeneric(processList) {
    const apps = MEETING_APPS[process.platform] || [];
    for (const { processKey, appName, imageName } of apps) {
      const isRunning = processList.includes(imageName);
      this._updateDetection(processKey, appName, isRunning);
    }
  }

  _updateDetection(processKey, appName, isRunning) {
    if (isRunning) {
      if (!this.detectedProcesses.has(processKey) && !this._isDismissed(processKey)) {
        const detectedAt = Date.now();
        this.detectedProcesses.set(processKey, { detectedAt });
        debugLogger.info("Meeting process detected", { processKey, appName }, "meeting");
        this.emit("meeting-process-detected", { processKey, appName, detectedAt });
      }
    } else if (this.detectedProcesses.has(processKey)) {
      this.detectedProcesses.delete(processKey);
      this.clearDismiss(processKey); // clear dismiss when meeting ends
      debugLogger.info("Meeting process ended", { processKey, appName }, "meeting");
      this.emit("meeting-process-ended", { processKey, appName });
    }
  }
}

module.exports = MeetingProcessDetector;
