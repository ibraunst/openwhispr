// Local endpoint behind the Claude Cowork connector. Claude Desktop launches
// resources/coach-mcp/server.js (stdio MCP), which forwards tool calls here.
// Bound to 127.0.0.1 on a random port; every request must carry the bearer
// token from {userData}/coach-connector.json (user-only file). Writes are
// limited to meeting prep — nothing here edits or deletes transcripts.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Tool names/descriptions/schemas are shared with the stdio bridge, which
// must list them even when this app isn't running
const TOOL_DEFS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "coach-mcp", "tools.json")
  : path.join(__dirname, "..", "..", "resources", "coach-mcp", "tools.json");
const MAX_TRANSCRIPT_CHARS = 300000;
const CHECKLIST_KINDS = ["goal", "question", "fact", "objection"];
const STANCES = ["firm", "collaborative", "supportive", "persuasive", "custom"];

function normalizeDate(value) {
  if (!value) return null;
  const str = String(value);
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseAttendees(raw) {
  try {
    const list = JSON.parse(raw || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .map((a) => (a?.name ? (a.email ? `${a.name} <${a.email}>` : a.name) : a?.email))
      .filter(Boolean);
  } catch {
    return [];
  }
}

class ToolError extends Error {}

class CoachConnector {
  constructor({ databaseManager, meetingCoach, windowManager }) {
    this.db = databaseManager;
    this.coach = meetingCoach;
    this.windowManager = windowManager;
    this.server = null;
    this.token = null;
  }

  get infoPath() {
    return path.join(app.getPath("userData"), "coach-connector.json");
  }

  async start() {
    if (this.server) return;
    // Fail loudly in development if a shared definition has no handler
    const defs = JSON.parse(fs.readFileSync(TOOL_DEFS_PATH, "utf8"));
    const missing = defs.map((d) => d.name).filter((name) => !TOOLS[name]);
    if (missing.length) throw new Error(`Coach connector tools without handlers: ${missing.join(", ")}`);
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = this.server.address();
    const tmp = `${this.infoPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ port, token: this.token, pid: process.pid }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.infoPath);
    debugLogger.info("Coach connector listening", { port }, "coach");
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try {
      const info = JSON.parse(fs.readFileSync(this.infoPath, "utf8"));
      if (info.pid === process.pid) fs.unlinkSync(this.infoPath);
    } catch {}
  }

  _authorized(req) {
    const header = req.headers.authorization || "";
    const supplied = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(this.token || "");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  _handle(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/call") return send(404, { error: "Not found" });
    if (!this._authorized(req)) return send(401, { error: "Unauthorized" });

    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(413, { error: "Request too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(400, { error: "Invalid JSON" });
      }
      const tool = this.tools[payload.tool];
      if (!tool) return send(404, { error: `Unknown tool: ${payload.tool}` });
      try {
        const result = await tool.call(this, payload.args || {});
        send(200, { result });
      } catch (err) {
        if (!(err instanceof ToolError)) {
          debugLogger.error("Coach connector tool failed", { tool: payload.tool, error: err.message }, "coach");
        }
        send(200, { error: err.message });
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _noteSummary(note) {
    const prep = this.db.getCoachPrep(note.id);
    const session = this.db.getLatestCoachSession(note.id);
    return {
      note_id: note.id,
      title: note.title,
      created_at: normalizeDate(note.created_at),
      has_transcript: !!(note.transcript && note.transcript.trim()),
      has_prep: !!prep?.checklist?.length,
      coaching_enabled: !!prep?.enabled,
      has_coaching_summary: !!session?.summary,
    };
  }

  _resolveNote({ note_id, event_id }, { createForEvent = false } = {}) {
    if (note_id != null) {
      const note = this.db.getNote(Number(note_id));
      if (!note) throw new ToolError(`No note with id ${note_id}`);
      return { note, created: false };
    }
    if (!event_id) throw new ToolError("Pass note_id or event_id");
    const existing = this.db.getNoteByCalendarEventId(String(event_id));
    if (existing) return { note: existing, created: false };
    if (!createForEvent) throw new ToolError(`No note exists yet for event ${event_id}`);
    const event = this.db.getCalendarEventById(String(event_id));
    if (!event) throw new ToolError(`No calendar event with id ${event_id}`);
    const result = this.db.saveNote(event.summary || "Meeting", "", "meeting", null, null, null, event.id);
    const note = result?.note || this.db.getNoteByCalendarEventId(event.id);
    if (!note) throw new ToolError("Could not create the meeting note");
    return { note, created: true };
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  get tools() {
    return TOOLS;
  }
}

const TOOLS = {
  list_meetings: {
    async call(self, args) {
      const daysAhead = Math.min(30, Math.max(0, parseInt(args.days_ahead ?? 7, 10) || 0));
      const daysBack = Math.min(90, Math.max(0, parseInt(args.days_back ?? 14, 10) || 0));
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const q = query.toLowerCase();

      const events = self.db.getUpcomingEvents(daysAhead * 1440 || 60);
      const seen = new Set();
      const upcoming = [];
      for (const event of events) {
        // The same meeting often appears in several synced calendars
        const key = `${event.summary}|${event.start_time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (q && !(event.summary || "").toLowerCase().includes(q)) continue;
        const note = self.db.getNoteByCalendarEventId(event.id);
        upcoming.push({
          event_id: event.id,
          title: event.summary,
          start: normalizeDate(event.start_time),
          end: normalizeDate(event.end_time),
          attendees: parseAttendees(event.attendees),
          note: note ? self._noteSummary(note) : null,
        });
        if (upcoming.length >= 50) break;
      }

      const cutoff = Date.now() - daysBack * 86400000;
      let recentNotes;
      if (query) {
        recentNotes = self.db.searchNotes(query, 50);
      } else {
        recentNotes = self.db.getNotes("meeting", 200);
      }
      const recent = recentNotes
        .filter((n) => n.note_type === "meeting" || n.meeting_id || n.calendar_event_id)
        .filter((n) => (Date.parse(normalizeDate(n.created_at) || 0) || 0) >= cutoff || !!query)
        .slice(0, 40)
        .map((n) => self._noteSummary(n));

      return { upcoming, recent };
    },
  },

  get_meeting_prep: {
    async call(self, args) {
      const { note } = self._resolveNote(args);
      const prep = self.coach.getPrep(note.id);
      return {
        note_id: note.id,
        title: note.title,
        coaching_enabled: prep.enabled,
        stance: prep.stance,
        stance_custom: prep.stanceCustom || null,
        stance_reason: prep.stanceReason || null,
        coaching_level: prep.intensity || "default",
        checklist: prep.checklist.map(({ kind, text, detail }) => ({ kind, text, detail: detail || "" })),
        prep_sources: prep.sources.map((s) => ({ name: s.name, chars: s.chars })),
      };
    },
  },

  set_meeting_prep: {
    async call(self, args) {
      if (!Array.isArray(args.checklist) || args.checklist.length === 0) {
        throw new ToolError("checklist must be a non-empty array");
      }
      const checklist = args.checklist
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .slice(0, 20)
        .map((item, i) => ({
          id: `c${i + 1}`,
          kind: CHECKLIST_KINDS.includes(item.kind) ? item.kind : "goal",
          text: item.text.trim(),
          detail: typeof item.detail === "string" ? item.detail.trim() : "",
        }));
      if (!checklist.length) throw new ToolError("checklist items need text");
      if (args.stance && !STANCES.includes(args.stance)) {
        throw new ToolError(`stance must be one of ${STANCES.join(", ")}`);
      }

      const { note, created } = self._resolveNote(args, { createForEvent: true });
      if (typeof args.prep_text === "string" && args.prep_text.trim()) {
        self.coach.addPrepText(note.id, "From Claude", args.prep_text);
      }
      const patch = { checklist, enabled: args.enable !== false };
      if (args.stance) patch.stance = args.stance;
      if (typeof args.stance_custom === "string") patch.stanceCustom = args.stance_custom;
      if (args.intensity !== undefined) {
        if (!["light", "balanced", "active"].includes(args.intensity)) {
          throw new ToolError("intensity must be light, balanced or active");
        }
        patch.intensity = args.intensity;
      }
      const prep = self.coach.savePrep(note.id, patch);
      self.windowManager?.sendToControlPanel?.("coach-prep-updated", { noteId: note.id });
      debugLogger.info(
        "Coach prep set via connector",
        { noteId: note.id, created, items: checklist.length, stance: prep.stance },
        "coach"
      );
      return {
        note_id: note.id,
        title: note.title,
        created_note: created,
        coaching_enabled: prep.enabled,
        stance: prep.stance || "collaborative",
        coaching_level: prep.intensity || "default",
        checklist_count: prep.checklist.length,
      };
    },
  },

  get_meeting_transcript: {
    async call(self, args) {
      const { note } = self._resolveNote(args);
      const event = note.calendar_event_id ? self.db.getCalendarEventById(note.calendar_event_id) : null;
      const transcript = note.transcript || "";
      return {
        note_id: note.id,
        title: note.title,
        created_at: normalizeDate(note.created_at),
        meeting_start: normalizeDate(event?.start_time),
        attendees: parseAttendees(event?.attendees),
        transcript: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
        transcript_truncated: transcript.length > MAX_TRANSCRIPT_CHARS,
        my_notes: note.content || "",
        generated_notes: note.enhanced_content || "",
      };
    },
  },

  get_coaching_summary: {
    async call(self, args) {
      const { note } = self._resolveNote(args);
      const session = self.db.getLatestCoachSession(note.id);
      if (!session?.summary) {
        return { note_id: note.id, title: note.title, coached: false };
      }
      const s = session.summary;
      const clock = (ms) =>
        ms == null ? null : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
      return {
        note_id: note.id,
        title: note.title,
        coached: true,
        started_at: normalizeDate(session.startedAt),
        stance: s.stance,
        duration: clock(s.durationMs),
        my_talk_share: s.talkShareMe != null ? Math.round(s.talkShareMe * 100) / 100 : null,
        coverage: s.coverage.map((c) => ({
          kind: c.kind,
          text: c.text,
          covered: c.covered,
          covered_by: c.coveredBy,
          at: clock(c.coveredAtMs),
          follow_up: s.followUps?.[c.id] || null,
        })),
        tone_timeline: (s.toneTimeline || []).map((t) => ({ at: clock(t.atMs), label: t.label, score: t.score })),
        suggestions: session.events
          .filter((e) => e.kind === "nudge" && e.data)
          .map((e) => ({
            at: clock(e.atMs),
            kind: e.data.kind,
            headline: e.data.headline || null,
            fix: e.data.fix || null,
            include: e.data.include || [],
          })),
      };
    },
  },
};

module.exports = { CoachConnector, CONNECTOR_TOOLS: TOOLS };
