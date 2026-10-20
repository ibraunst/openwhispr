import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Headphones,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "./lib/utils";
import {
  COACH_INTENSITIES,
  COACH_STANCES,
  type CoachNudge,
  type CoachOverlayAction,
  type CoachOverlayState,
  type CoachStance,
} from "../types/coach";

const NUDGE_TONE: Record<CoachNudge["kind"], string> = {
  tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  answer: "bg-primary/15 text-primary",
  missing: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  next: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  monologue: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  time: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

function formatHotkey(accelerator: string | null | undefined): string {
  if (!accelerator) return "";
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return accelerator
    .split("+")
    .map((part) => {
      if (!isMac) return part.replace("CommandOrControl", "Ctrl");
      switch (part) {
        case "Control":
          return "⌃";
        case "Alt":
        case "Option":
          return "⌥";
        case "Shift":
          return "⇧";
        case "Command":
        case "CommandOrControl":
        case "Cmd":
          return "⌘";
        default:
          return part;
      }
    })
    .join(isMac ? "" : "+");
}

function NudgeCard({ nudge, onDismiss }: { nudge: CoachNudge; onDismiss: () => void }) {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState(1);

  useEffect(() => {
    const total = Math.max(1, nudge.expiresAt - nudge.shownAt);
    const startedAt = Date.now();
    const initialLeft = nudge.expiresAt - nudge.shownAt;
    const id = window.setInterval(() => {
      const left = initialLeft - (Date.now() - startedAt);
      setRemaining(Math.max(0, left / total));
    }, 200);
    return () => window.clearInterval(id);
  }, [nudge.id, nudge.expiresAt, nudge.shownAt]);

  const isLocal = nudge.source === "local";
  const headline = isLocal
    ? nudge.kind === "monologue"
      ? t("coach.overlay.monologueHeadline")
      : t("coach.overlay.timeHeadline")
    : nudge.headline;
  const fix = isLocal
    ? nudge.kind === "monologue"
      ? t("coach.overlay.monologueFix", { seconds: nudge.params?.seconds ?? 90 })
      : t("coach.overlay.timeFix")
    : nudge.fix;
  const include = isLocal ? (nudge.params?.items ?? []) : nudge.include;

  return (
    <div className="mx-2 mb-2 rounded-lg border border-border/40 bg-background/70 dark:bg-surface-2/70 p-2.5 animate-[float-up_0.2s_ease-out]">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            NUDGE_TONE[nudge.kind]
          )}
        >
          {t(`coach.kind.${nudge.kind}`)}
        </span>
        <p className="flex-1 min-w-0 text-[13px] font-semibold leading-snug text-foreground">
          {headline}
        </p>
        <button
          onClick={onDismiss}
          aria-label={t("coach.overlay.dismiss")}
          className="shrink-0 -mr-1 -mt-0.5 p-0.5 text-muted-foreground/60 hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <X size={12} />
        </button>
      </div>
      {fix && <p className="mt-1 text-[12px] leading-snug text-foreground/80">{fix}</p>}
      {include.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {include.map((item) => (
            <li key={item} className="flex gap-1.5 text-[11.5px] leading-snug text-foreground/75">
              <span className="text-primary">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 h-[2px] rounded-full bg-muted-foreground/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary/40 transition-[width] duration-200 ease-linear"
          style={{ width: `${remaining * 100}%` }}
        />
      </div>
    </div>
  );
}

function ToneMeter({ score }: { score: number }) {
  const { t } = useTranslation();
  // score: -1 passive … 0 on stance … +1 aggressive
  const position = ((Math.max(-1, Math.min(1, score)) + 1) / 2) * 100;
  const offStance = Math.abs(score) > 0.35;
  return (
    <div className="flex-1 min-w-0">
      <div className="flex justify-between text-[9px] uppercase tracking-wide text-muted-foreground/70">
        <span>{t("coach.overlay.passive")}</span>
        <span>{t("coach.overlay.aggressive")}</span>
      </div>
      <div className="relative mt-0.5 h-1.5 rounded-full bg-gradient-to-r from-amber-400/40 via-emerald-400/40 to-rose-400/40">
        <div
          className={cn(
            "absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow",
            offStance ? "bg-amber-500" : "bg-emerald-500"
          )}
          style={{ left: `${position}%` }}
        />
      </div>
    </div>
  );
}

export default function CoachOverlay() {
  const { t } = useTranslation();
  const [state, setState] = useState<CoachOverlayState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [stanceOpen, setStanceOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanup = window.electronAPI?.onCoachState?.((next) => setState(next));
    window.electronAPI
      ?.coachOverlayGetState?.()
      .then((initial) => setState((prev) => prev ?? initial))
      .catch(() => setState({ active: false }));
    return () => cleanup?.();
  }, []);

  // The window is sized to the content (collapsed vs. full checklist)
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = () =>
      window.electronAPI?.coachOverlayAction?.({ type: "resize", height: el.offsetHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const act = useCallback((action: CoachOverlayAction) => {
    window.electronAPI
      ?.coachOverlayAction?.(action)
      .then((next) => next && setState(next))
      .catch(() => {});
  }, []);

  const pickStance = useCallback(
    (stance: CoachStance) => {
      setStanceOpen(false);
      act({ type: "stance", stance });
    },
    [act]
  );

  const checklist = state?.checklist ?? [];
  const coveredCount = checklist.filter((i) => i.covered).length;
  const talkShare = state?.talkShareMe;
  const statusDot = state?.paused
    ? "bg-muted-foreground/50"
    : state?.thinking
      ? "bg-amber-400 animate-pulse"
      : state?.llmAvailable === false
        ? "bg-rose-500"
        : "bg-emerald-500";

  const stanceLabel =
    state?.stance === "custom"
      ? state.stanceCustom || t("coach.stance.custom")
      : t(`coach.stance.${state?.stance ?? "collaborative"}`);

  const providerLabel = (key?: string) =>
    ({ anthropic: "Anthropic", openai: "OpenAI", groq: "Groq", gemini: "Gemini" })[key ?? ""] ??
    key ??
    "";
  const fallbackNotice = state?.llmStatus?.fallbackActive
    ? state.llmStatus.reason === "rate_limited"
      ? t("coach.overlay.fallbackRateLimited", { provider: providerLabel(state.llmStatus.primary) })
      : t("coach.overlay.fallbackError", { provider: providerLabel(state.llmStatus.primary) })
    : null;

  const modelProblem = state?.configError
    ? t("coach.overlay.noKey")
    : state?.llmAvailable === false
      ? t("coach.overlay.modelPaused", { error: state?.error || "" })
      : null;

  return (
    <div ref={rootRef} className="coach-overlay-window w-full p-1.5 select-none">
      <div className="glass-float rounded-xl border overflow-hidden">
        {/* Header — drag handle */}
        <div className="flex items-center gap-2 px-2.5 py-2 [-webkit-app-region:drag]">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", statusDot)} />
          <span className="text-[12px] font-semibold text-foreground">
            {t("coach.overlay.title")}
          </span>
          <button
            onClick={() => setStanceOpen((v) => !v)}
            className="min-w-0 truncate rounded-md bg-foreground/5 dark:bg-white/5 px-1.5 py-0.5 text-[10.5px] font-medium text-foreground/70 hover:text-foreground [-webkit-app-region:no-drag]"
            title={t("coach.overlay.changeStance")}
          >
            {stanceLabel}
          </button>
          <div className="flex-1" />
          {checklist.length > 0 && (
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
              {coveredCount}/{checklist.length}
            </span>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t("coach.overlay.expand") : t("coach.overlay.collapse")}
            className="shrink-0 p-0.5 text-muted-foreground/70 hover:text-foreground [-webkit-app-region:no-drag]"
          >
            {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
        </div>

        {stanceOpen && (
          <div className="mx-2 mb-2 space-y-1.5 [-webkit-app-region:no-drag]">
            <div className="flex flex-wrap gap-1">
              {COACH_STANCES.map((stance) => (
                <button
                  key={stance}
                  onClick={() => pickStance(stance)}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    state?.stance === stance
                      ? "bg-primary text-primary-foreground"
                      : "bg-foreground/5 dark:bg-white/5 text-foreground/70 hover:text-foreground"
                  )}
                >
                  {t(`coach.stance.${stance}`)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="mr-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {t("coach.overlay.level")}
              </span>
              {COACH_INTENSITIES.map((level) => (
                <button
                  key={level}
                  onClick={() => act({ type: "intensity", intensity: level })}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                    state?.intensity === level
                      ? "bg-foreground/80 text-background"
                      : "bg-foreground/5 dark:bg-white/5 text-foreground/70 hover:text-foreground"
                  )}
                >
                  {t(`coach.intensity.${level}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {!state?.active && (
          <p className="px-3 pb-3 text-[11.5px] text-muted-foreground">{t("coach.overlay.idle")}</p>
        )}

        {state?.nudge && (
          <NudgeCard nudge={state.nudge} onDismiss={() => act({ type: "dismiss" })} />
        )}

        {state?.active && !collapsed && (
          <>
            {state.paused && (
              <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                {t("coach.overlay.paused")}
              </p>
            )}

            {(talkShare != null || state.tone) && (
              <div className="flex items-center gap-3 px-3 pb-2">
                {talkShare != null && (
                  <div className="w-[88px] shrink-0">
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground/70">
                      {t("coach.overlay.youTalk", { percent: Math.round(talkShare * 100) })}
                    </div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          talkShare > 0.65 ? "bg-amber-500" : "bg-primary/70"
                        )}
                        style={{ width: `${Math.round(talkShare * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
                {state.tone && <ToneMeter score={state.tone.score} />}
              </div>
            )}

            {state.leakWarning && (
              <div className="mx-2 mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[10.5px] leading-snug text-amber-700 dark:text-amber-400">
                <Headphones size={12} className="shrink-0" />
                {t("coach.overlay.leakWarning")}
              </div>
            )}

            {modelProblem && (
              <div className="mx-2 mb-2 flex items-start gap-1.5 rounded-md bg-rose-500/10 px-2 py-1.5 text-[10.5px] leading-snug text-rose-700 dark:text-rose-400">
                <AlertTriangle size={12} className="mt-px shrink-0" />
                <span className="min-w-0 break-words">{modelProblem}</span>
              </div>
            )}

            {fallbackNotice && !modelProblem && (
              <p className="px-3 pb-2 text-[10.5px] text-muted-foreground">{fallbackNotice}</p>
            )}

            {checklist.length > 0 ? (
              <ul className="max-h-[220px] overflow-y-auto px-3 pb-2 space-y-1 [-webkit-app-region:no-drag]">
                {checklist.map((item) => (
                  <li key={item.id} className="flex items-start gap-1.5">
                    {item.covered ? (
                      <Check size={12} className="mt-[2px] shrink-0 text-emerald-500" />
                    ) : (
                      <Circle
                        size={11}
                        className={cn(
                          "mt-[3px] shrink-0",
                          state.endWarned ? "text-rose-500" : "text-muted-foreground/50"
                        )}
                      />
                    )}
                    <span
                      className={cn(
                        "text-[11.5px] leading-snug",
                        item.covered
                          ? "text-muted-foreground/60 line-through"
                          : state.endWarned
                            ? "text-foreground font-medium"
                            : "text-foreground/85"
                      )}
                    >
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                {t("coach.overlay.noChecklist")}
              </p>
            )}

            {state.minutesLeft != null && (
              <p className="px-3 pb-1 text-[10px] text-muted-foreground/70">
                {t("coach.overlay.minutesLeft", { count: state.minutesLeft })}
              </p>
            )}

            <div className="flex items-center gap-2 border-t border-border/30 px-2.5 py-2 [-webkit-app-region:no-drag]">
              <button
                onClick={() => act({ type: "ask" })}
                disabled={state.llmAvailable === false || state.thinking || state.paused}
                className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              >
                {state.thinking ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Sparkles size={11} />
                )}
                {t("coach.overlay.askNext")}
              </button>
              {state.hotkey && (
                <span className="text-[10px] text-muted-foreground/70">
                  {formatHotkey(state.hotkey)}
                </span>
              )}
              {state.hotkeyError && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400">
                  {t("coach.overlay.hotkeyUnavailable")}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
