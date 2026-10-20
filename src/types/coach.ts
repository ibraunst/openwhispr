export type CoachStance = "firm" | "collaborative" | "supportive" | "persuasive" | "custom";
export type CoachChecklistKind = "goal" | "question" | "fact" | "objection";
export type CoachNudgeKind = "tone" | "answer" | "missing" | "next" | "monologue" | "time";
export type CoachIntensity = "light" | "balanced" | "active";
export const COACH_INTENSITIES: CoachIntensity[] = ["light", "balanced", "active"];
export type CoachToneLabel = "passive" | "on_stance" | "aggressive" | "rambling" | "unclear";

export const COACH_STANCES: Exclude<CoachStance, "custom">[] = [
  "firm",
  "collaborative",
  "supportive",
  "persuasive",
];

export interface CoachChecklistItem {
  id: string;
  kind: CoachChecklistKind;
  text: string;
  detail?: string;
}

export interface CoachPrepSource {
  id: string;
  name: string;
  kind: "file" | "paste";
  chars: number;
  truncated?: boolean;
  addedAt?: string;
}

export interface CoachPrep {
  noteId: number;
  sources: CoachPrepSource[];
  checklist: CoachChecklistItem[];
  stance: CoachStance | null;
  stanceCustom: string;
  stanceReason: string;
  stanceInherited: boolean;
  enabled: boolean;
  /** null = use the default level from Settings */
  intensity: CoachIntensity | null;
  builtAt: string | null;
}

export interface CoachProsody {
  voicedMs: number;
  meanDb: number | null;
  pitchMedianHz: number | null;
  endRiseSemitones: number | null;
  longestPauseMs: number;
}

export interface CoachUtterance {
  speaker: "me" | "them";
  text: string;
  startMs: number;
  endMs: number;
  prosody: CoachProsody;
}

export interface CoachNudge {
  id: number;
  kind: CoachNudgeKind;
  headline: string;
  fix: string;
  include: string[];
  params: { seconds?: number; items?: string[] } | null;
  source: "model" | "local";
  atMs: number;
  shownAt: number;
  expiresAt: number;
}

export interface CoachOverlayState {
  active: boolean;
  paused?: boolean;
  thinking?: boolean;
  llmAvailable?: boolean;
  error?: string | null;
  stance?: CoachStance;
  stanceCustom?: string;
  intensity?: CoachIntensity;
  checklist?: Array<{
    id: string;
    kind: CoachChecklistKind;
    text: string;
    covered: boolean;
    coveredBy: "me" | "them" | null;
  }>;
  nudge?: CoachNudge | null;
  tone?: { label: CoachToneLabel; score: number } | null;
  talkShareMe?: number | null;
  monologueSec?: number;
  leakWarning?: boolean;
  minutesLeft?: number | null;
  endWarned?: boolean;
  hotkey?: string | null;
  hotkeyError?: boolean;
  configError?: string | null;
  llm?: { provider: string; model: string; fallback?: string | null } | null;
  llmStatus?: {
    primary: string;
    fallback: string;
    fallbackActive: boolean;
    reason: "rate_limited" | "auth" | "error" | null;
  } | null;
}

export type CoachOverlayAction =
  | { type: "ask" }
  | { type: "dismiss" }
  | { type: "stance"; stance: CoachStance }
  | { type: "intensity"; intensity: CoachIntensity }
  | { type: "resize"; height: number };

export interface CoachSessionSummary {
  stance: CoachStance;
  stanceCustom?: string;
  durationMs: number;
  coverage: Array<
    CoachChecklistItem & {
      covered: boolean;
      coveredAtMs: number | null;
      coveredBy: "me" | "them" | null;
    }
  >;
  followUps: Record<string, string>;
  talkShareMe: number | null;
  myTalkMs: number;
  theirTalkMs: number;
  leakRatio: number;
  toneTimeline: Array<{ atMs: number; label: CoachToneLabel; score: number; confidence: number }>;
  nudgesShown: number;
  nudgesSuppressed: number;
  llmCalls: number;
  llmAvgLatencyMs: number | null;
}

export interface CoachSessionEvent {
  atMs: number;
  kind: "nudge" | "covered" | "suppressed" | "stance";
  data: {
    kind?: CoachNudgeKind;
    headline?: string;
    fix?: string;
    include?: string[];
    params?: { seconds?: number; items?: string[] } | null;
    source?: "model" | "local";
    id?: string;
    text?: string;
    by?: "me" | "them" | null;
    stance?: CoachStance;
    reason?: string;
  } | null;
}

export interface CoachSessionRecord {
  id: number;
  noteId: number;
  meetingId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: CoachSessionSummary | null;
  events: CoachSessionEvent[];
}

export interface CoachResult {
  success: boolean;
  error?: string;
  code?: string;
}
