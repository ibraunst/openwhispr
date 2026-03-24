const { execFile } = require("child_process");
const path = require("path");
const { app, BrowserWindow, Notification } = require("electron");
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
    // Fetch and persist available calendars
    try {
      await this.fetchAndStoreCalendars();
    } catch (err) {
      debugLogger.error("Failed to fetch calendars on connect", { error: err.message }, "acal");
    }
    this.start();
    this._broadcastStatusChanged();
    return { success: true };
  }

  async fetchAndStoreCalendars() {
    const getResourcePath = () => {
      if (app.isPackaged) {
        return path.join(process.resourcesPath, "bin");
      }
      return path.join(app.getAppPath(), "resources", "bin");
    };
    const binaryPath = path.join(getResourcePath(), "calendar-sync-mac");
    const escapedPath = binaryPath.replace(/"/g, '\\"');
    const script = `do shell script "\\"${escapedPath}\\" --list-calendars"`;
    const result = await this._runAppleScript(script);
    if (!result || !result.trim()) return [];
    const calendars = JSON.parse(result);
    if (Array.isArray(calendars) && calendars.length > 0) {
      this.databaseManager.upsertAppleCalendars(calendars);
    }
    return this.databaseManager.getAppleCalendars();
  }

  getCalendars() {
    return this.databaseManager.getAppleCalendars();
  }

  setCalendarSelected(calendarId, isSelected) {
    const result = this.databaseManager.updateAppleCalendarSelection(calendarId, isSelected);
    // Re-sync events so the upcoming meetings view reflects the new filter
    this.syncEvents()
      .then(() => this.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Post-selection Apple Calendar sync failed", { error: err.message }, "acal")
      );
    return result;
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

    try {
      const getResourcePath = () => {
        if (app.isPackaged) {
          return path.join(process.resourcesPath, "bin");
        }
        return path.join(app.getAppPath(), "resources", "bin");
      };

      const binaryPath = path.join(getResourcePath(), "calendar-sync-mac");
      
      const escapedPath = binaryPath.replace(/"/g, '\\"');
      const script = `do shell script "\\"${escapedPath}\\" 14"`;
      const result = await this._runAppleScript(script);

      const allEvents = this._parseEvents(result);
      // Filter by selected calendars
      const selectedCalIds = new Set(
        this.databaseManager.getSelectedAppleCalendars().map((c) => c.id)
      );
      const events = selectedCalIds.size > 0
        ? allEvents.filter((e) => {
            const calId = e._appleCalendarId;
            return !calId || selectedCalIds.has(calId);
          })
        : allEvents;
      // Strip internal field before storing
      for (const e of events) delete e._appleCalendarId;
      // Clear future apple events and replace with filtered set (preserves past events)
      this.databaseManager.clearFutureEventsByCalendarId("__apple__");
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
    try {
      const parsed = JSON.parse(output);
      if (parsed.error) {
         throw new Error(parsed.error);
      }
      
      // Auto-upsert discovered calendars from event data
      const calMap = new Map();
      for (const e of parsed) {
        if (e.calendarId && !calMap.has(e.calendarId)) {
          calMap.set(e.calendarId, { id: e.calendarId, title: e.calendarTitle || "Unknown", color: e.calendarColor || null });
        }
      }
      if (calMap.size > 0) {
        try {
          this.databaseManager.upsertAppleCalendars([...calMap.values()]);
        } catch (err) {
          debugLogger.error("Failed to upsert calendars from events", { error: err.message }, "acal");
        }
      }

      return parsed.map((e) => {
        const meetingUrl = this._extractMeetingUrl(e.url, e.location, e.notes);

        // Pass JSON fields through as strings for SQL storage
        let attendeesJson = null;
        if (e.attendees && e.attendees.length > 0) {
           attendeesJson = JSON.stringify(e.attendees);
        }

        return {
          id: `acal-${e.uid}`,
          calendar_id: "__apple__",
          _appleCalendarId: e.calendarId || null,
          summary: e.title || "Event",
          start_time: new Date(e.startTimestamp).toISOString(),
          end_time: new Date(e.endTimestamp).toISOString(),
          is_all_day: e.isAllDay ? 1 : 0,
          status: "confirmed",
          hangout_link: meetingUrl,
          conference_data: JSON.stringify({
             isPrivate: e.isPrivate,
             attendees: attendeesJson,
             attendeesCount: e.attendeesCount
          }),
          organizer_email: e.organizerEmail || null,
          attendees_count: e.attendeesCount || 0,
          attendees: attendeesJson,
        };
      }).filter(Boolean);
    } catch (err) {
      debugLogger.error("Failed to parse EventKit JSON array", { error: err.message, outputPrefix: output.substring(0, 100) }, "acal");
      return [];
    }
  }

  _extractMeetingUrl(url, location, notes) {
    // Check direct URL field first
    if (url && /https?:\/\//.test(url)) {
      if (/zoom\.us|teams\.microsoft|meet\.google|webex/i.test(url)) return url;
    }
    // Check location and notes for meeting URLs
    for (const text of [location, notes]) {
      if (!text) continue;
      const match = text.match(/https?:\/\/[^\s"<>]+(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|webex\.com)[^\s"<>]*/i);
      if (match) return match[0];
    }
    // Broader check: any zoom URL in any field
    for (const text of [url, location, notes]) {
      if (!text) continue;
      const match = text.match(/https?:\/\/[^\s"<>]*zoom\.us[^\s"<>]*/i);
      if (match) return match[0];
    }
    return null;
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
    const PRE_MEETING_LEAD_MS = 60 * 1000;
    const delay = new Date(next.start_time).getTime() - Date.now() - PRE_MEETING_LEAD_MS;
    if (delay <= 0) {
      this.onMeetingStart(next);
      return;
    }
    this.nextMeetingTimer = setTimeout(() => this.onMeetingStart(next), delay);
  }

  onMeetingStart(event) {
    this.activeMeeting = event;
    this.notifiedMeetings.add(event.id);

    const detectionPrefs = this.meetingDetectionEngine?.getPreferences?.();
    const notificationsEnabled =
      !detectionPrefs || detectionPrefs.processDetection || detectionPrefs.audioDetection;

    if (notificationsEnabled) {
      const notif = new Notification({
        title: event.summary || "Meeting",
        body: "Meeting starting in 1 minute",
      });
      notif.on("click", () => this.broadcastToWindows("acal-start-recording", { event }));
      notif.show();
    }
    this.broadcastToWindows("acal-meeting-starting", { event });
    this.meetingDetectionEngine?.handleCalendarAlert?.(event);
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
    const activeEvts = (() => {
      try {
        return this.databaseManager
          .getActiveEvents()
          .filter((e) => e.calendar_id === "__apple__");
      } catch {
        return [];
      }
    })();
    return {
      activeMeeting: this.activeMeeting || (activeEvts.length > 0 ? activeEvts[0] : null),
      activeEvents: activeEvts,
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
