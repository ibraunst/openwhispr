#!/usr/bin/env node
/**
 * Replay a saved meeting through the live meeting coach — same engine, same
 * prompts, same pacing rules — and print what it would have shown, when, and
 * whether each suggestion would have arrived in time.
 *
 * Reads the production database READ-ONLY; never writes anything.
 * better-sqlite3 is built for Electron's ABI, so run through Electron:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/coach-replay.js --list
 *   ELECTRON_RUN_AS_NODE=1 ANTHROPIC_API_KEY=... ./node_modules/.bin/electron \
 *     scripts/coach-replay.js --note 80 --me "Ian" --prep ~/prep.md --minutes 20
 *
 * Options:
 *   --list               recent meeting notes that have a recording
 *   --note <id>          note to replay (needs a saved recording / transcript.json)
 *   --me <labels>        comma-separated speaker labels that are you (default: "Me")
 *   --prep <files>       comma-separated prep files; built into a checklist first.
 *                        Without it the note's saved coach checklist is used.
 *   --stance <s>         firm | collaborative | supportive | persuasive
 *   --intensity <i>      light | balanced | active (how often it speaks up; default balanced)
 *   --provider <p>       auto | anthropic | openai | groq | gemini (default auto)
 *   --model <m>          model override
 *   --minutes <n>        only replay the first n minutes (saves tokens)
 *   --dry                no model calls — local signals only (talk time, monologue, bleed)
 *   --verbose            print every utterance and every suppressed suggestion
 *   --user-data <dir>    app data dir (default ~/Library/Application Support/custom-whispr)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { CoachSession, INTENSITY_LEVELS } = require("../src/helpers/coach/coachCore");
const { resolveCoachProvider, createCoachLlm } = require("../src/helpers/coach/coachLlm");
const {
  buildPlanPrompt,
  sanitizePlanResponse,
  formatClock,
  STANCE_KEYS,
} = require("../src/helpers/coach/coachPrompts");
const { extractPrepText } = require("../src/helpers/coach/prepParser");
const { reconcileSegmentSpeakers } = require("../src/helpers/transcriptReconcile");

// Delay between the end of speech and the utterance reaching the coach live:
// ~650 ms end-of-speech silence + Parakeet chunk transcription
const ARRIVAL_DELAY_MS = 1200;
const TICK_MS = 250;
const MERGE_GAP_S = 0.8;
const MAX_UTTERANCE_S = 15;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function toUtterances(segments, meLabels) {
  const out = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    const speaker = meLabels.has(String(seg.speaker || "").trim().toLowerCase()) ? "me" : "them";
    const last = out[out.length - 1];
    if (
      last &&
      last.speaker === speaker &&
      seg.start - last.end <= MERGE_GAP_S &&
      seg.end - last.start <= MAX_UTTERANCE_S
    ) {
      last.text += ` ${text}`;
      last.end = seg.end;
    } else {
      out.push({ speaker, text, start: seg.start, end: seg.end, label: seg.speaker });
    }
  }
  return out.map((u) => ({
    speaker: u.speaker,
    label: u.label,
    text: u.text,
    startMs: Math.round(u.start * 1000),
    endMs: Math.round(u.end * 1000),
    prosody: null,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userData = expandHome(
    args["user-data"] || path.join(os.homedir(), "Library", "Application Support", "custom-whispr")
  );
  const dbPath = path.join(userData, "transcriptions.db");
  if (!fs.existsSync(dbPath)) fail(`Database not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  if (args.list) {
    const rows = db
      .prepare(
        `SELECT id, title, meeting_id, created_at FROM notes
         WHERE meeting_id IS NOT NULL ORDER BY created_at DESC LIMIT 25`
      )
      .all();
    for (const r of rows) {
      const hasJson = fs.existsSync(path.join(userData, "meetings", r.meeting_id, "transcript.json"));
      console.log(`${String(r.id).padStart(4)}  ${r.created_at}  ${hasJson ? "✓" : "✗"}  ${r.title}`);
    }
    return;
  }

  const noteId = parseInt(args.note, 10);
  if (!noteId) fail("Pass --note <id> (see --list)");
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
  if (!note) fail(`Note ${noteId} not found`);
  if (!note.meeting_id) fail(`Note ${noteId} has no linked recording`);
  const jsonPath = path.join(userData, "meetings", note.meeting_id, "transcript.json");
  if (!fs.existsSync(jsonPath)) fail(`No transcript.json for note ${noteId} (${jsonPath})`);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
  if (!rawSegments.length) fail("transcript.json has no segments");
  const segments = reconcileSegmentSpeakers(rawSegments, note.transcript || "");

  const labelTotals = new Map();
  for (const s of segments) {
    const label = String(s.speaker || "Unknown");
    labelTotals.set(label, (labelTotals.get(label) || 0) + Math.max(0, s.end - s.start));
  }
  const meLabels = new Set(
    String(args.me || "Me")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (![...labelTotals.keys()].some((l) => meLabels.has(l.toLowerCase()))) {
    console.error("Speakers in this meeting (seconds):");
    for (const [label, secs] of [...labelTotals].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${Math.round(secs).toString().padStart(5)}s  ${label}`);
    }
    fail('None of these is you — pass --me "<label>" (comma-separate several)');
  }

  let utterances = toUtterances(segments, meLabels);
  if (args.minutes) {
    const limitMs = parseFloat(args.minutes) * 60000;
    utterances = utterances.filter((u) => u.startMs < limitMs);
  }

  // The replay runs far faster than a meeting, so it would trip per-minute
  // rate limits that a live meeting never reaches. Wait those out (not
  // counted as model time) and record token use on the MEETING clock so the
  // real-pace load can be checked against the provider's limit.
  const usage = [];
  const modelTimes = [];
  let waitedMs = 0;
  // Rate-limit pause inside the most recent call (calls are serialized)
  let lastCallWaitMs = 0;
  let replayNow = () => 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    lastCallWaitMs = 0;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const response = await realFetch(url, opts);
      if (response.status === 429 && attempt < 6) {
        const header = parseFloat(response.headers.get("retry-after") || "");
        const body = await response.clone().text().catch(() => "");
        const hinted = parseFloat((body.match(/try again in ([\d.]+)s/) || [])[1] || "");
        const waitMs = Math.ceil(((Number.isFinite(header) ? header : hinted) || 5) * 1000) + 250;
        waitedMs += waitMs;
        lastCallWaitMs += waitMs;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (response.ok && String(url).includes("/chat/completions")) {
        modelTimes.push(Date.now() - started);
        const data = await response.clone().json().catch(() => null);
        if (data?.usage?.total_tokens) usage.push({ atMs: replayNow(), tokens: data.usage.total_tokens });
      }
      return response;
    }
  };

  // Model
  let llm = null;
  if (!args.dry) {
    try {
      const inner = createCoachLlm({
        ...resolveCoachProvider(args.provider || "auto", args.model, (k) => process.env[k]),
        onModelChange: ({ from, to }) => console.log(`   note: ${from} is unavailable on this account — using ${to}`),
      });
      // Rate-limit pauses happen inside the call — give the timeout room for them
      llm = {
        get provider() {
          return inner.provider;
        },
        get model() {
          return inner.model;
        },
        completeJson: (request) =>
          inner.completeJson({ ...request, timeoutMs: (request.timeoutMs || 10000) + 120000 }),
      };
    } catch (err) {
      fail(`${err.message}. Export ANTHROPIC_API_KEY (or OPENAI_/GROQ_/GEMINI_API_KEY), or use --dry.`);
    }
  }

  // Checklist + stance
  let checklist = [];
  let stance = null;
  let stanceCustom = "";
  // The table only exists once an app build with the coach has run
  const hasPrepTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coach_prep'")
    .get();
  const savedPrep = hasPrepTable
    ? db.prepare("SELECT * FROM coach_prep WHERE note_id = ?").get(noteId)
    : null;
  if (args.prep) {
    if (!llm) fail("--prep needs a model (drop --dry)");
    const sources = [];
    for (const file of String(args.prep).split(",")) {
      const { name, text } = await extractPrepText(expandHome(file.trim()));
      sources.push({ name, text });
    }
    const prompt = buildPlanPrompt({ sources, meetingTitle: note.title });
    const started = Date.now();
    const plan = sanitizePlanResponse(
      await llm.completeJson({ system: prompt.system, user: prompt.user, maxTokens: 2500, timeoutMs: 90000 })
    );
    checklist = plan.checklist.map((item, i) => ({ id: `c${i + 1}`, ...item }));
    stance = plan.stance;
    console.log(
      `Built checklist from prep in ${((Date.now() - started) / 1000).toFixed(1)}s — stance "${plan.stance}" (${plan.stanceReason})`
    );
  } else if (savedPrep) {
    try {
      checklist = JSON.parse(savedPrep.checklist || "[]");
    } catch {}
    stance = savedPrep.stance;
    stanceCustom = savedPrep.stance_custom || "";
  }
  if (args.stance) {
    if (!STANCE_KEYS.includes(args.stance)) fail(`--stance must be one of ${STANCE_KEYS.join(", ")}`);
    stance = args.stance;
  }
  stance = stance || "collaborative";
  const intensity = args.intensity || savedPrep?.intensity || "balanced";
  if (!INTENSITY_LEVELS.includes(intensity)) fail(`--intensity must be one of ${INTENSITY_LEVELS.join(", ")}`);

  // Calendar window → "time left" warnings, relative to recording start
  const base = 1_700_000_000_000;
  let now = base;
  replayNow = () => now - base;
  let endsAtMs = null;
  if (note.calendar_event_id) {
    const ev = db.prepare("SELECT start_time, end_time FROM calendar_events WHERE id = ?").get(note.calendar_event_id);
    const start = ev ? Date.parse(ev.start_time) : NaN;
    const end = ev ? Date.parse(ev.end_time) : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) endsAtMs = base + (end - start);
  }

  const verbose = !!args.verbose;
  const shown = [];
  const suppressed = [];
  const covered = [];
  const session = new CoachSession({
    checklist,
    stance,
    stanceCustom,
    meetingTitle: note.title,
    endsAtMs,
    llm,
    intensity,
    now: () => now,
    onEvent: (kind, atMs, data) => {
      if (kind === "nudge") {
        if (data.source === "model" && data.latencyMs != null) {
          data = { ...data, latencyMs: Math.max(0, data.latencyMs - lastCallWaitMs) };
        }
        shown.push({ atMs, ...data });
        const late = data.source === "model" ? lateness(atMs, data.latencyMs) : null;
        const text =
          data.source === "local"
            ? data.kind === "monologue"
              ? `long monologue (${data.params?.seconds}s)`
              : `~5 min left; open: ${(data.params?.items || []).join(" | ")}`
            : `${data.headline}${data.fix ? ` — ${data.fix}` : ""}${data.include?.length ? `  [+ ${data.include.join(" | ")}]` : ""}`;
        const meta =
          data.source === "model"
            ? ` (conf ${data.confidence?.toFixed(2)}, ${(data.latencyMs / 1000).toFixed(1)}s${late ? `, LATE by ${(late / 1000).toFixed(1)}s` : ""})`
            : " (local)";
        console.log(`[${formatClock(atMs)}] ⚑ ${data.kind.toUpperCase()}${meta} ${text}`);
      } else if (kind === "covered") {
        covered.push({ atMs, ...data });
        console.log(`[${formatClock(atMs)}] ✓ covered ${data.id} "${data.text}" (by ${data.by || "?"})`);
      } else if (kind === "suppressed") {
        suppressed.push(data);
        if (verbose) {
          console.log(`[${formatClock(atMs)}]   · held back (${data.reason}): ${data.kind} — ${data.headline}`);
        }
      }
    },
    log: (level, message, data) => {
      if (level === "warn" || level === "error" || verbose) {
        console.log(`   ${level}: ${message} ${data ? JSON.stringify(data) : ""}`);
      }
    },
  });

  // A suggestion is late if ME already started talking again before it would
  // have appeared (for answers: before ME started answering)
  const meStarts = utterances.filter((u) => u.speaker === "me").map((u) => u.startMs);
  function lateness(atMs, latencyMs) {
    const deliveredAt = atMs + ARRIVAL_DELAY_MS + (latencyMs || 0);
    const nextMe = meStarts.find((s) => s > atMs);
    return nextMe != null && nextMe < deliveredAt ? deliveredAt - nextMe : null;
  }

  console.log(
    `\nReplaying note ${noteId} "${note.title}" — ${utterances.length} utterances, stance ${stance}, level ${intensity}, ` +
      `${checklist.length} checklist items, model ${llm ? `${llm.provider}/${llm.model}` : "none (dry)"}\n`
  );

  const arrivals = utterances
    .map((u) => ({ u, at: base + u.endMs + ARRIVAL_DELAY_MS }))
    .sort((a, b) => a.at - b.at);
  const wallStart = Date.now();
  for (const { u, at } of arrivals) {
    while (now + TICK_MS < at) {
      now += TICK_MS;
      session.tick();
      await session.idle();
    }
    now = at;
    if (verbose) {
      console.log(`[${formatClock(u.startMs)}]   ${u.speaker === "me" ? "ME  " : "THEM"} ${u.text.slice(0, 140)}`);
    }
    session.addUtterance(u);
    session.tick();
    await session.idle();
  }
  // Let the final turn close
  for (let i = 0; i < 20; i++) {
    now += TICK_MS;
    session.tick();
    await session.idle();
  }

  const summary = session.finish();
  const durMin = Math.max(1, summary.durationMs / 60000);
  const byKind = shown.reduce((m, n) => ((m[n.kind] = (m[n.kind] || 0) + 1), m), {});
  const byReason = suppressed.reduce((m, n) => ((m[n.reason] = (m[n.reason] || 0) + 1), m), {});
  const late = shown.filter((n) => n.source === "model" && lateness(n.atMs, n.latencyMs)).length;

  console.log("\n── Summary ─────────────────────────────────────────");
  console.log(`Replayed ${formatClock(summary.durationMs)} in ${((Date.now() - wallStart) / 1000).toFixed(0)}s`);
  console.log(
    `Suggestions shown: ${summary.nudgesShown} (${(summary.nudgesShown / (durMin / 10)).toFixed(1)} per 10 min) ${JSON.stringify(byKind)}`
  );
  console.log(`Held back: ${summary.nudgesSuppressed} ${JSON.stringify(byReason)}`);
  console.log(`Late (arrived after you'd started talking again): ${late}`);
  const avgModel = modelTimes.length ? modelTimes.reduce((a, b) => a + b, 0) / modelTimes.length : null;
  console.log(
    `Model calls: ${summary.llmCalls}${avgModel != null ? `, avg model time ${(avgModel / 1000).toFixed(2)}s (max ${(Math.max(...modelTimes) / 1000).toFixed(2)}s)` : ""}`
  );
  if (usage.length) {
    let peak = 0;
    for (const u of usage) {
      const inWindow = usage.filter((v) => v.atMs >= u.atMs - 60000 && v.atMs <= u.atMs);
      peak = Math.max(peak, inWindow.reduce((n, v) => n + v.tokens, 0));
    }
    const total = usage.reduce((n, v) => n + v.tokens, 0);
    console.log(
      `Tokens: ${total} total, ~${Math.round(total / durMin)}/min average, peak ${peak} in any minute of the meeting (Groq free limit: 8000/min)`
    );
  }
  if (waitedMs) console.log(`(Replay paused ${(waitedMs / 1000).toFixed(0)}s for rate limits — a side effect of replaying faster than real time)`);
  if (summary.coverage.length) {
    console.log(`Coverage: ${summary.coverage.filter((c) => c.covered).length}/${summary.coverage.length}`);
    for (const c of summary.coverage) console.log(`  ${c.covered ? "✓" : "✗"} ${c.text}`);
  }
  if (summary.talkShareMe != null) console.log(`Your talk share: ${Math.round(summary.talkShareMe * 100)}%`);
  if (summary.toneTimeline.length) {
    const counts = summary.toneTimeline.reduce((m, t) => ((m[t.label] = (m[t.label] || 0) + 1), m), {});
    console.log(`Tone verdicts: ${JSON.stringify(counts)}`);
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
