import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, Check, Info, Loader2, Mail, Pencil, Plus, Trash2, Unlink, UserRound, Users } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { ConfirmDialog } from "./ui/dialog";
import {
  useSettingsStore,
  DIARIZATION_ME_THRESHOLD_DEFAULT,
  DIARIZATION_MATCH_THRESHOLD_DEFAULT,
  SHERPA_ME_THRESHOLD_DEFAULT,
  SHERPA_MATCH_THRESHOLD_DEFAULT,
  SHERPA_CLUSTER_THRESHOLD_DEFAULT,
} from "../stores/settingsStore";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { formatSpeakerName } from "../utils/speakerNameFormatter";
import type { VoiceBankEntry } from "../types/electron";
import googleCalendarIcon from "../assets/icons/google-calendar.svg";

const isMacOS = navigator.userAgent.includes("Mac");

export default function IntegrationsView() {
  const { t } = useTranslation();
  const { gcalAccounts, setGcalAccounts, appleCalendarConnected, setAppleCalendarConnected } =
    useSettingsStore();
  const hfToken = (useSettingsStore.getState() as any).hfToken as string ?? "";
  const setHfToken = (useSettingsStore.getState() as any).setHfToken as (key: string) => void;
  const meThreshold = useSettingsStore((s) => s.diarizationMeThreshold);
  const matchThreshold = useSettingsStore((s) => s.diarizationMatchThreshold);
  const setDiarizationMeThreshold = useSettingsStore((s) => s.setDiarizationMeThreshold);
  const setDiarizationMatchThreshold = useSettingsStore((s) => s.setDiarizationMatchThreshold);
  const diarizationEngine = useSettingsStore((s) => s.diarizationEngine);
  const setDiarizationEngine = useSettingsStore((s) => s.setDiarizationEngine);
  const sherpaMeThreshold = useSettingsStore((s) => s.sherpaMeThreshold);
  const sherpaMatchThreshold = useSettingsStore((s) => s.sherpaMatchThreshold);
  const sherpaClusterThreshold = useSettingsStore((s) => s.sherpaClusterThreshold);
  const setSherpaMeThreshold = useSettingsStore((s) => s.setSherpaMeThreshold);
  const setSherpaMatchThreshold = useSettingsStore((s) => s.setSherpaMatchThreshold);
  const setSherpaClusterThreshold = useSettingsStore((s) => s.setSherpaClusterThreshold);
  const isSherpa = diarizationEngine === "sherpa";
  const [hfTokenInput, setHfTokenInput] = useState(hfToken);
  // State, not a ref: the "saved" flash drives render output, and a ref reset
  // by setTimeout never triggers the re-render that restores the check icon
  const [hfJustSaved, setHfJustSaved] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
  const [confirmDisconnectEmail, setConfirmDisconnectEmail] = useState<string | null>(null);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const [isConnectingAcal, setIsConnectingAcal] = useState(false);
  const [confirmDisconnectAcal, setConfirmDisconnectAcal] = useState(false);
  const [appleCalendars, setAppleCalendars] = useState<Array<{ id: string; title: string; color: string | null; is_selected: number }>>([]);
  const [loadingAcalCalendars, setLoadingAcalCalendars] = useState(false);
  const systemAudio = useSystemAudioPermission();
  const hasAccounts = gcalAccounts.length > 0;

  // Known voices (speaker voicebank)
  const [voices, setVoices] = useState<VoiceBankEntry[]>([]);
  const [renamingVoiceId, setRenamingVoiceId] = useState<string | null>(null);
  const [voiceRenameValue, setVoiceRenameValue] = useState("");
  const [confirmDeleteVoice, setConfirmDeleteVoice] = useState<VoiceBankEntry | null>(null);
  const voiceRenameInputRef = useRef<HTMLInputElement>(null);

  const loadVoices = useCallback(async () => {
    // Each engine has its own voice bank (incompatible embedding spaces) —
    // the list always shows the bank of the selected engine.
    const result = await window.electronAPI?.voicebankList?.({ engine: diarizationEngine });
    if (result?.success && result.voices) setVoices(result.voices);
  }, [diarizationEngine]);

  useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  useEffect(() => {
    if (renamingVoiceId) voiceRenameInputRef.current?.focus();
  }, [renamingVoiceId]);

  const handleVoiceRenameConfirm = useCallback(async () => {
    const id = renamingVoiceId;
    const name = voiceRenameValue.trim();
    setRenamingVoiceId(null);
    setVoiceRenameValue("");
    if (!id || !name) return;
    const current = voices.find((v) => v.id === id);
    if (!current || current.label === name) return;
    await window.electronAPI?.voicebankRename?.({ id, newLabel: name, engine: diarizationEngine });
    loadVoices();
  }, [renamingVoiceId, voiceRenameValue, voices, loadVoices, diarizationEngine]);

  const handleVoiceDelete = useCallback(
    async (id: string) => {
      await window.electronAPI?.voicebankDelete?.(id, diarizationEngine);
      loadVoices();
    },
    [loadVoices, diarizationEngine]
  );

  const startOAuth = useCallback(async () => {
    setIsConnecting(true);
    try {
      const result = await window.electronAPI?.gcalStartOAuth?.();
      if (result?.success && result.email) {
        const current = useSettingsStore.getState().gcalAccounts;
        setGcalAccounts([
          ...current.filter((a) => a.email !== result.email),
          { email: result.email },
        ]);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [setGcalAccounts]);

  const handleConnect = useCallback(async () => {
    if (systemAudio.isMacOS && !systemAudio.granted) {
      setShowPermissionDialog(true);
      return;
    }
    await startOAuth();
  }, [systemAudio.isMacOS, systemAudio.granted, startOAuth]);

  const handleDisconnect = useCallback(
    async (email: string) => {
      setDisconnectingEmail(email);
      try {
        await window.electronAPI?.gcalDisconnect?.(email);
        const current = useSettingsStore.getState().gcalAccounts;
        setGcalAccounts(current.filter((a) => a.email !== email));
      } finally {
        setDisconnectingEmail(null);
      }
    },
    [setGcalAccounts]
  );

  useEffect(() => {
    const unsub = window.electronAPI?.onGcalConnectionChanged?.(
      (data: {
        accounts?: Array<{ email: string }>;
        connected?: boolean;
        email?: string | null;
      }) => {
        if (data.accounts) {
          setGcalAccounts(data.accounts);
        } else if (data.connected && data.email) {
          const current = useSettingsStore.getState().gcalAccounts;
          setGcalAccounts([
            ...current.filter((a) => a.email !== data.email),
            { email: data.email },
          ]);
        }
      }
    );
    return () => unsub?.();
  }, [setGcalAccounts]);

  const fetchAppleCalendars = useCallback(async () => {
    setLoadingAcalCalendars(true);
    try {
      const result = await window.electronAPI?.acalGetCalendars?.();
      if (result?.success && result.calendars) {
        setAppleCalendars(result.calendars);
      }
    } finally {
      setLoadingAcalCalendars(false);
    }
  }, []);

  const handleAcalCalendarToggle = useCallback(async (calendarId: string, isSelected: boolean) => {
    // Optimistic update
    setAppleCalendars((prev) =>
      prev.map((c) => (c.id === calendarId ? { ...c, is_selected: isSelected ? 1 : 0 } : c))
    );
    const result = await window.electronAPI?.acalSetCalendarSelected?.(calendarId, isSelected);
    if (!result?.success) {
      // Revert on failure
      setAppleCalendars((prev) =>
        prev.map((c) => (c.id === calendarId ? { ...c, is_selected: isSelected ? 0 : 1 } : c))
      );
    }
  }, []);

  const handleAcalConnect = useCallback(async () => {
    setIsConnectingAcal(true);
    try {
      const result = await window.electronAPI?.acalConnect?.();
      if (result?.success) {
        setAppleCalendarConnected(true);
        fetchAppleCalendars();
      }
    } finally {
      setIsConnectingAcal(false);
    }
  }, [setAppleCalendarConnected, fetchAppleCalendars]);

  const handleAcalDisconnect = useCallback(async () => {
    try {
      await window.electronAPI?.acalDisconnect?.();
      setAppleCalendarConnected(false);
    } catch {
      // failure is non-fatal; state remains unchanged
    }
  }, [setAppleCalendarConnected]);

  useEffect(() => {
    const unsub = window.electronAPI?.onAcalConnectionChanged?.(
      (data: { connected: boolean }) => {
        setAppleCalendarConnected(data.connected);
        if (data.connected) fetchAppleCalendars();
      }
    );
    return () => unsub?.();
  }, [setAppleCalendarConnected, fetchAppleCalendars]);

  useEffect(() => {
    if (appleCalendarConnected) {
      fetchAppleCalendars();
    }
  }, [appleCalendarConnected, fetchAppleCalendars]);

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("integrations.title")}</h2>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{t("integrations.description")}</p>
      </div>

      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
              <img src={googleCalendarIcon} alt="" className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {t("integrations.googleCalendar.title")}
              </p>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {t("integrations.googleCalendar.description")}
              </p>
            </div>
            {!hasAccounts && (
              <Button
                size="sm"
                onClick={handleConnect}
                disabled={isConnecting}
                className="shrink-0"
              >
                {isConnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("integrations.googleCalendar.connect")
                )}
              </Button>
            )}
            {hasAccounts && (
              <Badge variant="success" className="shrink-0">
                {t("integrations.googleCalendar.connected")}
              </Badge>
            )}
          </div>
        </SettingsPanelRow>

        {hasAccounts &&
          gcalAccounts.map((account) => (
            <SettingsPanelRow key={account.email}>
              <div className="group flex items-center gap-3 pl-12">
                <Mail className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1">
                  {account.email}
                </span>
                <button
                  onClick={() => setConfirmDisconnectEmail(account.email)}
                  disabled={disconnectingEmail === account.email}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
                  aria-label={t("integrations.googleCalendar.disconnect")}
                >
                  {disconnectingEmail === account.email ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlink className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </SettingsPanelRow>
          ))}

        {hasAccounts && (
          <SettingsPanelRow>
            <button
              onClick={handleConnect}
              disabled={isConnecting}
              className="flex items-center gap-2 pl-12 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
            >
              {isConnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t("integrations.googleCalendar.addAnother")}
            </button>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      {isMacOS && (
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
                <CalendarDays className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground">
                  {t("integrations.appleCalendar.title")}
                </p>
                <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                  {t("integrations.appleCalendar.description")}
                </p>
              </div>
              {!appleCalendarConnected && (
                <Button
                  size="sm"
                  onClick={handleAcalConnect}
                  disabled={isConnectingAcal}
                  className="shrink-0"
                >
                  {isConnectingAcal ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t("integrations.appleCalendar.connect")
                  )}
                </Button>
              )}
              {appleCalendarConnected && (
                <Badge variant="success" className="shrink-0">
                  {t("integrations.appleCalendar.connected")}
                </Badge>
              )}
            </div>
          </SettingsPanelRow>

          {appleCalendarConnected && appleCalendars.length > 0 && (
            <SettingsPanelRow>
              <div className="pl-12 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground/70 mb-2">
                  {t("integrations.appleCalendar.calendars")}
                </p>
                {appleCalendars.map((cal) => (
                  <button
                    key={cal.id}
                    onClick={() => handleAcalCalendarToggle(cal.id, !cal.is_selected)}
                    className="flex items-center gap-2.5 w-full text-left py-0.5 group"
                  >
                    <div
                      className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border transition-colors ${
                        cal.is_selected
                          ? "border-transparent"
                          : "border-border/60 bg-transparent"
                      }`}
                      style={cal.is_selected && cal.color ? { backgroundColor: cal.color } : cal.is_selected ? { backgroundColor: "var(--color-primary)" } : undefined}
                    >
                      {cal.is_selected ? <Check className="h-3 w-3 text-white" /> : null}
                    </div>
                    <span className="text-xs text-foreground/80 truncate">{cal.title}</span>
                    {cal.color && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0 ml-auto"
                        style={{ backgroundColor: cal.color }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </SettingsPanelRow>
          )}

          {appleCalendarConnected && loadingAcalCalendars && appleCalendars.length === 0 && (
            <SettingsPanelRow>
              <div className="flex items-center gap-2 pl-12 text-xs text-muted-foreground/60">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("integrations.appleCalendar.loadingCalendars")}
              </div>
            </SettingsPanelRow>
          )}

          {appleCalendarConnected && (
            <SettingsPanelRow>
              <button
                onClick={() => setConfirmDisconnectAcal(true)}
                className="flex items-center gap-2 pl-12 text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                <Unlink className="h-3.5 w-3.5" />
                {t("integrations.appleCalendar.disconnect")}
              </button>
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      )}

      {/* Speaker identification — engine choice, matching thresholds, voice bank */}
      <div>
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="flex items-center gap-3 w-full">
              <div className="w-9 h-9 rounded-lg bg-yellow-400/15 dark:bg-yellow-400/10 flex items-center justify-center shrink-0">
                <Users size={17} className="text-yellow-600 dark:text-yellow-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-foreground">{t("voicebank.panelTitle")}</p>
                <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                  {isSherpa ? t("voicebank.engineDescSherpa") : t("voicebank.engineDescPyannote")}
                </p>
              </div>
              <div className="flex rounded-md border border-border/40 overflow-hidden shrink-0">
                {(
                  [
                    { key: "pyannote", label: t("voicebank.enginePyannote") },
                    { key: "sherpa", label: t("voicebank.engineSherpa") },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.key}
                    onClick={() => setDiarizationEngine(option.key)}
                    className={`h-7 px-2.5 text-[11px] font-medium transition-colors ${
                      diarizationEngine === option.key
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </SettingsPanelRow>
          {!isSherpa && (
            <SettingsPanelRow>
              <div className="w-full space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground/70">HuggingFace</p>
                  {hfToken && !hfJustSaved && <Check size={14} className="text-emerald-500 shrink-0" />}
                </div>
                <div className="flex gap-2 w-full">
                  <input
                    type="password"
                    value={hfTokenInput}
                    onChange={(e) => setHfTokenInput(e.target.value)}
                    placeholder="hf_..."
                    className="flex-1 h-8 px-3 text-xs rounded-md bg-background border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary/40 font-mono"
                  />
                  <button
                    onClick={() => {
                      setHfToken(hfTokenInput.trim());
                      setHfJustSaved(true);
                      setTimeout(() => setHfJustSaved(false), 2000);
                    }}
                    disabled={!hfTokenInput.trim() || hfTokenInput.trim() === hfToken}
                    className="h-8 px-3 text-xs rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            </SettingsPanelRow>
          )}

          {(isSherpa || hfToken) && (
            <SettingsPanelRow>
              <div className="w-full space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground/70">
                    {t("voicebank.tuningTitle")}
                  </p>
                  {(isSherpa
                    ? sherpaMeThreshold !== SHERPA_ME_THRESHOLD_DEFAULT ||
                      sherpaMatchThreshold !== SHERPA_MATCH_THRESHOLD_DEFAULT ||
                      sherpaClusterThreshold !== SHERPA_CLUSTER_THRESHOLD_DEFAULT
                    : meThreshold !== DIARIZATION_ME_THRESHOLD_DEFAULT ||
                      matchThreshold !== DIARIZATION_MATCH_THRESHOLD_DEFAULT) && (
                    <button
                      onClick={() => {
                        if (isSherpa) {
                          setSherpaMeThreshold(SHERPA_ME_THRESHOLD_DEFAULT);
                          setSherpaMatchThreshold(SHERPA_MATCH_THRESHOLD_DEFAULT);
                          setSherpaClusterThreshold(SHERPA_CLUSTER_THRESHOLD_DEFAULT);
                        } else {
                          setDiarizationMeThreshold(DIARIZATION_ME_THRESHOLD_DEFAULT);
                          setDiarizationMatchThreshold(DIARIZATION_MATCH_THRESHOLD_DEFAULT);
                        }
                      }}
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {t("voicebank.thresholdsReset")}
                    </button>
                  )}
                </div>
                {(isSherpa
                  ? [
                      {
                        key: "sherpa-me",
                        label: t("voicebank.meThreshold"),
                        desc: t("voicebank.meThresholdDesc"),
                        value: sherpaMeThreshold,
                        defaultValue: SHERPA_ME_THRESHOLD_DEFAULT,
                        min: 0.2,
                        onChange: setSherpaMeThreshold,
                      },
                      {
                        key: "sherpa-match",
                        label: t("voicebank.matchThreshold"),
                        desc: t("voicebank.matchThresholdDesc"),
                        value: sherpaMatchThreshold,
                        defaultValue: SHERPA_MATCH_THRESHOLD_DEFAULT,
                        min: 0.2,
                        onChange: setSherpaMatchThreshold,
                      },
                      {
                        key: "sherpa-cluster",
                        label: t("voicebank.clusterThreshold"),
                        desc: t("voicebank.clusterThresholdDesc"),
                        value: sherpaClusterThreshold,
                        defaultValue: SHERPA_CLUSTER_THRESHOLD_DEFAULT,
                        min: 0.2,
                        onChange: setSherpaClusterThreshold,
                      },
                    ]
                  : [
                      {
                        key: "me",
                        label: t("voicebank.meThreshold"),
                        desc: t("voicebank.meThresholdDesc"),
                        value: meThreshold,
                        defaultValue: DIARIZATION_ME_THRESHOLD_DEFAULT,
                        min: 0.5,
                        onChange: setDiarizationMeThreshold,
                      },
                      {
                        key: "match",
                        label: t("voicebank.matchThreshold"),
                        desc: t("voicebank.matchThresholdDesc"),
                        value: matchThreshold,
                        defaultValue: DIARIZATION_MATCH_THRESHOLD_DEFAULT,
                        min: 0.5,
                        onChange: setDiarizationMatchThreshold,
                      },
                    ]
                ).map((slider) => (
                  <div key={slider.key} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-foreground/80">{slider.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {slider.value.toFixed(2)}
                        {slider.value !== slider.defaultValue && (
                          <span className="text-muted-foreground/50">
                            {" "}
                            ({t("voicebank.thresholdDefault", { value: slider.defaultValue.toFixed(2) })})
                          </span>
                        )}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={slider.min}
                      max={0.95}
                      step={0.01}
                      value={slider.value}
                      onChange={(e) => slider.onChange(Number(e.target.value))}
                      aria-label={slider.label}
                      className="w-full h-1 accent-[var(--color-primary)] cursor-pointer"
                    />
                    <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
                      {slider.desc}
                    </p>
                  </div>
                ))}
              </div>
            </SettingsPanelRow>
          )}

          {voices.length > 0 && (
            <SettingsPanelRow>
              <div className="w-full space-y-0.5">
                <p className="text-xs font-medium text-muted-foreground/70 mb-2">
                  {t("voicebank.knownVoicesEngine", {
                    engine: isSherpa ? t("voicebank.engineSherpa") : t("voicebank.enginePyannote"),
                  })}
                </p>
                {voices.map((voice) => (
                  <div key={voice.id} className="group flex items-center gap-2.5 h-7">
                    <UserRound size={13} className="text-muted-foreground/50 shrink-0" />
                    {renamingVoiceId === voice.id ? (
                      <input
                        ref={voiceRenameInputRef}
                        value={voiceRenameValue}
                        onChange={(e) => setVoiceRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleVoiceRenameConfirm();
                          if (e.key === "Escape") {
                            setRenamingVoiceId(null);
                            setVoiceRenameValue("");
                          }
                        }}
                        onBlur={handleVoiceRenameConfirm}
                        className="flex-1 h-6 px-2 text-xs rounded bg-foreground/5 dark:bg-white/5 text-foreground outline-none border border-primary/30 focus:border-primary/50"
                      />
                    ) : (
                      <>
                        <span className="text-xs text-foreground/80 truncate">
                          {formatSpeakerName(voice.label)}
                        </span>
                        <span className="text-xs text-muted-foreground/40 shrink-0">
                          {t("voicebank.meetings", { count: voice.meeting_count })}
                        </span>
                        <span className="flex-1" />
                        <button
                          onClick={() => {
                            setRenamingVoiceId(voice.id);
                            setVoiceRenameValue(voice.label);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/8 transition-all"
                          aria-label={t("voicebank.renameVoice")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteVoice(voice)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                          aria-label={t("voicebank.deleteVoice")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </SettingsPanelRow>
          )}

          {(isSherpa || hfToken) && voices.length === 0 && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground/50">{t("voicebank.noVoices")}</p>
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      </div>

      {!hasAccounts && (
        <div className="rounded-lg border border-border/40 dark:border-border-subtle/40 bg-muted/20 dark:bg-surface-2/30 p-4 flex items-start gap-3">
          <Info size={15} className="text-primary/60 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground/80">
              {t("integrations.notABot.title")}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">
              {t("integrations.notABot.description")}
            </p>
          </div>
        </div>
      )}


      <ConfirmDialog
        open={!!confirmDisconnectEmail}
        onOpenChange={(open) => {
          if (!open) setConfirmDisconnectEmail(null);
        }}
        title={t("integrations.googleCalendar.disconnectConfirm", {
          email: confirmDisconnectEmail,
        })}
        description={t("integrations.googleCalendar.disconnectDescription")}
        confirmText={t("integrations.googleCalendar.disconnect")}
        variant="destructive"
        onConfirm={() => {
          if (confirmDisconnectEmail) handleDisconnect(confirmDisconnectEmail);
        }}
      />

      <ConfirmDialog
        open={showPermissionDialog}
        onOpenChange={setShowPermissionDialog}
        title={t("integrations.googleCalendar.systemAudioRequired")}
        description={t("integrations.googleCalendar.systemAudioDescription")}
        confirmText={t("integrations.googleCalendar.openSettings")}
        onConfirm={systemAudio.openSettings}
      />

      <ConfirmDialog
        open={confirmDisconnectAcal}
        onOpenChange={setConfirmDisconnectAcal}
        title={t("integrations.appleCalendar.disconnectConfirm")}
        description={t("integrations.appleCalendar.disconnectDescription")}
        confirmText={t("integrations.appleCalendar.disconnect")}
        variant="destructive"
        onConfirm={handleAcalDisconnect}
      />

      <ConfirmDialog
        open={!!confirmDeleteVoice}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteVoice(null);
        }}
        title={t("voicebank.deleteConfirmTitle", { name: confirmDeleteVoice?.label ?? "" })}
        description={t("voicebank.deleteConfirmDescription")}
        confirmText={t("voicebank.deleteVoice")}
        variant="destructive"
        onConfirm={() => {
          if (confirmDeleteVoice) handleVoiceDelete(confirmDeleteVoice.id);
        }}
      />
    </div>
  );
}
