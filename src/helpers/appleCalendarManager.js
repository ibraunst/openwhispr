const { execFile } = require("child_process");
const { BrowserWindow, Notification } = require("electron");
const debugLogger = require("./debugLogger");

const SYNC_INTERVAL_MS = 2 * 60 * 1000;

class AppleCalendarManager {
  constructor(databaseManager, windowManager) {
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
    this.connected = false;
    this.syncInterval = null;
    this.nextMeetingTimer = null;
    this.meetingEndTimer = null;
    this.activeMeeting = null;
    this.notifiedMeetings = new Set();
    this._lastFocusSync = 0;
  }

  start() {
    if (process.platform !== "darwin") return;
    this.connected = true;
    this.syncEvents()
      .then(() => this.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Initial Apple Calendar sync failed", { error: err.message }, "acal")
      );
    this._startSyncInterval();
  }

  stop() {
    this.connected = false;
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
    this.activeMeeting = null;
  }

  isConnected() {
    return this.connected && process.platform === "darwin";
  }

  getConnectionStatus() {
    return { connected: this.connected };
  }

  async connect() {
    // Triggers the macOS Calendar privacy permission prompt
    await this._runAppleScript(`tell application "Calendar" to get name of every calendar`);
    this.connected = true;
    this.start();
    this._broadcastStatusChanged();
    return { success: true };
  }

  disconnect() {
    this.stop();
    try {
      this.databaseManager.clearEventsByCalendarId("__apple__");
    } catch (err) {
      debugLogger.error(
        "Apple Calendar disconnect: failed to clear events",
        { error: err.message },
        "acal"
      );
    }
    this.notifiedMeetings.clear();
    this._broadcastStatusChanged();
  }

  async syncEvents() {
    if (!this.isConnected()) return;

    const script = `
      set output to ""
      set gmtOffset to time to GMT
      set epochRef to (date "Thursday, January 1, 1970 at 12:00:00 AM")
      set nowDate to current date
      set futureDate to nowDate + (7 * 24 * 3600)
      tell application "Calendar"
        repeat with c in (every calendar)
          try
            set evts to every event of c whose start date >= nowDate and start date <= futureDate
            repeat with e in evts
              try
                set eTitle to summary of e
                set eUID to uid of e
                set eStart to ((start date of e) - epochRef - gmtOffset) as integer
                set eEnd to ((end date of e) - epochRef - gmtOffset) as integer
                set isAllDay to allday event of e
                set output to output & eUID & "|" & eTitle & "|" & eStart & "|" & eEnd & "|" & isAllDay & "||"
              end try
            end repeat
          end try
        end repeat
      end tell
      return output
    `;

    try {
      const result = await this._runAppleScript(script);
      const events = this._parseEvents(result);
      if (events.length > 0) {
        this.databaseManager.upsertCalendarEvents(events);
      }
      debugLogger.debug("Apple Calendar synced", { count: events.length }, "acal");
      this.broadcastToWindows("acal-events-synced", {});
    } catch (err) {
      debugLogger.error("Apple Calendar sync failed", { error: err.message }, "acal");
      throw err;
    }
  }

  _parseEvents(output) {
    if (!output || !output.trim()) return [];
    return output
      .split("||")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        if (parts.length < 5) return null;
        const [uid, title, startTs, endTs, allDay] = parts;
        if (!uid || !startTs) return null;
        const startMs = parseInt(startTs, 10) * 1000;
        const endMs = parseInt(endTs, 10) * 1000;
        if (isNaN(startMs) || isNaN(endMs)) return null;
        return {
          id: `acal-${uid}`,
          calendar_id: "__apple__",
          summary: title || "Event",
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString(),
          is_all_day: allDay === "true" ? 1 : 0,
          status: "confirmed",
          hangout_link: null,
          conference_data: null,
          organizer_email: null,
          attendees_count: 0,
        };
      })
      .filter(Boolean);
  }

  scheduleNextMeeting() {
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }
    const upcoming = this.databaseManager.getUpcomingEvents(1440);
    const applePending = upcoming.filter(
      (e) => e.calendar_id === "__apple__" && !this.notifiedMeetings.has(e.id) && !e.is_all_day
    );
    if (applePending.length === 0) return;
    const next = applePending[0];
    const delay = new Date(next.start_time).getTime() - Date.now();
    if (delay <= 0) {
      this.onMeetingStart(next);
      return;
    }
    this.nextMeetingTimer = setTimeout(() => this.onMeetingStart(next), delay);
  }

  onMeetingStart(event) {
    this.activeMeeting = event;
    this.notifiedMeetings.add(event.id);
    const notif = new Notification({
      title: event.summary || "Meeting",
      body: "Meeting starting now",
    });
    notif.on("click", () => this.broadcastToWindows("acal-start-recording", { event }));
    notif.show();
    this.broadcastToWindows("acal-meeting-starting", { event });
    if (this.meetingEndTimer) clearTimeout(this.meetingEndTimer);
    const endDelay = new Date(event.end_time).getTime() - Date.now();
    if (endDelay > 0) {
      this.meetingEndTimer = setTimeout(() => this.onMeetingEnd(), endDelay);
    }
    this.scheduleNextMeeting();
  }

  onMeetingEnd() {
    this.broadcastToWindows("acal-meeting-ended", { event: this.activeMeeting });
    this.activeMeeting = null;
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
    this.scheduleNextMeeting();
  }

  onWakeFromSleep() {
    if (!this.isConnected()) return;
    try {
      const activeEvents = this.databaseManager.getActiveEvents();
      const appleActive = activeEvents.filter((e) => e.calendar_id === "__apple__");
      if (appleActive.length > 0 && !this.activeMeeting) {
        this.onMeetingStart(appleActive[0]);
      }
    } catch (err) {
      debugLogger.error("Post-wake active events check failed", { error: err.message }, "acal");
    }
    this.scheduleNextMeeting();
    this.syncEvents().catch((err) =>
      debugLogger.error("Post-wake Apple Calendar sync failed", { error: err.message }, "acal")
    );
  }

  syncOnFocus() {
    if (!this.isConnected()) return;
    const now = Date.now();
    if (now - this._lastFocusSync < 30000) return;
    this._lastFocusSync = now;
    this.syncEvents()
      .then(() => this.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Focus Apple Calendar sync failed", { error: err.message }, "acal")
      );
  }

  getActiveMeetingState() {
    return {
      activeMeeting: this.activeMeeting,
      activeEvents: (() => {
        try {
          return this.databaseManager
            .getActiveEvents()
            .filter((e) => e.calendar_id === "__apple__");
        } catch {
          return [];
        }
      })(),
      upcomingEvents: (() => {
        try {
          return this.databaseManager
            .getUpcomingEvents(15)
            .filter((e) => e.calendar_id === "__apple__");
        } catch {
          return [];
        }
      })(),
    };
  }

  async getUpcomingEvents(windowMinutes) {
    try {
      const all = this.databaseManager.getUpcomingEvents(windowMinutes);
      return all.filter((e) => e.calendar_id === "__apple__");
    } catch (err) {
      debugLogger.error("getUpcomingEvents failed", { error: err.message }, "acal");
      return [];
    }
  }

  _runAppleScript(script) {
    return new Promise((resolve, reject) => {
      execFile("osascript", ["-e", script], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  _startSyncInterval() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = setInterval(() => {
      this.syncEvents()
        .then(() => this.scheduleNextMeeting())
        .catch((err) =>
          debugLogger.error(
            "Apple Calendar interval sync failed",
            { error: err.message },
            "acal"
          )
        );
    }, SYNC_INTERVAL_MS);
  }

  _broadcastStatusChanged() {
    this.broadcastToWindows("acal-connection-changed", { connected: this.connected });
  }

  broadcastToWindows(channel, data) {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send(channel, data);
    });
  }
}

module.exports = AppleCalendarManager;
