import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardPaste,
  FileUp,
  Flag,
  HelpCircle,
  Loader2,
  Plus,
  Shield,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/Toast";
import { useSettingsStore } from "../../stores/settingsStore";
import logger from "../../utils/logger";
import {
  COACH_INTENSITIES,
  COACH_STANCES,
  type CoachIntensity,
  type CoachChecklistItem,
  type CoachChecklistKind,
  type CoachPrep,
  type CoachSessionRecord,
  type CoachStance,
} from "../../types/coach";

const KIND_ORDER: CoachChecklistKind[] = ["goal", "question", "fact", "objection"];
const KIND_ICON: Record<CoachChecklistKind, typeof Target> = {
  goal: Target,
  question: HelpCircle,
  fact: Flag,
  objection: Shield,
};

const SAVE_DEBOUNCE_MS = 500;

function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

function newItemId() {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface CoachingPanelProps {
  noteId: number;
  isRecordingThisNote: boolean;
  hasRecording: boolean;
  onSeek?: (ms: number) => void;
}

export default function CoachingPanel({
  noteId,
  isRecordingThisNote,
  hasRecording,
  onSeek,
}: CoachingPanelProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const coachProvider = useSettingsStore((s) => s.coachProvider);
  const coachModel = useSettingsStore((s) => s.coachModel);
  const uiLanguage = useSettingsStore((s) => s.uiLanguage);
  const defaultIntensity = useSettingsStore((s) => s.coachIntensity) as CoachIntensity;

  const [prep, setPrep] = useState<CoachPrep | null>(null);
  const [session, setSession] = useState<CoachSessionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<CoachChecklistItem[]>([]);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [customStance, setCustomStance] = useState("");

  const saveTimerRef = useRef<number | null>(null);
  const pendingChecklistRef = useRef<{ noteId: number; checklist: CoachChecklistItem[] } | null>(
    null
  );

  const flushChecklist = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingChecklistRef.current;
    pendingChecklistRef.current = null;
    if (!pending) return;
    window.electronAPI
      ?.coachSavePrep?.(pending.noteId, { checklist: pending.checklist })
      .then((res) => {
        if (!res?.success) throw new Error(res?.error || "save failed");
      })
      .catch((err: Error) => {
        logger.error("Failed to save coach checklist", { error: err.message }, "coach");
        toast({
          title: t("coach.panel.saveFailed"),
          description: err.message,
          variant: "destructive",
        });
      });
  }, [toast, t]);

  const loadSession = useCallback(async (id: number) => {
    try {
      const res = await window.electronAPI?.coachGetSession?.(id);
      if (res?.success) setSession(res.session ?? null);
    } catch (err) {
      logger.error("Failed to load coach session", { error: (err as Error).message }, "coach");
    }
  }, []);

  // Load on note switch; flush unsaved checklist edits of the previous note
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setBuildError(null);
    setPasteOpen(false);
    setPasteText("");
    (async () => {
      try {
        const res = await window.electronAPI?.coachGetPrep?.(noteId);
        if (cancelled) return;
        if (!res?.success || !res.prep) throw new Error(res?.error || "unavailable");
        setPrep(res.prep);
        setChecklist(res.prep.checklist);
        setCustomStance(res.prep.stanceCustom || "");
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadSession(noteId);
    return () => {
      cancelled = true;
      flushChecklist();
    };
  }, [noteId, loadSession, flushChecklist]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onCoachSessionUpdated?.((data) => {
      if (data?.noteId === noteId) void loadSession(noteId);
    });
    return () => cleanup?.();
  }, [noteId, loadSession]);

  // Prep pushed from Claude Cowork (connector) while this note is open
  useEffect(() => {
    const cleanup = window.electronAPI?.onCoachPrepUpdated?.(async (data) => {
      if (data?.noteId !== noteId) return;
      try {
        const res = await window.electronAPI?.coachGetPrep?.(noteId);
        if (res?.success && res.prep) {
          pendingChecklistRef.current = null;
          setPrep(res.prep);
          setChecklist(res.prep.checklist);
          setCustomStance(res.prep.stanceCustom || "");
        }
      } catch (err) {
        logger.error("Failed to reload coach prep", { error: (err as Error).message }, "coach");
      }
    });
    return () => cleanup?.();
  }, [noteId]);

  const applyResult = useCallback(
    (
      res: { success: boolean; error?: string; prep?: CoachPrep } | undefined,
      failTitle: string
    ) => {
      if (res?.success && res.prep) {
        setPrep(res.prep);
        setChecklist(res.prep.checklist);
        return true;
      }
      toast({ title: failTitle, description: res?.error, variant: "destructive" });
      return false;
    },
    [toast]
  );

  const savePatch = useCallback(
    async (
      patch: Partial<Pick<CoachPrep, "stance" | "stanceCustom" | "enabled" | "intensity">>
    ) => {
      try {
        const res = await window.electronAPI?.coachSavePrep?.(noteId, patch);
        if (res?.success && res.prep) {
          // Keep in-progress checklist edits; take everything else from the store
          setPrep((prev) => ({ ...res.prep!, checklist: prev?.checklist ?? res.prep!.checklist }));
        } else {
          throw new Error(res?.error || "save failed");
        }
      } catch (err) {
        toast({
          title: t("coach.panel.saveFailed"),
          description: (err as Error).message,
          variant: "destructive",
        });
      }
    },
    [noteId, toast, t]
  );

  const updateChecklist = useCallback(
    (next: CoachChecklistItem[]) => {
      setChecklist(next);
      pendingChecklistRef.current = { noteId, checklist: next };
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(flushChecklist, SAVE_DEBOUNCE_MS);
    },
    [noteId, flushChecklist]
  );

  const handleAddFile = useCallback(async () => {
    setAdding(true);
    try {
      const res = await window.electronAPI?.coachAddPrepFile?.(noteId);
      if (res?.canceled) return;
      if (res?.success && res.prep) {
        setPrep(res.prep);
      } else {
        throw new Error(res?.error || "failed");
      }
      for (const failure of res.failures ?? []) {
        toast({
          title: t("coach.panel.fileFailed", { name: failure.name }),
          description: failure.error,
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: t("coach.panel.addFailed"),
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setAdding(false);
    }
  }, [noteId, toast, t]);

  const handleAddPaste = useCallback(async () => {
    if (!pasteText.trim()) return;
    setAdding(true);
    try {
      const firstLine = pasteText
        .trim()
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .slice(0, 60);
      const res = await window.electronAPI?.coachAddPrepText?.(noteId, firstLine, pasteText);
      if (applyResult(res, t("coach.panel.addFailed"))) {
        setPasteText("");
        setPasteOpen(false);
      }
    } finally {
      setAdding(false);
    }
  }, [noteId, pasteText, applyResult, t]);

  const handleRemoveSource = useCallback(
    async (sourceId: string) => {
      const res = await window.electronAPI?.coachRemovePrepSource?.(noteId, sourceId);
      applyResult(res, t("coach.panel.saveFailed"));
    },
    [noteId, applyResult, t]
  );

  const handleBuild = useCallback(async () => {
    flushChecklist();
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await window.electronAPI?.coachBuildPlan?.(noteId, {
        provider: coachProvider,
        model: coachModel,
        language: uiLanguage,
      });
      if (res?.success && res.prep) {
        setPrep(res.prep);
        setChecklist(res.prep.checklist);
        setCustomStance(res.prep.stanceCustom || "");
      } else {
        setBuildError(
          res?.code === "missing_key"
            ? t("coach.panel.noKey")
            : res?.error || t("coach.panel.buildFailed")
        );
      }
    } catch (err) {
      setBuildError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }, [noteId, coachProvider, coachModel, uiLanguage, flushChecklist, t]);

  const handleStance = useCallback(
    (stance: CoachStance) => {
      setPrep((prev) => (prev ? { ...prev, stance, stanceInherited: false } : prev));
      void savePatch({ stance });
    },
    [savePatch]
  );

  const summary = session?.summary ?? null;
  const nudgeEvents = useMemo(
    () => (session?.events ?? []).filter((e) => e.kind === "nudge" && e.data),
    [session]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t("coach.panel.loading")}
      </div>
    );
  }

  if (loadError || !prep) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-destructive">
        <AlertTriangle size={14} />
        {t("coach.panel.loadFailed", { error: loadError || "" })}
      </div>
    );
  }

  const sectionTitle = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80";
  const pill =
    "rounded-md px-2 py-1 text-[11px] font-medium transition-colors bg-foreground/4 dark:bg-white/5 text-foreground/70 hover:text-foreground";

  return (
    <div className="px-5 py-4 pb-28 space-y-6 max-w-2xl">
      {/* Enable */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t("coach.panel.enableTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isRecordingThisNote
              ? prep.enabled
                ? t("coach.panel.liveNow")
                : t("coach.panel.liveNextTime")
              : t("coach.panel.enableHint")}
          </p>
        </div>
        <Toggle checked={prep.enabled} onChange={(enabled) => void savePatch({ enabled })} />
      </div>

      {/* Prep material */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className={sectionTitle}>{t("coach.panel.prepTitle")}</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={handleAddFile}
              disabled={adding}
              className={cn(pill, "flex items-center gap-1")}
            >
              {adding ? <Loader2 size={11} className="animate-spin" /> : <FileUp size={11} />}
              {t("coach.panel.addFile")}
            </button>
            <button
              onClick={() => setPasteOpen((v) => !v)}
              className={cn(pill, "flex items-center gap-1", pasteOpen && "text-foreground")}
            >
              <ClipboardPaste size={11} />
              {t("coach.panel.pasteText")}
            </button>
          </div>
        </div>

        {pasteOpen && (
          <div className="space-y-2">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={t("coach.panel.pastePlaceholder")}
              rows={6}
              className="w-full rounded-md border border-border/50 bg-background px-3 py-2 text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <div className="flex justify-end gap-1.5">
              <button onClick={() => setPasteOpen(false)} className={pill}>
                {t("coach.panel.cancel")}
              </button>
              <button
                onClick={handleAddPaste}
                disabled={!pasteText.trim() || adding}
                className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
              >
                {t("coach.panel.addPaste")}
              </button>
            </div>
          </div>
        )}

        {prep.sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("coach.panel.noSources")}</p>
        ) : (
          <ul className="space-y-1">
            {prep.sources.map((source) => (
              <li
                key={source.id}
                className="flex items-center gap-2 rounded-md bg-foreground/3 dark:bg-white/3 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">
                  {source.name}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {t("coach.panel.chars", { count: source.chars })}
                  {source.truncated ? ` · ${t("coach.panel.truncated")}` : ""}
                </span>
                <button
                  onClick={() => void handleRemoveSource(source.id)}
                  aria-label={t("coach.panel.removeSource")}
                  className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleBuild}
            disabled={building || prep.sources.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {building ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {building
              ? t("coach.panel.building")
              : prep.builtAt
                ? t("coach.panel.rebuild")
                : t("coach.panel.build")}
          </button>
          {prep.builtAt && !building && (
            <span className="text-[11px] text-muted-foreground">
              {t("coach.panel.rebuildHint")}
            </span>
          )}
        </div>
        {buildError && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {buildError}
          </p>
        )}
      </section>

      {/* Stance */}
      <section className="space-y-2">
        <h3 className={sectionTitle}>{t("coach.panel.stanceTitle")}</h3>
        <div className="flex flex-wrap gap-1">
          {[...COACH_STANCES, "custom" as const].map((stance) => (
            <button
              key={stance}
              onClick={() => handleStance(stance)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                (prep.stance ?? "collaborative") === stance
                  ? "bg-primary text-primary-foreground"
                  : "bg-foreground/4 dark:bg-white/5 text-foreground/70 hover:text-foreground"
              )}
            >
              {t(`coach.stance.${stance}`)}
            </button>
          ))}
        </div>
        {prep.stance === "custom" && (
          <input
            value={customStance}
            onChange={(e) => setCustomStance(e.target.value)}
            onBlur={() => {
              if (customStance !== prep.stanceCustom)
                void savePatch({ stanceCustom: customStance });
            }}
            placeholder={t("coach.panel.customStancePlaceholder")}
            className="w-full h-8 rounded-md border border-border/50 bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        )}
        <p className="text-[11px] text-muted-foreground">
          {prep.stanceInherited
            ? t("coach.panel.stanceInherited")
            : prep.stanceReason
              ? t("coach.panel.stanceReason", { reason: prep.stanceReason })
              : !prep.stance
                ? t("coach.panel.stanceDefault")
                : ""}
        </p>
      </section>

      {/* Coaching level */}
      <section className="space-y-2">
        <h3 className={sectionTitle}>{t("coach.panel.intensityTitle")}</h3>
        <div className="flex flex-wrap gap-1">
          {([null, ...COACH_INTENSITIES] as Array<CoachIntensity | null>).map((level) => (
            <button
              key={level ?? "default"}
              onClick={() => {
                setPrep((prev) => (prev ? { ...prev, intensity: level } : prev));
                void savePatch({ intensity: level });
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                prep.intensity === level
                  ? "bg-primary text-primary-foreground"
                  : "bg-foreground/4 dark:bg-white/5 text-foreground/70 hover:text-foreground"
              )}
            >
              {level
                ? t(`coach.intensity.${level}`)
                : t("coach.panel.intensityDefault", {
                    level: t(
                      `coach.intensity.${COACH_INTENSITIES.includes(defaultIntensity) ? defaultIntensity : "balanced"}`
                    ),
                  })}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t(
            `coach.intensityHint.${prep.intensity ?? (COACH_INTENSITIES.includes(defaultIntensity) ? defaultIntensity : "balanced")}`
          )}
        </p>
      </section>

      {/* Checklist */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className={sectionTitle}>{t("coach.panel.checklistTitle")}</h3>
          <button
            onClick={() =>
              updateChecklist([
                ...checklist,
                { id: newItemId(), kind: "question", text: "", detail: "" },
              ])
            }
            className={cn(pill, "flex items-center gap-1")}
          >
            <Plus size={11} />
            {t("coach.panel.addItem")}
          </button>
        </div>
        {checklist.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("coach.panel.noChecklist")}</p>
        ) : (
          <ul className="space-y-1">
            {checklist.map((item, index) => {
              const Icon = KIND_ICON[item.kind] ?? Target;
              return (
                <li key={item.id} className="group flex items-start gap-1.5">
                  <button
                    onClick={() => {
                      const nextKind =
                        KIND_ORDER[(KIND_ORDER.indexOf(item.kind) + 1) % KIND_ORDER.length];
                      updateChecklist(
                        checklist.map((c) => (c.id === item.id ? { ...c, kind: nextKind } : c))
                      );
                    }}
                    title={t(`coach.checklistKind.${item.kind}`)}
                    className="mt-1.5 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon size={13} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <input
                      value={item.text}
                      onChange={(e) =>
                        updateChecklist(
                          checklist.map((c) =>
                            c.id === item.id ? { ...c, text: e.target.value } : c
                          )
                        )
                      }
                      placeholder={t("coach.panel.itemPlaceholder")}
                      className="w-full h-7 rounded-md bg-transparent px-1.5 text-xs text-foreground hover:bg-foreground/3 focus:bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
                    />
                    {item.detail && (
                      <p className="px-1.5 text-[11px] leading-snug text-muted-foreground">
                        {item.detail}
                      </p>
                    )}
                  </div>
                  <div className="mt-1 flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...checklist];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        updateChecklist(next);
                      }}
                      aria-label={t("coach.panel.moveUp")}
                      className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      disabled={index === checklist.length - 1}
                      onClick={() => {
                        const next = [...checklist];
                        [next[index + 1], next[index]] = [next[index], next[index + 1]];
                        updateChecklist(next);
                      }}
                      aria-label={t("coach.panel.moveDown")}
                      className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      onClick={() => updateChecklist(checklist.filter((c) => c.id !== item.id))}
                      aria-label={t("coach.panel.deleteItem")}
                      className="p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Last coached session */}
      {summary && session && (
        <section className="space-y-3 border-t border-border/30 pt-5">
          <h3 className={sectionTitle}>{t("coach.panel.sessionTitle")}</h3>
          <p className="text-xs text-muted-foreground">
            {[
              summary.talkShareMe != null
                ? t("coach.panel.talkShare", { percent: Math.round(summary.talkShareMe * 100) })
                : null,
              t("coach.panel.suggestionCount", { count: summary.nudgesShown }),
              summary.llmAvgLatencyMs != null
                ? t("coach.panel.avgLatency", {
                    seconds: (summary.llmAvgLatencyMs / 1000).toFixed(1),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {summary.leakRatio >= 0.25 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {t("coach.panel.leakNote")}
            </p>
          )}

          {summary.coverage.length > 0 && (
            <ul className="space-y-1.5">
              {summary.coverage.map((item) => (
                <li key={item.id} className="flex items-start gap-2">
                  {item.covered ? (
                    <Check size={13} className="mt-0.5 shrink-0 text-emerald-500" />
                  ) : (
                    <X size={13} className="mt-0.5 shrink-0 text-rose-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-foreground/90">{item.text}</p>
                    {item.covered ? (
                      <p className="text-[11px] text-muted-foreground">
                        {item.coveredBy
                          ? t(`coach.panel.coveredBy.${item.coveredBy}`)
                          : t("coach.panel.coveredBy.unknown")}
                        {item.coveredAtMs != null && (
                          <>
                            {" · "}
                            <TimeLink
                              ms={item.coveredAtMs}
                              onSeek={hasRecording ? onSeek : undefined}
                            />
                          </>
                        )}
                      </p>
                    ) : summary.followUps?.[item.id] ? (
                      <p className="text-[11px] text-muted-foreground">
                        {t("coach.panel.followUp", { text: summary.followUps[item.id] })}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {nudgeEvents.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                {t("coach.panel.timelineTitle")}
              </p>
              <ul className="space-y-1.5">
                {nudgeEvents.map((event, i) => {
                  const data = event.data!;
                  const isLocal = data.source === "local";
                  const headline = isLocal
                    ? data.kind === "monologue"
                      ? t("coach.overlay.monologueHeadline")
                      : t("coach.overlay.timeHeadline")
                    : data.headline;
                  return (
                    <li key={`${event.atMs}-${i}`} className="flex items-start gap-2 text-xs">
                      <TimeLink ms={event.atMs} onSeek={hasRecording ? onSeek : undefined} />
                      <span className="shrink-0 rounded bg-foreground/5 dark:bg-white/5 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t(`coach.kind.${data.kind ?? "next"}`)}
                      </span>
                      <span className="min-w-0 flex-1 text-foreground/85">
                        {headline}
                        {!isLocal && data.fix ? (
                          <span className="text-muted-foreground"> — {data.fix}</span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function TimeLink({ ms, onSeek }: { ms: number; onSeek?: (ms: number) => void }) {
  if (!onSeek) {
    return <span className="shrink-0 tabular-nums text-muted-foreground">{formatClock(ms)}</span>;
  }
  return (
    <button
      onClick={() => onSeek(ms)}
      className="shrink-0 tabular-nums text-primary hover:underline"
    >
      {formatClock(ms)}
    </button>
  );
}
