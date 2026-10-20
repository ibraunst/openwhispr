// Live meeting-coach session: turns the per-channel utterance stream (ME =
// mic, THEM = system audio) into checklist coverage, delivery stats and a
// rate-limited trickle of suggestions. Pure logic — the clock, model and
// sinks are injected, so scripts/coach-replay.js drives the exact same rules
// against saved meetings.

const {
  buildEvalPrompt,
  sanitizeEvalResponse,
  buildFollowUpPrompt,
  sanitizeFollowUps,
} = require("./coachPrompts");

const TUNING = {
  // A ME turn ends when THEM speaks or ME stays quiet this long
  turnIdleMs: 2500,
  // Short turns ("yeah", "sounds good") never get a tone verdict
  minTurnWords: 8,
  // Mic utterances wait this long for the matching system utterance so
  // speaker bleed (open speakers) can be detected and dropped
  micHoldMs: 1200,
  leakWindowMs: 1500,
  leakOverlap: 0.6,
  // Suggestion pacing
  nudgeGapMs: 45000,
  // Tone coaching is the easiest to overdo (replay: a tone card every ~75 s
  // with only the 45 s gap). Tone cards need: 3 min since the last one, not
  // in the opening small-talk window, and a PATTERN — the previous evaluated
  // turn (within patternWindowMs) off-stance the same way — unless the turn
  // is severely off (|score| >= toneSevereScore).
  toneGapMs: 3 * 60 * 1000,
  toneOpeningGraceMs: 3 * 60 * 1000,
  tonePatternWindowMs: 3 * 60 * 1000,
  toneSevereScore: 0.85,
  answerGapMs: 10000,
  minConfidence: 0.6,
  minToneConfidence: 0.65,
  nudgeTtlMs: 15000,
  answerTtlMs: 25000,
  askTtlMs: 30000,
  // Local (no-model) signals
  monologueMs: 90000,
  endWarningMs: 5 * 60 * 1000,
  // Context sent to the model (kept tight: Groq's free tier allows 8K
  // tokens/minute and a 3-minute window peaked at ~6.6K in replay)
  windowMs: 2 * 60 * 1000,
  windowMaxChars: 4500,
  // ME-turn evaluations: at most one per this gap, and none while a just-shown
  // suggestion's cooldown would discard the verdict anyway (unless open
  // checklist items still need coverage tracking)
  minTurnEvalGapMs: 15000,
  // Delivery: a statement "rises" when its last ~400 ms sit this far above the median
  risingEndSemitones: 2,
  maxConsecutiveLlmFailures: 3,
};

// How much the coach speaks up. Balanced is the tuned baseline (replay:
// ~3 cards per 10 min on a 1:1); the others shift only the pacing rules —
// answer help and the "what next?" hotkey behave the same at every level.
const INTENSITY_PRESETS = {
  light: {
    nudgeGapMs: 60000,
    toneGapMs: 5 * 60 * 1000,
    toneOpeningGraceMs: 5 * 60 * 1000,
    toneSevereScore: 0.9,
    minConfidence: 0.7,
    monologueMs: 120000,
  },
  balanced: {},
  active: {
    nudgeGapMs: 30000,
    toneGapMs: 90 * 1000,
    toneOpeningGraceMs: 60 * 1000,
    // 0 = any off-stance turn qualifies; no two-in-a-row pattern needed
    toneSevereScore: 0,
    minConfidence: 0.55,
    monologueMs: 75000,
  },
};
const INTENSITY_LEVELS = Object.keys(INTENSITY_PRESETS);

function tuningFor(intensity, overrides) {
  return { ...TUNING, ...(INTENSITY_PRESETS[intensity] || {}), ...(overrides || {}) };
}

const TRIGGER_PRIORITY = { ask: 3, their_question: 2, my_turn: 1 };

const QUESTION_START =
  /^(what|why|how|when|where|who|which|can|could|would|will|do|does|did|is|are|was|were|should|have|has)\b/i;

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isQuestion(text, words) {
  if (words.length < 4) return false;
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) return true;
  // Parakeet usually punctuates, but long run-on chunks can lose the "?" —
  // check the last sentence's opening word as a fallback
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1] || "";
  return QUESTION_START.test(last) && last.split(/\s+/).length >= 4 && !/[.!]$/.test(last);
}

class CoachSession {
  /**
   * @param {object} opts
   * @param {Array}    opts.checklist     [{id, kind, text, detail}]
   * @param {string}   opts.stance
   * @param {string}   [opts.stanceCustom]
   * @param {string}   [opts.meetingTitle]
   * @param {number}   [opts.endsAtMs]     wall-clock end of the calendar event
   * @param {object}   [opts.llm]          createCoachLlm() result; null = local signals only
   * @param {string}   [opts.language]     UI language for model-written text
   * @param {function} [opts.now]
   * @param {function} [opts.onEvent]      (kind, atMs, data) — persisted timeline
   * @param {function} [opts.onChange]    () — state changed, re-render overlay
   * @param {function} [opts.log]          (level, message, data)
   */
  constructor(opts) {
    this.now = opts.now || Date.now;
    this.llm = opts.llm || null;
    this.language = opts.language || "en";
    this.meetingTitle = opts.meetingTitle || "";
    this.endsAtMs = opts.endsAtMs || null;
    this.onEvent = opts.onEvent || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.log = opts.log || (() => {});
    this.intensity = INTENSITY_LEVELS.includes(opts.intensity) ? opts.intensity : "balanced";
    this.tuningOverrides = opts.tuning || null;
    this.tuning = tuningFor(this.intensity, this.tuningOverrides);

    this.checklist = (opts.checklist || []).map((item, i) => ({
      id: item.id || `c${i + 1}`,
      kind: item.kind || "goal",
      text: item.text || "",
      detail: item.detail || "",
      covered: false,
      coveredAtMs: null,
      coveredBy: null,
    }));
    this.stance = opts.stance || "collaborative";
    this.stanceCustom = opts.stanceCustom || "";

    this.utterances = [];
    this.pendingMic = [];
    this.turn = null;
    this.lastThemEndMs = null;
    this.monologueMs = 0;
    this.monologueFlagged = false;
    this.talkMs = { me: 0, them: 0 };
    this.leak = { checked: 0, dropped: 0 };
    this.baseline = { wpm: [], db: [] };

    this.nudge = null;
    this.lastNudgeAt = -Infinity;
    this.lastToneNudgeAt = -Infinity;
    this.nudgeSeq = 0;
    this.tone = { label: null, score: 0, confidence: 0 };
    this.toneTimeline = [];
    this.endWarned = false;
    this.paused = false;

    this.inFlight = null;
    this.queued = null;
    this.lastTurnEvalAt = -Infinity;
    this.idleWaiters = [];
    this.llmFailures = 0;
    this.llmDisabled = !this.llm;
    this.error = null;
    this.stats = { llmCalls: 0, llmMsTotal: 0, nudgesShown: 0, nudgesSuppressed: 0 };
    this.lastRecMs = 0;
  }

  // ── Input ──────────────────────────────────────────────────────────────

  addUtterance(raw) {
    const text = (raw.text || "").replace(/\s+/g, " ").trim();
    if (!text || this.paused) return;
    const u = {
      speaker: raw.speaker === "me" ? "me" : "them",
      text,
      words: tokenize(text),
      startMs: Math.max(0, raw.startMs || 0),
      endMs: Math.max(raw.endMs || 0, raw.startMs || 0),
      prosody: raw.prosody || null,
    };
    if (!u.words.length) return;
    this.lastRecMs = Math.max(this.lastRecMs, u.endMs);

    if (u.speaker === "me") {
      this.pendingMic.push({ u, arrivedAt: this.now() });
    } else {
      this._commitThem(u);
    }
  }

  setPaused(paused) {
    this.paused = !!paused;
    if (this.paused) {
      this.turn = null;
      this.pendingMic = [];
    }
    this.onChange();
  }

  setStance(stance, stanceCustom) {
    this.stance = stance;
    if (typeof stanceCustom === "string") this.stanceCustom = stanceCustom;
    this.onEvent("stance", this.lastRecMs, { stance, stanceCustom: this.stanceCustom });
    this.onChange();
  }

  setIntensity(intensity) {
    if (!INTENSITY_LEVELS.includes(intensity) || intensity === this.intensity) return;
    this.intensity = intensity;
    this.tuning = tuningFor(intensity, this.tuningOverrides);
    this.onEvent("intensity", this.lastRecMs, { intensity });
    this.onChange();
  }

  ask() {
    if (this.llmDisabled) {
      this.onChange();
      return false;
    }
    this._trigger({ type: "ask" });
    return true;
  }

  dismissNudge() {
    if (!this.nudge) return;
    this.nudge = null;
    this.onChange();
  }

  /** Drive timers — call every ~250-500 ms. */
  tick() {
    const now = this.now();
    let changed = false;

    while (this.pendingMic.length && now - this.pendingMic[0].arrivedAt >= this.tuning.micHoldMs) {
      const { u, arrivedAt } = this.pendingMic.shift();
      if (this._isLeak(u)) {
        this.leak.checked += 1;
        this.leak.dropped += 1;
        this.log("debug", "Coach dropped mic utterance as speaker bleed", { text: u.text.slice(0, 80) });
        changed = true;
        continue;
      }
      this.leak.checked += 1;
      this._commitMe(u, arrivedAt);
      changed = true;
    }

    if (this.turn && !this.pendingMic.length && now - this.turn.lastArrival >= this.tuning.turnIdleMs) {
      this._closeTurn();
    }

    if (this.nudge && now >= this.nudge.expiresAt) {
      this.nudge = null;
      changed = true;
    }

    if (this.endsAtMs && !this.endWarned && this.endsAtMs - now <= this.tuning.endWarningMs) {
      this.endWarned = true;
      const open = this.checklist.filter((i) => !i.covered);
      if (open.length) {
        this._showLocalNudge("time", { items: open.slice(0, 3).map((i) => i.text) });
      }
      changed = true;
    }

    if (changed) this.onChange();
  }

  // ── Turn tracking ──────────────────────────────────────────────────────

  _commitThem(u) {
    this.utterances.push(u);
    this.talkMs.them += u.prosody?.voicedMs ?? u.endMs - u.startMs;
    if (u.words.length >= 3) {
      this.lastThemEndMs = u.endMs;
      this.monologueMs = 0;
      this.monologueFlagged = false;
      if (this.turn) this._closeTurn();
    }
    if (isQuestion(u.text, u.words)) {
      this._trigger({ type: "their_question", questionText: u.text });
    }
    this.onChange();
  }

  _commitMe(u, arrivedAt) {
    this.utterances.push(u);
    const voiced = u.prosody?.voicedMs ?? u.endMs - u.startMs;
    this.talkMs.me += voiced;
    this.monologueMs += voiced;

    if (u.prosody?.voicedMs > 1500 && u.words.length >= 4) {
      const wpm = u.words.length / (u.prosody.voicedMs / 60000);
      if (wpm > 40 && wpm < 400) this.baseline.wpm.push(wpm);
      if (u.prosody.meanDb != null) this.baseline.db.push(u.prosody.meanDb);
    }

    if (!this.turn) {
      this.turn = {
        utterances: [],
        startMs: u.startMs,
        responseLatencyMs:
          this.lastThemEndMs != null ? Math.max(0, u.startMs - this.lastThemEndMs) : null,
        lastArrival: arrivedAt,
      };
    }
    this.turn.utterances.push(u);
    this.turn.lastArrival = Math.max(this.turn.lastArrival, arrivedAt);

    if (this.monologueMs >= this.tuning.monologueMs && !this.monologueFlagged) {
      this.monologueFlagged = true;
      this._showLocalNudge("monologue", { seconds: Math.round(this.monologueMs / 1000) });
    }
  }

  _closeTurn() {
    const turn = this.turn;
    this.turn = null;
    if (!turn) return;
    const words = turn.utterances.reduce((n, u) => n + u.words.length, 0);
    if (words < this.tuning.minTurnWords) return;
    this._trigger({
      type: "my_turn",
      turnText: turn.utterances.map((u) => u.text).join(" "),
      endMs: turn.utterances[turn.utterances.length - 1].endMs,
      delivery: this._describeTurnDelivery(turn, words),
    });
  }

  _describeTurnDelivery(turn, words) {
    const prosodies = turn.utterances.map((u) => u.prosody).filter(Boolean);
    if (!prosodies.length) return null;
    const voicedMs = prosodies.reduce((n, p) => n + (p.voicedMs || 0), 0);
    const dbs = prosodies.map((p) => p.meanDb).filter((v) => v != null);
    const rises = prosodies.filter((p) => p.endRiseSemitones != null);
    const baselineDb = median(this.baseline.db);
    const turnDb = median(dbs);
    return {
      wpm: voicedMs > 1500 ? words / (voicedMs / 60000) : null,
      baselineWpm: this.baseline.wpm.length >= 5 ? median(this.baseline.wpm) : null,
      utteranceCount: rises.length || null,
      risingEnds: rises.length
        ? rises.filter((p) => p.endRiseSemitones >= this.tuning.risingEndSemitones).length
        : null,
      loudnessDeltaDb:
        baselineDb != null && turnDb != null && this.baseline.db.length >= 5 ? turnDb - baselineDb : null,
      responseLatencyMs: turn.responseLatencyMs,
    };
  }

  _isLeak(u) {
    if (u.words.length < 3) return false;
    const lo = u.startMs - this.tuning.leakWindowMs;
    const hi = u.endMs + this.tuning.leakWindowMs;
    const themWords = new Set();
    for (let i = this.utterances.length - 1; i >= 0; i--) {
      const other = this.utterances[i];
      if (other.endMs < lo - 20000) break;
      if (other.speaker !== "them" || other.endMs < lo || other.startMs > hi) continue;
      for (const w of other.words) themWords.add(w);
    }
    if (!themWords.size) return false;
    const shared = u.words.filter((w) => themWords.has(w)).length;
    return shared / u.words.length >= this.tuning.leakOverlap;
  }

  // ── Model calls ────────────────────────────────────────────────────────

  _trigger(trigger) {
    if (this.paused || this.llmDisabled) return;
    if (trigger.type === "my_turn" && !this._shouldEvaluateTurn()) return;
    if (this.inFlight) {
      if (!this.queued || TRIGGER_PRIORITY[trigger.type] >= TRIGGER_PRIORITY[this.queued.type]) {
        this.queued = trigger;
      }
      return;
    }
    void this._run(trigger);
  }

  _shouldEvaluateTurn() {
    const now = this.now();
    if (now - this.lastTurnEvalAt < this.tuning.minTurnEvalGapMs) return false;
    const inCooldown = now - this.lastNudgeAt < this.tuning.nudgeGapMs;
    if (inCooldown && !this.checklist.some((i) => !i.covered)) return false;
    return true;
  }

  _buildWindow() {
    const cutoff = this.lastRecMs - this.tuning.windowMs;
    const recent = this.utterances.filter((u) => u.endMs >= cutoff);
    // Keep the newest lines under the char budget
    let chars = 0;
    const kept = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      chars += recent[i].text.length + 12;
      if (chars > this.tuning.windowMaxChars) break;
      kept.unshift(recent[i]);
    }
    return kept;
  }

  _minutesLeft() {
    return this.endsAtMs ? (this.endsAtMs - this.now()) / 60000 : null;
  }

  async _run(trigger) {
    this.inFlight = trigger;
    if (trigger.type === "my_turn") this.lastTurnEvalAt = this.now();
    if (trigger.type === "ask") this.onChange();
    const triggerAtMs = trigger.endMs ?? this.lastRecMs;
    const startedWall = Date.now();
    const openIds = this.checklist.filter((i) => !i.covered).map((i) => i.id);
    try {
      const prompt = buildEvalPrompt({
        trigger,
        checklist: this.checklist,
        window: this._buildWindow(),
        stance: this.stance,
        stanceCustom: this.stanceCustom,
        meetingTitle: this.meetingTitle,
        minutesLeft: this._minutesLeft(),
        language: this.language,
      });
      const raw = await this.llm.completeJson({
        system: prompt.system,
        user: prompt.user,
        maxTokens: 350,
        timeoutMs: trigger.type === "ask" ? 15000 : 10000,
      });
      const latencyMs = Date.now() - startedWall;
      this.stats.llmCalls += 1;
      this.stats.llmMsTotal += latencyMs;
      this.llmFailures = 0;
      this.error = null;
      this._apply(sanitizeEvalResponse(raw, openIds), trigger, triggerAtMs, latencyMs);
    } catch (err) {
      this.llmFailures += 1;
      this.error = err.message;
      this.log("warn", "Coach model call failed", { error: err.message, trigger: trigger.type });
      if (this.llmFailures >= this.tuning.maxConsecutiveLlmFailures) {
        this.llmDisabled = true;
        this.log("error", "Coach model disabled after repeated failures", { error: err.message });
      }
    } finally {
      this.inFlight = null;
      const next = this.queued;
      this.queued = null;
      this.onChange();
      if (next && !this.llmDisabled && !this.paused) {
        void this._run(next);
      } else {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    }
  }

  _apply(result, trigger, triggerAtMs, latencyMs) {
    for (const { id, by } of result.covered) {
      const item = this.checklist.find((i) => i.id === id);
      if (!item || item.covered) continue;
      item.covered = true;
      item.coveredAtMs = triggerAtMs;
      item.coveredBy = by;
      this.onEvent("covered", triggerAtMs, { id, text: item.text, by });
    }

    if (trigger.type === "my_turn" && result.tone) {
      const prev = this.tone.label ? this.tone.score : result.tone.score;
      this.tone = {
        label: result.tone.label,
        score: prev * 0.4 + result.tone.score * 0.6,
        confidence: result.tone.confidence,
      };
      this.toneTimeline.push({
        atMs: triggerAtMs,
        label: result.tone.label,
        score: result.tone.score,
        confidence: result.tone.confidence,
      });
    }

    const nudge = result.nudge;
    if (!nudge) return;
    const verdict = this._gateNudge(nudge, trigger, result.tone, triggerAtMs);
    if (verdict !== "ok") {
      this.stats.nudgesSuppressed += 1;
      this.onEvent("suppressed", triggerAtMs, { ...nudge, trigger: trigger.type, reason: verdict, latencyMs });
      return;
    }
    const ttl =
      trigger.type === "ask"
        ? this.tuning.askTtlMs
        : nudge.kind === "answer"
          ? this.tuning.answerTtlMs
          : this.tuning.nudgeTtlMs;
    this._showNudge({ ...nudge, source: "model", trigger: trigger.type, latencyMs }, triggerAtMs, ttl);
  }

  _gateNudge(nudge, trigger, tone, triggerAtMs) {
    if (trigger.type === "ask") return "ok";
    if (nudge.confidence < this.tuning.minConfidence) return "low_confidence";
    if (nudge.kind === "tone") {
      if (!tone || tone.label === "on_stance" || tone.label === "unclear") return "tone_on_stance";
      if (tone.confidence < this.tuning.minToneConfidence) return "tone_low_confidence";
      if (triggerAtMs < this.tuning.toneOpeningGraceMs) return "tone_opening_grace";
      if (this.now() - this.lastToneNudgeAt < this.tuning.toneGapMs) return "tone_rate_limited";
      if (Math.abs(tone.score) < this.tuning.toneSevereScore && !this._isTonePattern(tone, triggerAtMs)) {
        return "tone_not_a_pattern";
      }
    }
    if (nudge.kind === "next") return "unrequested_next";
    const gap = nudge.kind === "answer" ? this.tuning.answerGapMs : this.tuning.nudgeGapMs;
    if (this.now() - this.lastNudgeAt < gap) return "rate_limited";
    return "ok";
  }

  // The verdict before this one (already pushed to the timeline) was
  // off-stance in the same direction, recently enough to be the same stretch
  _isTonePattern(tone, atMs) {
    const prev = this.toneTimeline[this.toneTimeline.length - 2];
    if (!prev || atMs - prev.atMs > this.tuning.tonePatternWindowMs) return false;
    if (tone.label === "rambling") return prev.label === "rambling";
    if (prev.label === "on_stance" || prev.label === "unclear" || prev.label === "rambling") return false;
    return Math.sign(prev.score) === Math.sign(tone.score) && prev.score !== 0;
  }

  _showNudge(nudge, atMs, ttlMs) {
    this.nudgeSeq += 1;
    this.nudge = {
      id: this.nudgeSeq,
      kind: nudge.kind,
      headline: nudge.headline || "",
      fix: nudge.fix || "",
      include: nudge.include || [],
      params: nudge.params || null,
      source: nudge.source,
      atMs,
      shownAt: this.now(),
      expiresAt: this.now() + ttlMs,
    };
    this.lastNudgeAt = this.now();
    if (nudge.kind === "tone") this.lastToneNudgeAt = this.now();
    this.stats.nudgesShown += 1;
    this.onEvent("nudge", atMs, {
      kind: nudge.kind,
      headline: nudge.headline || "",
      fix: nudge.fix || "",
      include: nudge.include || [],
      params: nudge.params || null,
      source: nudge.source,
      trigger: nudge.trigger || null,
      confidence: nudge.confidence ?? null,
      latencyMs: nudge.latencyMs ?? null,
    });
    this.onChange();
  }

  // Local nudges are rendered from kind + params by the overlay (translated);
  // they bypass the model but still respect a short gap.
  _showLocalNudge(kind, params) {
    if (this.now() - this.lastNudgeAt < 20000 && this.nudge) return;
    this._showNudge({ kind, params, source: "local" }, this.lastRecMs, this.tuning.nudgeTtlMs);
  }

  /** Resolves once no model call is running or queued (replay harness). */
  idle() {
    if (!this.inFlight && !this.queued) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // ── Output ─────────────────────────────────────────────────────────────

  getState() {
    const totalTalk = this.talkMs.me + this.talkMs.them;
    const minutesLeft = this._minutesLeft();
    return {
      paused: this.paused,
      thinking: this.inFlight?.type === "ask",
      llmAvailable: !this.llmDisabled,
      error: this.error,
      stance: this.stance,
      stanceCustom: this.stanceCustom,
      intensity: this.intensity,
      checklist: this.checklist.map(({ id, kind, text, covered, coveredBy }) => ({
        id,
        kind,
        text,
        covered,
        coveredBy,
      })),
      nudge: this.nudge,
      tone: this.tone.label ? { label: this.tone.label, score: this.tone.score } : null,
      talkShareMe: totalTalk >= 20000 ? this.talkMs.me / totalTalk : null,
      monologueSec: this.turn || this.monologueMs ? Math.round(this.monologueMs / 1000) : 0,
      leakWarning: this.leak.checked >= 6 && this.leak.dropped / this.leak.checked >= 0.25,
      minutesLeft: minutesLeft != null ? Math.max(0, Math.round(minutesLeft)) : null,
      endWarned: this.endWarned,
    };
  }

  /** Final, deterministic summary — persisted at stop. */
  finish() {
    if (this.turn) this.turn = null;
    const totalTalk = this.talkMs.me + this.talkMs.them;
    return {
      stance: this.stance,
      stanceCustom: this.stanceCustom,
      intensity: this.intensity,
      durationMs: this.lastRecMs,
      coverage: this.checklist.map(({ id, kind, text, detail, covered, coveredAtMs, coveredBy }) => ({
        id,
        kind,
        text,
        detail,
        covered,
        coveredAtMs,
        coveredBy,
      })),
      followUps: {},
      talkShareMe: totalTalk > 0 ? this.talkMs.me / totalTalk : null,
      myTalkMs: Math.round(this.talkMs.me),
      theirTalkMs: Math.round(this.talkMs.them),
      leakRatio: this.leak.checked ? this.leak.dropped / this.leak.checked : 0,
      toneTimeline: this.toneTimeline,
      nudgesShown: this.stats.nudgesShown,
      nudgesSuppressed: this.stats.nudgesSuppressed,
      llmCalls: this.stats.llmCalls,
      llmAvgLatencyMs: this.stats.llmCalls ? Math.round(this.stats.llmMsTotal / this.stats.llmCalls) : null,
    };
  }

  /** Post-meeting: one follow-up line per uncovered item. Best-effort. */
  async generateFollowUps() {
    const uncovered = this.checklist.filter((i) => !i.covered);
    if (!uncovered.length || !this.llm) return {};
    const tail = this.utterances.slice(-40);
    const prompt = buildFollowUpPrompt({
      uncovered,
      window: tail,
      meetingTitle: this.meetingTitle,
      language: this.language,
    });
    const raw = await this.llm.completeJson({
      system: prompt.system,
      user: prompt.user,
      maxTokens: 600,
      timeoutMs: 30000,
    });
    return sanitizeFollowUps(
      raw,
      uncovered.map((i) => i.id)
    );
  }
}

module.exports = { CoachSession, TUNING, INTENSITY_LEVELS, INTENSITY_PRESETS, tokenize, isQuestion };
