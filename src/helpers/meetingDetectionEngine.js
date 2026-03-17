const { BrowserWindow, shell } = require("electron");
const debugLogger = require("./debugLogger");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;

function extractMeetingUrl(event) {
  if (event?.hangout_link) return event.hangout_link;
  if (event?.conference_data) {
    try {
      const conf = typeof event.conference_data === "string"
        ? JSON.parse(event.conference_data)
        : event.conference_data;
      const videoEntry = conf?.entryPoints?.find((ep) => ep.entryPointType === "video");
      if (videoEntry?.uri) return videoEntry.uri;
    } catch {}
  }
  return null;
}

class MeetingDetectionEngine {
  constructor(
    googleCalendarManager,
    appleCalendarManager,
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    databaseManager
  ) {
    this.googleCalendarManager = googleCalendarManager;
    this.appleCalendarManager = appleCalendarManager;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true };
    this._loadPreferences();
    this._userRecording = false;
    this._notificationQueue = [];
    this._postRecordingCooldown = null;
    this._bindListeners();
  }

  _bindListeners() {
    this.meetingProcessDetector.on("meeting-process-detected", (data) => {
      this._handleDetection("process", data.processKey, data);
    });

    this.meetingProcessDetector.on("meeting-process-ended", (data) => {
      this.activeDetections.delete(`process:${data.processKey}`);
      // Clear dismiss so re-launching the app triggers a fresh detection
      this.meetingProcessDetector.clearDismiss(data.processKey);
      this.broadcastToWindows("meeting-process-ended", data);
      this._handleMeetingEndSignal(`${data.appName} closed`);
    });

    this.audioActivityDetector.on("sustained-audio-detected", (data) => {
      this._handleDetection("audio", "sustained-audio", data);
    });

    this.audioActivityDetector.on("sustained-silence-detected", () => {
      this._handleMeetingEndSignal("Audio went silent");
    });
  }

  _getCalendarState() {
    const gcal = this.googleCalendarManager?.getActiveMeetingState?.();
    const acal = this.appleCalendarManager?.getActiveMeetingState?.();
    const activeMeeting = gcal?.activeMeeting || acal?.activeMeeting;
    const upcomingEvents = [
      ...(gcal?.upcomingEvents || []),
      ...(acal?.upcomingEvents || []),
    ].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    if (!activeMeeting && upcomingEvents.length === 0) return null;
    return { activeMeeting, upcomingEvents };
  }

  _handleDetection(source, key, data) {
    const detectionId = `${source}:${key}`;

    if (source === "process" && !this.preferences.processDetection) {
      debugLogger.debug("Process detection disabled, ignoring", { detectionId }, "meeting");
      return;
    }
    if (source === "audio" && !this.preferences.audioDetection) {
      debugLogger.debug("Audio detection disabled, ignoring", { detectionId }, "meeting");
      return;
    }

    if (this.activeDetections.has(detectionId)) {
      debugLogger.debug("Detection already active, skipping", { detectionId }, "meeting");
      return;
    }

    const calendarState = this._getCalendarState();

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Detection queued — user is recording", { detectionId, source }, "meeting");
      this._notificationQueue.push({ source, key, data });
      this.activeDetections.set(detectionId, { source, key, data, dismissed: false });
      return;
    }

    let imminentEvent = null;
    if (calendarState?.activeMeeting) {
      imminentEvent = calendarState.activeMeeting;
    } else if (calendarState?.upcomingEvents?.length > 0) {
      const now = Date.now();
      imminentEvent = calendarState.upcomingEvents.find((evt) => {
        const start = new Date(evt.start_time).getTime();
        return start - now <= IMMINENT_THRESHOLD_MS && start > now;
      });
    }

    debugLogger.info(
      "Meeting detection triggered",
      { detectionId, source, imminentEvent: imminentEvent?.summary ?? null },
      "meeting"
    );
    this.activeDetections.set(detectionId, { source, key, data, dismissed: false });

    // Guard: if a notification is already visible, queue instead of showing a duplicate
    if (this._isNotificationVisible()) {
      debugLogger.info(
        "Notification already visible, queueing detection",
        { detectionId },
        "meeting"
      );
      this._notificationQueue.push({ source, key, data });
      return;
    }

    this._showPrompt(detectionId, source, key, data, imminentEvent);
  }

  _showPrompt(detectionId, source, key, data, imminentEvent) {
    let title, body;

    if (imminentEvent) {
      title = imminentEvent.summary || "Upcoming Meeting";
      const hasUrl = extractMeetingUrl(imminentEvent);
      // Only suggest "Join and record" if the source is calendar (user hasn't joined yet)
      body =
        source === "calendar" && hasUrl
          ? "Meeting starting soon. Join and start recording?"
          : "Meeting detected. Want to start recording?";
    } else if (source === "process") {
      title = `${data.appName} Meeting Detected`;
      body = "It looks like you're in a meeting. Want to take notes?";
    } else {
      title = "Meeting Detected";
      body = "It sounds like you're in a meeting. Want to take notes?";
    }

    debugLogger.info("Showing notification", { detectionId, title }, "meeting");

    let event;
    if (imminentEvent) {
      event = imminentEvent;
    } else {
      event = {
        id: `detected-${Date.now()}`,
        calendar_id: "__detected__",
        summary: data.appName ? `${data.appName} Meeting` : "New note",
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 3600000).toISOString(),
        is_all_day: 0,
        status: "confirmed",
        hangout_link: null,
        conference_data: null,
        organizer_email: null,
        attendees_count: 0,
      };
    }

    const detection = this.activeDetections.get(detectionId);
    if (detection) {
      detection.event = event;
    }

    this.windowManager.showMeetingNotification({
      detectionId,
      source,
      key,
      title,
      body,
      event,
    });

    this.broadcastToWindows("meeting-detected", {
      detectionId,
      source,
      data,
      imminentEvent,
    });
  }

  handleUserResponse(detectionId, action) {
    debugLogger.info("User response to detection", { detectionId, action }, "meeting");
    if (action === "dismiss") {
      const detection = this.activeDetections.get(detectionId);
      if (detection) {
        this._dismiss(detection.source, detection.key);
        detection.dismissed = true;
      }
    }
  }

  async handleNotificationResponse(detectionId, action) {
    debugLogger.info("Notification response", { detectionId, action }, "meeting");
    try {
      const detection = this.activeDetections.get(detectionId);

      if (action === "start" && detection) {
        const eventSummary = detection.event?.summary || "New note";

        // Open meeting URL only for calendar-triggered detections (user hasn't joined yet)
        const meetingUrl = detection.source === "calendar" ? extractMeetingUrl(detection.event) : null;
        if (meetingUrl) {
          debugLogger.info("Opening meeting URL", { url: meetingUrl }, "meeting");
          shell.openExternal(meetingUrl).catch((err) => {
            debugLogger.error("Failed to open meeting URL", { error: err.message }, "meeting");
          });
        }

        const noteResult = this.databaseManager.saveNote(eventSummary, "", "meeting", null, null, null, detection.event?.id || null);
        const meetingsFolder = this.databaseManager.getMeetingsFolder();

        if (noteResult?.note?.id && meetingsFolder?.id) {
          await this.windowManager.createControlPanelWindow();
          this.windowManager.snapControlPanelToMeetingMode();
          this.windowManager.sendToControlPanel("navigate-to-meeting-note", {
            noteId: noteResult.note.id,
            folderId: meetingsFolder.id,
            event: detection.event,
          });

          // CRITICAL: Actually start the recording!
          // This tells the frontend to record AND syncs back to us via
          // this.meetingDetectionEngine.setUserRecording(true) so we suppress new prompts.
          setTimeout(() => {
            this.windowManager.sendStartDictation();
          }, 500);
        }

        // Reset detection state so the same app can re-trigger on the next meeting
        this._resetDetectionState(detection);
      } else if (action === "dismiss") {
        if (detection) {
          this._dismiss(detection.source, detection.key);
          detection.dismissed = true;
          this.activeDetections.delete(detectionId);
        }
      }
    } finally {
      this.windowManager.dismissMeetingNotification();
      
      // If we dismissed or handled a notification, check if any blocked detections are waiting
      if (action === "dismiss") {
        setTimeout(() => this._flushNotificationQueue(), 1000);
      }
    }
  }

  handleCalendarAlert(event) {
    if (!event) return;

    const detectionId = `calendar:${event.id || Date.now()}`;

    if (this.activeDetections.has(detectionId)) {
      debugLogger.debug("Calendar alert already active, skipping", { detectionId }, "meeting");
      return;
    }

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Calendar alert queued — user is recording", { detectionId }, "meeting");
      this._notificationQueue.push({ source: "calendar", key: event.id, data: { event } });
      this.activeDetections.set(detectionId, { source: "calendar", key: event.id, data: { event }, dismissed: false });
      return;
    }

    debugLogger.info(
      "Calendar alert triggered",
      { detectionId, summary: event.summary },
      "meeting"
    );
    this.activeDetections.set(detectionId, { source: "calendar", key: event.id, data: { event }, dismissed: false });
    this._showPrompt(detectionId, "calendar", event.id, { event }, event);
  }

  _flushNotificationQueue() {
    if (this._notificationQueue.length === 0) return;

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Leaving queue alone because user is recording or on cooldown", {}, "meeting");
      return;
    }

    debugLogger.info(
      "Flushing notification queue",
      { count: this._notificationQueue.length },
      "meeting"
    );

    // Filter out stale detections that are no longer active
    this._notificationQueue = this._notificationQueue.filter(
      (item) => this.activeDetections.has(`${item.source}:${item.key}`)
    );

    if (this._notificationQueue.length === 0) return;

    const prioritized = this._notificationQueue.sort((a, b) => {
      const priority = { process: 1, audio: 2 };
      return (priority[a.source] || 0) - (priority[b.source] || 0);
    });

    const best = prioritized[0];
    const detectionId = `${best.source}:${best.key}`;

    const detection = this.activeDetections.get(detectionId);
    if (detection && !detection.dismissed) {
      const calendarState = this._getCalendarState();
      let imminentEvent = null;
      if (calendarState?.upcomingEvents?.length > 0) {
        const now = Date.now();
        imminentEvent = calendarState.upcomingEvents.find((evt) => {
          const start = new Date(evt.start_time).getTime();
          return start - now <= 5 * 60 * 1000 && start > now;
        });
      }

      if (imminentEvent) {
        this._showPrompt(detectionId, best.source, best.key, best.data, imminentEvent);
      } else {
        this._showPrompt(detectionId, best.source, best.key, best.data, null);
      }
    }

    // Rather than blindly clearing all, we just remove the one we showed
    this._notificationQueue = this._notificationQueue.filter((item) => item !== best);
  }

  _dismiss(source, key) {
    if (source === "process") {
      this.meetingProcessDetector.dismiss(key);
    } else if (source === "audio") {
      this.audioActivityDetector.dismiss();
    }
  }

  _resetDetectionState(detection) {
    const detectionId = `${detection.source}:${detection.key}`;
    this.activeDetections.delete(detectionId);

    // Clear process-level state so the same app can re-trigger
    if (detection.source === "process") {
      this.meetingProcessDetector.resetProcess(detection.key);
    } else if (detection.source === "audio") {
      this.audioActivityDetector.dismiss();
    }

    debugLogger.info("Detection state reset for re-detection", { detectionId }, "meeting");
  }

  setUserRecording(active) {
    this._userRecording = active;
    this.audioActivityDetector.setUserRecording(active);

    if (active) {
      if (this._postRecordingCooldown) {
        clearTimeout(this._postRecordingCooldown);
        this._postRecordingCooldown = null;
      }
      this._cancelAutoStop();
    } else {
      this._postRecordingCooldown = setTimeout(() => {
        this._postRecordingCooldown = null;
        this._flushNotificationQueue();
      }, 2500);
    }
  }

  setPreferences(prefs) {
    debugLogger.info("Updating detection preferences", prefs, "meeting");
    Object.assign(this.preferences, prefs);
    this._savePreferences();

    if (this.preferences.processDetection) {
      this.meetingProcessDetector.start();
    } else {
      this.meetingProcessDetector.stop();
    }

    if (this.preferences.audioDetection) {
      this.audioActivityDetector.start();
    } else {
      this.audioActivityDetector.stop();
    }
  }

  getPreferences() {
    return { ...this.preferences };
  }

  start() {
    debugLogger.info("Meeting detection engine started", this.preferences, "meeting");
    if (this.preferences.processDetection) this.meetingProcessDetector.start();
    if (this.preferences.audioDetection) this.audioActivityDetector.start();
  }

  stop() {
    debugLogger.info("Meeting detection engine stopped", {}, "meeting");
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.activeDetections.clear();
    if (this._postRecordingCooldown) {
      clearTimeout(this._postRecordingCooldown);
      this._postRecordingCooldown = null;
    }
    this._notificationQueue = [];
    this._cancelAutoStop();
  }

  _handleMeetingEndSignal(reason) {
    if (!this._userRecording) return;
    if (this._autoStopTimer) return;

    debugLogger.info("Auto-stopping meeting recording immediately", { reason }, "meeting");
    this.broadcastToWindows("meeting-auto-stop-execute", { reason });
  }

  cancelAutoStop() {
    this._cancelAutoStop();
    debugLogger.info("User cancelled auto-stop", {}, "meeting");
  }

  _cancelAutoStop() {
    if (this._autoStopTimer) {
      clearTimeout(this._autoStopTimer);
      this._autoStopTimer = null;
    }
  }

  _isNotificationVisible() {
    return (
      this.windowManager.notificationWindow &&
      !this.windowManager.notificationWindow.isDestroyed()
    );
  }


  _loadPreferences() {
    try {
      const saved = this.databaseManager.getSetting("meetingDetectionPrefs");
      if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(this.preferences, parsed);
        debugLogger.debug("Loaded detection preferences", this.preferences, "meeting");
      }
    } catch (err) {
      debugLogger.warn(
        "Failed to load detection preferences (using defaults)",
        { error: err?.message },
        "meeting"
      );
    }
  }

  _savePreferences() {
    try {
      this.databaseManager.setSetting(
        "meetingDetectionPrefs",
        JSON.stringify(this.preferences)
      );
    } catch (err) {
      debugLogger.warn(
        "Failed to save detection preferences",
        { error: err?.message },
        "meeting"
      );
    }
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }
}

module.exports = MeetingDetectionEngine;
