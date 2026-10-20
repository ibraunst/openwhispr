// Prompt builders + response sanitizers for the meeting coach. Pure (no
// Electron/Node APIs) so the live engine and scripts/coach-replay.js share them.

const STANCES = {
  firm: "Firm — hold positions, state asks and numbers plainly, no hedging, no premature concessions.",
  collaborative:
    "Collaborative — open and curious, build on others' ideas, look for shared solutions while staying clear about ME's goals.",
  supportive:
    "Supportive — warm and patient, listen more than talk, validate before redirecting, no pressure.",
  persuasive:
    "Persuasive — confident and benefit-led, back claims with specifics, handle objections directly, ask for commitment.",
};

const STANCE_KEYS = Object.keys(STANCES);
const CHECKLIST_KINDS = ["goal", "question", "fact", "objection"];
const NUDGE_KINDS = ["tone", "answer", "missing", "next"];
const TONE_LABELS = ["passive", "on_stance", "aggressive", "rambling", "unclear"];

function describeStance(stance, stanceCustom) {
  if (stance === "custom" && stanceCustom && stanceCustom.trim()) {
    return `Custom — ${stanceCustom.trim()}`;
  }
  return STANCES[stance] || STANCES.collaborative;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, maxLen) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
}

/**
 * Pull the first JSON object out of a model reply. Models occasionally wrap
 * JSON in prose or code fences despite instructions.
 */
function extractJson(text) {
  if (typeof text !== "string") throw new Error("Empty model response");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model response contained no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const EVAL_SYSTEM = `You are a discreet real-time meeting coach for ONE person, called ME. You read a live, imperfect auto-transcript: ME lines come from ME's microphone, THEM lines are everyone else. Your suggestions appear on a small overlay ME glances at mid-conversation.

Return ONLY a JSON object, no prose:
{"covered":[{"id":"c1","by":"me|them"}],"tone":{"label":"passive|on_stance|aggressive|rambling|unclear","score":0,"confidence":0},"nudge":null}
or with a nudge:
"nudge":{"kind":"tone|answer|missing|next","headline":"","fix":"","include":[""],"confidence":0}

Rules:
- covered: ids from the OPEN checklist that the transcript window shows were genuinely addressed (asked, answered, stated with substance) — not merely mentioned. Empty array if none.
- The transcript is automatic speech recognition of natural talk: filler words, restarts, repetitions and run-on sentences are normal and are NOT rambling or passivity by themselves. Judge what ME actually committed to, asked for or conceded — not how polished it reads.
- tone: judge ONLY ME's most recent turn against the target stance. score from -1 (very passive) through 0 (on stance) to +1 (too aggressive). Passive signals: hedging ("maybe", "I think", "sort of", "just", "kind of"), apologizing, asking permission, conceding early, not answering what was asked. Use "rambling" only for a turn of roughly a minute or more that never lands a point. Most turns in a healthy conversation are "on_stance" — a turn that is merely casual, exploratory or friendly is on stance for collaborative/supportive. Use "unclear" when there is too little to judge.
- nudge: null is the right answer most of the time. Only nudge when it would clearly help ME in the next 30 seconds.
- Never coach small talk: greetings, rapport, weather, weekend chat, audio/screen-share checks or scheduling logistics. Tone only matters once the conversation is about the actual work or decision. If ME's last turn is small talk, tone label is "unclear" and nudge is null.
- headline: at most 6 words (e.g. "Too passive — be firm"). fix: one instruction, at most 14 words. include: up to 3 short points (max 6 words each) ME should say, taken ONLY from the prep checklist or from facts already stated in the transcript. Never invent names, numbers, dates or commitments. Empty array if nothing qualifies — that is fine.
- Never quote the transcript back. Ignore obvious transcription errors.
- confidence: 0-1, how sure you are this nudge helps right now. Above 0.8 only when the problem is unmistakable (e.g. ME conceded a key point, dodged a direct question, or hedged an ask the stance says to make firmly).`;

function triggerInstruction(trigger) {
  switch (trigger.type) {
    case "my_turn":
      return 'ME just finished a turn (ME\'S LAST TURN below). Assess its tone against the stance. Use nudge kind "tone" only if clearly off-stance, or kind "missing" only if a specific OPEN checklist item (listed above) fits naturally right now — never "missing" when the open checklist is empty. Otherwise nudge null.';
    case "their_question":
      return 'THEM just asked a question (THEIR QUESTION below). If it is directed at ME, give nudge kind "answer": fix = how to answer in the target stance, include = the facts/points to cover (from prep when relevant). If it is not for ME or needs no help, nudge null.';
    case "ask":
      return 'ME pressed the coach hotkey asking "what should I say or ask next?". ALWAYS return a nudge of kind "next": the single best next move (fix) and up to 3 points (include), prioritising OPEN checklist items and the current flow of conversation. confidence still required.';
    default:
      return "Assess the conversation.";
  }
}

function describeDelivery(delivery) {
  if (!delivery) return "";
  const parts = [];
  if (delivery.wpm) {
    parts.push(
      `rate ${Math.round(delivery.wpm)} wpm${delivery.baselineWpm ? ` (ME's baseline ${Math.round(delivery.baselineWpm)})` : ""}`
    );
  }
  if (delivery.risingEnds != null && delivery.utteranceCount) {
    parts.push(`rising pitch at the end of ${delivery.risingEnds} of ${delivery.utteranceCount} statements`);
  }
  if (delivery.loudnessDeltaDb != null && Math.abs(delivery.loudnessDeltaDb) >= 2) {
    parts.push(
      `volume ${delivery.loudnessDeltaDb > 0 ? "+" : ""}${delivery.loudnessDeltaDb.toFixed(0)} dB vs baseline`
    );
  }
  if (delivery.responseLatencyMs != null && delivery.responseLatencyMs >= 2500) {
    parts.push(`paused ${(delivery.responseLatencyMs / 1000).toFixed(1)}s before answering`);
  }
  return parts.length ? `DELIVERY SIGNALS (approximate, supporting evidence only): ${parts.join("; ")}.` : "";
}

/**
 * @param {object} ctx
 * @param {object} ctx.trigger  {type, turnText?, questionText?, delivery?}
 * @param {Array}  ctx.checklist items with {id, kind, text, detail, covered}
 * @param {Array}  ctx.window    utterances {speaker, text, startMs}
 */
function buildEvalPrompt(ctx) {
  const { trigger, checklist, window, stance, stanceCustom, meetingTitle, minutesLeft, language } =
    ctx;
  const open = checklist.filter((i) => !i.covered);
  const done = checklist.filter((i) => i.covered);

  const lines = [];
  lines.push(`TARGET STANCE: ${describeStance(stance, stanceCustom)}`);
  if (meetingTitle) lines.push(`MEETING: ${meetingTitle}`);
  if (minutesLeft != null) lines.push(`TIME LEFT: about ${Math.max(0, Math.round(minutesLeft))} min`);
  lines.push("");
  lines.push("OPEN CHECKLIST:");
  if (open.length === 0) lines.push("(none)");
  for (const item of open) {
    lines.push(`- [${item.id}] (${item.kind}) ${item.text}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  if (done.length) {
    lines.push(`ALREADY COVERED: ${done.map((i) => i.id).join(", ")}`);
  }
  lines.push("");
  lines.push("TRANSCRIPT (most recent last):");
  if (window.length === 0) lines.push("(nothing yet)");
  for (const u of window) {
    lines.push(`[${formatClock(u.startMs)}] ${u.speaker === "me" ? "ME" : "THEM"}: ${u.text}`);
  }
  lines.push("");
  if (trigger.turnText) lines.push(`ME'S LAST TURN: "${trigger.turnText}"`);
  if (trigger.questionText) lines.push(`THEIR QUESTION: "${trigger.questionText}"`);
  const delivery = describeDelivery(trigger.delivery);
  if (delivery) lines.push(delivery);
  lines.push("");
  lines.push(`TASK: ${triggerInstruction(trigger)}`);
  if (language && language !== "en") {
    lines.push(`Write headline, fix and include in the language with code "${language}".`);
  }

  return { system: EVAL_SYSTEM, user: lines.join("\n") };
}

function sanitizeEvalResponse(raw, openIds) {
  const result = { covered: [], tone: null, nudge: null };
  if (!raw || typeof raw !== "object") return result;

  const validIds = new Set(openIds);
  if (Array.isArray(raw.covered)) {
    for (const entry of raw.covered) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (typeof id !== "string" || !validIds.has(id)) continue;
      const by = entry?.by === "me" || entry?.by === "them" ? entry.by : null;
      result.covered.push({ id, by });
    }
  }

  if (raw.tone && typeof raw.tone === "object" && TONE_LABELS.includes(raw.tone.label)) {
    result.tone = {
      label: raw.tone.label,
      score: clampNumber(raw.tone.score, -1, 1, 0),
      confidence: clampNumber(raw.tone.confidence, 0, 1, 0),
    };
  }

  const n = raw.nudge;
  if (n && typeof n === "object" && NUDGE_KINDS.includes(n.kind)) {
    const headline = cleanText(n.headline, 60);
    const fix = cleanText(n.fix, 140);
    if (headline || fix) {
      result.nudge = {
        kind: n.kind,
        headline,
        fix,
        include: Array.isArray(n.include)
          ? n.include.map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 3)
          : [],
        confidence: clampNumber(n.confidence, 0, 1, 0),
      };
    }
  }
  return result;
}

const PLAN_SYSTEM = `You turn meeting prep material into a compact checklist that a live coach will track during the call for ONE person, called ME.

Return ONLY a JSON object, no prose:
{"checklist":[{"kind":"goal|question|fact|objection","text":"","detail":""}],"stance":"firm|collaborative|supportive|persuasive","stanceReason":""}

Rules:
- 4 to 14 items, most important first. text: at most 12 words, phrased so ME instantly recognises it. detail: optional, at most 30 words (numbers, names, the planned response).
- goal = an outcome ME wants from the meeting. question = something ME must ask. fact = a number or claim ME may need to cite. objection = pushback ME should expect; put ME's planned response in detail.
- stance: the tone that best fits what the prep is trying to achieve. stanceReason: at most 15 words explaining why.
- Use only what the prep supports; do not invent facts.`;

function buildPlanPrompt({ sources, meetingTitle, attendees, language }) {
  const lines = [];
  if (meetingTitle) lines.push(`MEETING: ${meetingTitle}`);
  if (attendees && attendees.length) lines.push(`ATTENDEES: ${attendees.join(", ")}`);
  lines.push("");
  for (const source of sources) {
    if (!source.text) continue;
    lines.push(`=== PREP: ${source.name} ===`);
    lines.push(source.text);
    lines.push("");
  }
  if (language && language !== "en") {
    lines.push(`Write text, detail and stanceReason in the language with code "${language}".`);
  }
  return { system: PLAN_SYSTEM, user: lines.join("\n") };
}

function sanitizePlanResponse(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.checklist)) {
    throw new Error("The model did not return a checklist");
  }
  const checklist = raw.checklist
    .map((item) => ({
      kind: CHECKLIST_KINDS.includes(item?.kind) ? item.kind : "goal",
      text: cleanText(item?.text, 120),
      detail: cleanText(item?.detail, 240),
    }))
    .filter((item) => item.text)
    .slice(0, 20);
  if (checklist.length === 0) throw new Error("The model returned an empty checklist");
  return {
    checklist,
    stance: STANCE_KEYS.includes(raw.stance) ? raw.stance : "collaborative",
    stanceReason: cleanText(raw.stanceReason, 120),
  };
}

const FOLLOWUP_SYSTEM = `A meeting just ended. For each checklist item ME did not cover, write one concrete follow-up ME can send or do (at most 20 words), informed by the end of the transcript.

Return ONLY a JSON object: {"followUps":[{"id":"c1","text":""}]}`;

function buildFollowUpPrompt({ uncovered, window, meetingTitle, language }) {
  const lines = [];
  if (meetingTitle) lines.push(`MEETING: ${meetingTitle}`);
  lines.push("NOT COVERED:");
  for (const item of uncovered) {
    lines.push(`- [${item.id}] (${item.kind}) ${item.text}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  lines.push("");
  lines.push("END OF TRANSCRIPT:");
  for (const u of window) {
    lines.push(`${u.speaker === "me" ? "ME" : "THEM"}: ${u.text}`);
  }
  if (language && language !== "en") {
    lines.push(`Write the follow-ups in the language with code "${language}".`);
  }
  return { system: FOLLOWUP_SYSTEM, user: lines.join("\n") };
}

function sanitizeFollowUps(raw, uncoveredIds) {
  const valid = new Set(uncoveredIds);
  const out = {};
  if (raw && Array.isArray(raw.followUps)) {
    for (const f of raw.followUps) {
      if (typeof f?.id === "string" && valid.has(f.id)) {
        const text = cleanText(f.text, 200);
        if (text) out[f.id] = text;
      }
    }
  }
  return out;
}

module.exports = {
  STANCES,
  STANCE_KEYS,
  CHECKLIST_KINDS,
  NUDGE_KINDS,
  formatClock,
  extractJson,
  buildEvalPrompt,
  sanitizeEvalResponse,
  buildPlanPrompt,
  sanitizePlanResponse,
  buildFollowUpPrompt,
  sanitizeFollowUps,
};
