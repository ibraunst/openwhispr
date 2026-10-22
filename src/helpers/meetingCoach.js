// Main-process owner of the live meeting coach: prep (sources → checklist +
// stance), the live CoachSession during a recording, its overlay window, the
// "what next?" hotkey, and the persisted post-meeting summary.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, globalShortcut } = require("electron");
const LlamaServerManager = require("./llamaServer");
const debugLogger = require("./debugLogger");
const { CoachSession, INTENSITY_LEVELS } = require("./coach/coachCore");
const {
  resolveCoachProvider,
  createCoachLlm,
  createLocalCoachLlm,
  createFallbackCoachLlm,
  CoachConfigError,
} = require("./coach/coachLlm");
const {
  buildPlanPrompt,
  sanitizePlanResponse,
  STANCE_KEYS,
} = require("./coach/coachPrompts");
const { extractPrepText, normalizePrepText } = require("./coach/prepParser");

const TICK_MS = 300;
const MAX_TOTAL_PREP_CHARS = 150000;
const DEFAULT_ASK_HOTKEY = "Control+Alt+A";
// Local fallback models, best first. 8B judges tone and coverage reliably;
// 4B models are kept only as a last resort (erratic confidence/coverage).
const LOCAL_MODEL_PREFERENCE = [
  /^Qwen3-8B.*Q5_K_M\.gguf$/i,
  /^Qwen3-8B.*\.gguf$/i,
  /^Qwen3-14B.*\.gguf$/i,
  /^Qwen3-4B.*\.gguf$/i,
  /^.*gemma-3-4b.*\.gguf$/i,
];
// Small prompts: an 8K context keeps the fallback's memory footprint down
const LOCAL_SERVER_ARGS = ["--ctx-size", "8192"];

function normalizeDate(value) {
  if (!value) return null;
  const str = String(value);
  // DB timestamps without a zone marker are UTC
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

class MeetingCoachManager {
  constructor({ databaseManager, windowManager, environmentManager }) {
    this.db = databaseManager;
    this.windowManager = windowManager;
    this.environmentManager = environmentManager;
    this.active = null; // { session, sessionId, noteId, meetingId, timer, hotkey, llmInfo, configError }
    this._lastStateJson = "";
    this._stopping = null;
    this._localServer = null;
    this._localStarting = null;
    // A recording running on a note that wasn't coached when it started.
    // Turning coaching on for that note mid-call starts the coach then.
    this.armed = null; // { noteId, meetingId }
  }

  // Ask the recording renderer to start its coach taps now (it re-calls start)
  _activateIfArmed(noteId) {
    if (this.active || !this.armed || this.armed.noteId !== noteId) return;
    debugLogger.info("Coaching enabled mid-recording — starting coach", { noteId }, "coach");
    this.windowManager.sendToControlPanel?.("coach-activate", {
      noteId,
      meetingId: this.armed.meetingId,
    });
  }

  _getKey(envName) {
    return process.env[envName] || "";
  }

  _findLocalModel() {
    const home = app?.getPath?.("home") || os.homedir();
    const dir = path.join(home, ".cache", "customwhispr", "models");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".gguf"));
    } catch {
      return null;
    }
    for (const pattern of LOCAL_MODEL_PREFERENCE) {
      const match = files.find((f) => pattern.test(f));
      if (match) return { name: match.replace(/\.gguf$/i, ""), path: path.join(dir, match) };
    }
    return null;
  }

  // Started on first use only — an 8B model holds ~5-6 GB while loaded
  async _localBaseUrl(modelPath) {
    if (!this._localServer) this._localServer = new LlamaServerManager({ sidecarName: "llama-coach" });
    const server = this._localServer;
    if (!(server.ready && server.modelPath === modelPath)) {
      if (!this._localStarting) {
        const started = Date.now();
        this._localStarting = server
          .start(modelPath, { extraArgs: LOCAL_SERVER_ARGS })
          .then(() =>
            debugLogger.info(
              "Coach local model ready",
              { model: path.basename(modelPath), ms: Date.now() - started },
              "coach"
            )
          )
          .finally(() => {
            this._localStarting = null;
          });
      }
      await this._localStarting;
    }
    if (!server.port) throw new Error("Local coach model failed to start");
    return `http://127.0.0.1:${server.port}`;
  }

  async _stopLocalServer() {
    const server = this._localServer;
    if (!server) return;
    try {
      await server.stop();
    } catch (err) {
      debugLogger.warn("Failed to stop coach local model", { error: err.message }, "coach");
    }
  }

  /** App shutdown (sidecar registry). */
  async shutdown() {
    await this.stop().catch(() => {});
    await this._stopLocalServer();
  }

  /**
   * Cloud model (per settings) with the best downloaded local model as an
   * automatic fallback; local only when no cloud key is configured (or when
   * "local" is chosen). Throws CoachConfigError when nothing is usable.
   */
  _resolveLlm(provider, model) {
    const local = this._findLocalModel();
    const localLlm = local
      ? createLocalCoachLlm({ modelName: local.name, getBaseUrl: () => this._localBaseUrl(local.path) })
      : null;

    if (provider === "local") {
      if (!localLlm) {
        throw new CoachConfigError("No local model downloaded (Settings → Intelligence)", "missing_local");
      }
      return { llm: localLlm, provider: "local", model: local.name, fallback: null };
    }

    let resolved;
    try {
      resolved = resolveCoachProvider(provider, model, (name) => this._getKey(name));
    } catch (err) {
      if (localLlm && err instanceof CoachConfigError) {
        debugLogger.info("Coach using local model (no cloud key)", { model: local.name }, "coach");
        return { llm: localLlm, provider: "local", model: local.name, fallback: null };
      }
      throw err;
    }
    const primary = createCoachLlm({
      ...resolved,
      onModelChange: ({ from, to }) =>
        debugLogger.warn("Coach model unavailable — switched", { provider: resolved.provider, from, to }, "coach"),
    });
    if (!localLlm) {
      return { llm: primary, provider: resolved.provider, model: resolved.model, fallback: null };
    }
    const chain = createFallbackCoachLlm({
      primary,
      fallback: localLlm,
      onSwitch: (info) => {
        debugLogger.warn("Coach model switched", { ...info, primary: resolved.provider }, "coach");
        this._pushState();
      },
    });
    return { llm: chain, provider: resolved.provider, model: resolved.model, fallback: local.name };
  }

  // ── Prep ────────────────────────────────────────────────────────────────

  getPrep(noteId) {
    const prep = this.db.getCoachPrep(noteId);
    if (prep?.stance) return { ...prep, stanceInherited: false };
    // No stance yet: reuse the one from the last meeting in the same series
    const note = this.db.getNote(noteId);
    const inherited = note?.calendar_event_id
      ? this.db.getSeriesCoachStance(noteId, note.calendar_event_id)
      : null;
    const base = prep || {
      noteId,
      sources: [],
      checklist: [],
      stance: null,
      stanceCustom: "",
      stanceReason: "",
      enabled: false,
      intensity: null,
      builtAt: null,
    };
    return inherited
      ? { ...base, stance: inherited.stance, stanceCustom: inherited.stanceCustom, stanceInherited: true }
      : { ...base, stanceInherited: false };
  }

  savePrep(noteId, patch) {
    const fields = {};
    if (Array.isArray(patch.checklist)) {
      fields.checklist = patch.checklist
        .filter((item) => item && typeof item.text === "string" && item.text.trim())
        .slice(0, 30)
        .map((item) => ({
          id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID().slice(0, 8),
          kind: ["goal", "question", "fact", "objection"].includes(item.kind) ? item.kind : "goal",
          text: item.text.trim().slice(0, 200),
          detail: typeof item.detail === "string" ? item.detail.trim().slice(0, 400) : "",
        }));
    }
    if (patch.stance !== undefined) {
      fields.stance = STANCE_KEYS.includes(patch.stance) || patch.stance === "custom" ? patch.stance : null;
    }
    if (typeof patch.stanceCustom === "string") fields.stanceCustom = patch.stanceCustom.slice(0, 300);
    if (typeof patch.enabled === "boolean") fields.enabled = patch.enabled;
    if (patch.intensity !== undefined) {
      fields.intensity = INTENSITY_LEVELS.includes(patch.intensity) ? patch.intensity : null;
    }
    if (Array.isArray(patch.sources)) {
      fields.sources = patch.sources.filter((s) => s && typeof s.id === "string");
    }
    const saved = this.db.saveCoachPrep(noteId, fields);
    this._pushLiveStanceIfActive(noteId, fields);
    if (saved.enabled) this._activateIfArmed(noteId);
    return this.getPrep(saved.noteId);
  }

  _pushLiveStanceIfActive(noteId, fields) {
    if (!this.active || this.active.noteId !== noteId) return;
    if (fields.intensity !== undefined) {
      this.active.session.setIntensity(fields.intensity || this.active.defaultIntensity);
    }
    if (fields.stance !== undefined || fields.stanceCustom !== undefined) {
      this.active.session.setStance(
        fields.stance ?? this.active.session.stance,
        fields.stanceCustom ?? this.active.session.stanceCustom
      );
    }
  }

  _sourceSummary(sources) {
    return sources.reduce((n, s) => n + (s.text?.length || 0), 0);
  }

  async addPrepFile(noteId, filePath) {
    const { name, text, truncated } = await extractPrepText(filePath);
    return this._appendSource(noteId, { name, text, truncated, kind: "file" });
  }

  addPrepText(noteId, name, rawText) {
    const { text, truncated } = normalizePrepText(String(rawText || ""));
    if (!text) throw new Error("Nothing to add — the text is empty");
    return this._appendSource(noteId, {
      name: (name || "").trim() || "Pasted prep",
      text,
      truncated,
      kind: "paste",
    });
  }

  _appendSource(noteId, source) {
    const prep = this.getPrep(noteId);
    const sources = [...prep.sources];
    if (this._sourceSummary(sources) + source.text.length > MAX_TOTAL_PREP_CHARS) {
      throw new Error("Prep material is too long — remove a source first");
    }
    sources.push({
      id: crypto.randomUUID().slice(0, 8),
      name: source.name,
      kind: source.kind,
      text: source.text,
      chars: source.text.length,
      truncated: !!source.truncated,
      addedAt: new Date().toISOString(),
    });
    this.db.saveCoachPrep(noteId, { sources });
    return this.getPrep(noteId);
  }

  removePrepSource(noteId, sourceId) {
    const prep = this.getPrep(noteId);
    this.db.saveCoachPrep(noteId, { sources: prep.sources.filter((s) => s.id !== sourceId) });
    return this.getPrep(noteId);
  }

  /** Prep sources → checklist + suggested stance (one model call). */
  async buildPlan(noteId, { provider, model, language } = {}) {
    const prep = this.getPrep(noteId);
    if (!prep.sources.length) throw new Error("Add prep material first");
    const note = this.db.getNote(noteId);
    let attendees = [];
    if (note?.calendar_event_id) {
      const event = this.db.getCalendarEventById(note.calendar_event_id);
      try {
        const parsed = JSON.parse(event?.attendees || "[]");
        if (Array.isArray(parsed)) {
          attendees = parsed.map((a) => a?.name || a?.email).filter(Boolean).slice(0, 20);
        }
      } catch {}
    }

    const { llm, provider: usedProvider, model: usedModel } = this._resolveLlm(provider, model);
    const prompt = buildPlanPrompt({
      sources: prep.sources,
      meetingTitle: note?.title || "",
      attendees,
      language,
    });
    const started = Date.now();
    const raw = await llm.completeJson({
      system: prompt.system,
      user: prompt.user,
      maxTokens: 2500,
      timeoutMs: 90000,
    });
    const plan = sanitizePlanResponse(raw);
    if (!this.active) void this._stopLocalServer();
    debugLogger.info(
      "Coach plan built",
      { noteId, items: plan.checklist.length, stance: plan.stance, provider: usedProvider, model: llm.model || usedModel, ms: Date.now() - started },
      "coach"
    );

    const checklist = plan.checklist.map((item, i) => ({ id: `c${i + 1}`, ...item }));
    // An inherited series stance (or one the user already picked) wins over
    // the model's suggestion; the reason is kept either way.
    const keepStance = !!prep.stance;
    const isFirstBuild = !prep.builtAt;
    this.db.saveCoachPrep(noteId, {
      checklist,
      stance: keepStance ? prep.stance : plan.stance,
      stanceCustom: keepStance ? prep.stanceCustom : "",
      stanceReason: plan.stanceReason,
      enabled: isFirstBuild ? true : prep.enabled,
      builtAt: new Date().toISOString(),
    });
    const built = this.getPrep(noteId);
    if (built.enabled) this._activateIfArmed(noteId);
    return { prep: built, suggestedStance: plan.stance };
  }

  getLatestSession(noteId) {
    return this.db.getLatestCoachSession(noteId);
  }

  // ── Live session ───────────────────────────────────────────────────────

  /**
   * Called by the renderer right after a local meeting recording starts.
   * Returns {active:false} when coaching is off for this note — the renderer
   * then skips its per-channel taps entirely.
   */
  async start({ noteId, meetingId, provider, model, hotkey, language, intensity: defaultIntensity }) {
    if (this.active) await this.stop();
    if (!noteId) return { active: false, reason: "no_note" };

    const prep = this.getPrep(noteId);
    if (!prep.enabled) {
      this.armed = { noteId, meetingId };
      return { active: false, reason: "disabled", armed: true };
    }
    this.armed = null;

    const note = this.db.getNote(noteId);
    let endsAtMs = null;
    if (note?.calendar_event_id) {
      const event = this.db.getCalendarEventById(note.calendar_event_id);
      endsAtMs = normalizeDate(event?.end_time);
      if (endsAtMs && endsAtMs < Date.now()) endsAtMs = null;
    }

    let llm = null;
    let llmInfo = null;
    let configError = null;
    try {
      const resolved = this._resolveLlm(provider, model);
      llm = resolved.llm;
      llmInfo = { provider: resolved.provider, model: resolved.model, fallback: resolved.fallback };
    } catch (err) {
      configError = err instanceof CoachConfigError ? err.code : "error";
      debugLogger.warn("Coach running without a model", { error: err.message }, "coach");
    }

    const stance = prep.stance || "collaborative";
    const fallbackIntensity = INTENSITY_LEVELS.includes(defaultIntensity) ? defaultIntensity : "balanced";
    const intensity = prep.intensity || fallbackIntensity;
    const sessionId = this.db.createCoachSession(noteId, meetingId, stance);
    const session = new CoachSession({
      checklist: prep.checklist,
      stance,
      stanceCustom: prep.stanceCustom,
      meetingTitle: note?.title || "",
      endsAtMs,
      llm,
      language,
      intensity,
      onEvent: (kind, atMs, data) => {
        if (kind === "suppressed") {
          debugLogger.debug("Coach suggestion suppressed", { reason: data.reason, kind: data.kind }, "coach");
        }
        try {
          this.db.addCoachEvent(sessionId, atMs, kind, data);
        } catch (err) {
          debugLogger.error("Failed to persist coach event", { error: err.message }, "coach");
        }
      },
      onChange: () => this._pushState(),
      log: (level, message, data) => {
        if (typeof debugLogger[level] === "function") debugLogger[level](message, data, "coach");
      },
    });

    this.active = {
      session,
      sessionId,
      noteId,
      meetingId,
      llmInfo,
      configError,
      defaultIntensity: fallbackIntensity,
      hotkey: null,
      hotkeyError: false,
      timer: setInterval(() => {
        try {
          session.tick();
        } catch (err) {
          debugLogger.error("Coach tick failed", { error: err.message }, "coach");
        }
      }, TICK_MS),
    };
    this._registerHotkey(hotkey || DEFAULT_ASK_HOTKEY);
    this._lastStateJson = "";

    try {
      await this.windowManager.showCoachOverlay();
      this._pushState(true);
    } catch (err) {
      debugLogger.error("Coach overlay unavailable — session continues headless", { error: err.message }, "coach");
    }

    debugLogger.info(
      "Coach session started",
      { noteId, sessionId, stance, intensity, items: prep.checklist.length, llm: llmInfo, endsAtMs: !!endsAtMs },
      "coach"
    );
    return { active: true, sessionId };
  }

  _registerHotkey(accelerator) {
    if (!this.active) return;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (this.active) this.active.session.ask();
      });
      if (ok) {
        this.active.hotkey = accelerator;
      } else {
        this.active.hotkeyError = true;
        debugLogger.warn("Coach hotkey already in use", { accelerator }, "coach");
      }
    } catch (err) {
      this.active.hotkeyError = true;
      debugLogger.warn("Coach hotkey invalid", { accelerator, error: err.message }, "coach");
    }
  }

  addUtterance(utterance) {
    if (!this.active || !utterance || typeof utterance.text !== "string") return;
    this.active.session.addUtterance(utterance);
  }

  setPaused(paused) {
    this.active?.session.setPaused(paused);
  }

  overlayAction(action) {
    if (!this.active || !action) return this.getOverlayState();
    const { session, noteId } = this.active;
    switch (action.type) {
      case "ask":
        session.ask();
        break;
      case "dismiss":
        session.dismissNudge();
        break;
      case "stance":
        if (STANCE_KEYS.includes(action.stance) || action.stance === "custom") {
          session.setStance(action.stance);
          try {
            this.db.saveCoachPrep(noteId, { stance: action.stance });
          } catch (err) {
            debugLogger.error("Failed to save stance change", { error: err.message }, "coach");
          }
        }
        break;
      case "intensity":
        if (INTENSITY_LEVELS.includes(action.intensity)) {
          session.setIntensity(action.intensity);
          try {
            this.db.saveCoachPrep(noteId, { intensity: action.intensity });
          } catch (err) {
            debugLogger.error("Failed to save coaching level", { error: err.message }, "coach");
          }
        }
        break;
      case "resize":
        this.windowManager.resizeCoachOverlay(action.height);
        break;
      default:
        break;
    }
    return this.getOverlayState();
  }

  getOverlayState() {
    if (!this.active) return { active: false };
    return {
      active: true,
      ...this.active.session.getState(),
      hotkey: this.active.hotkey,
      hotkeyError: this.active.hotkeyError,
      configError: this.active.configError,
      llm: this.active.llmInfo,
      llmStatus: this.active.session.llm?.status?.() ?? null,
    };
  }

  _pushState(force = false) {
    const state = this.getOverlayState();
    const json = JSON.stringify(state);
    if (!force && json === this._lastStateJson) return;
    this._lastStateJson = json;
    this.windowManager.sendToCoachOverlay("coach-state", state);
  }

  /** Ends the live session; safe to call repeatedly from every stop path. */
  async stop() {
    // The recording ended (every stop path lands here) — nothing to arm
    this.armed = null;
    if (this._stopping) return this._stopping;
    if (!this.active) return null;
    const active = this.active;
    this.active = null;

    this._stopping = (async () => {
      clearInterval(active.timer);
      // Free the local model's memory once the follow-ups below are done
      const releaseLocal = () => {
        if (!this.active) void this._stopLocalServer();
      };
      if (active.hotkey) {
        try {
          globalShortcut.unregister(active.hotkey);
        } catch {}
      }
      this.windowManager.closeCoachOverlay();

      const summary = active.session.finish();
      try {
        this.db.finishCoachSession(active.sessionId, summary);
      } catch (err) {
        debugLogger.error("Failed to save coach summary", { error: err.message }, "coach");
      }
      debugLogger.info(
        "Coach session ended",
        {
          sessionId: active.sessionId,
          covered: summary.coverage.filter((c) => c.covered).length,
          total: summary.coverage.length,
          nudges: summary.nudgesShown,
          suppressed: summary.nudgesSuppressed,
          llmCalls: summary.llmCalls,
          avgLatencyMs: summary.llmAvgLatencyMs,
        },
        "coach"
      );
      this.windowManager.sendToControlPanel?.("coach-session-updated", { noteId: active.noteId });

      // Follow-ups for uncovered items land a few seconds later
      void (async () => {
        try {
          const followUps = await active.session.generateFollowUps();
          if (Object.keys(followUps).length) {
            this.db.updateCoachSessionSummary(active.sessionId, { ...summary, followUps });
            this.windowManager.sendToControlPanel?.("coach-session-updated", { noteId: active.noteId });
          }
        } catch (err) {
          debugLogger.warn("Coach follow-ups failed", { error: err.message }, "coach");
        } finally {
          releaseLocal();
        }
      })();
      return summary;
    })();

    try {
      return await this._stopping;
    } finally {
      this._stopping = null;
    }
  }
}

module.exports = MeetingCoachManager;
