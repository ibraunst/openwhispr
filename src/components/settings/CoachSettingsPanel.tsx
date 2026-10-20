import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useSettingsStore } from "../../stores/settingsStore";
import { COACH_INTENSITIES } from "../../types/coach";

// Mirrors PROVIDERS in src/helpers/coach/coachLlm.js (fastest model per provider)
const PROVIDERS = [
  { key: "anthropic", label: "Anthropic", defaultModel: "claude-haiku-5-5" },
  { key: "openai", label: "OpenAI", defaultModel: "gpt-4.1-mini" },
  { key: "groq", label: "Groq", defaultModel: "openai/gpt-oss-120b" },
  { key: "gemini", label: "Gemini", defaultModel: "gemini-2.5-flash-lite" },
] as const;

const ACCELERATOR_PATTERN =
  /^((CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)\+)+([A-Z0-9]|F\d{1,2}|Space|Tab|Up|Down|Left|Right|[;,./'[\]\\=`-])$/i;

export default function CoachSettingsPanel() {
  const { t } = useTranslation();
  const coachProvider = useSettingsStore((s) => s.coachProvider);
  const coachModel = useSettingsStore((s) => s.coachModel);
  const coachAskHotkey = useSettingsStore((s) => s.coachAskHotkey);
  const setCoachProvider = useSettingsStore((s) => s.setCoachProvider);
  const setCoachModel = useSettingsStore((s) => s.setCoachModel);
  const setCoachAskHotkey = useSettingsStore((s) => s.setCoachAskHotkey);
  const coachIntensity = useSettingsStore((s) => s.coachIntensity);
  const setCoachIntensity = useSettingsStore((s) => s.setCoachIntensity);
  // Separate selectors: an object-returning selector is a new snapshot every
  // render, which loops under zustand v5
  const anthropicKey = useSettingsStore((s) => s.anthropicApiKey);
  const openaiKey = useSettingsStore((s) => s.openaiApiKey);
  const groqKey = useSettingsStore((s) => s.groqApiKey);
  const geminiKey = useSettingsStore((s) => s.geminiApiKey);
  const keys = { anthropic: anthropicKey, openai: openaiKey, groq: groqKey, gemini: geminiKey };

  const [modelInput, setModelInput] = useState(coachModel);
  const [hotkeyInput, setHotkeyInput] = useState(coachAskHotkey);
  useEffect(() => setModelInput(coachModel), [coachModel]);
  useEffect(() => setHotkeyInput(coachAskHotkey), [coachAskHotkey]);

  const hasKey = (provider: string) => !!keys[provider as keyof typeof keys]?.trim();
  const autoPick = PROVIDERS.find((p) => hasKey(p.key));
  const effective =
    coachProvider === "auto" ? autoPick : PROVIDERS.find((p) => p.key === coachProvider);
  const isLocal = coachProvider === "local";
  // Auto with no cloud key runs on the local model, so it isn't "missing"
  const missingKey = !isLocal && coachProvider !== "auto" && !hasKey(coachProvider);
  const hotkeyValid = ACCELERATOR_PATTERN.test(hotkeyInput.trim());

  return (
    <div>
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Compass className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t("coach.settings.title")}</p>
              <p className="text-xs text-muted-foreground/70">{t("coach.settings.description")}</p>
            </div>
          </div>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <div className="w-full space-y-2">
            <p className="text-xs font-medium text-muted-foreground/70">
              {t("coach.settings.provider")}
            </p>
            <div className="flex flex-wrap rounded-md border border-border/40 overflow-hidden w-fit">
              {[
                { key: "auto", label: t("coach.settings.auto") },
                ...PROVIDERS,
                { key: "local", label: t("coach.settings.local") },
              ].map((option) => (
                <button
                  key={option.key}
                  onClick={() => setCoachProvider(option.key)}
                  className={`h-7 px-2.5 text-[11px] font-medium transition-colors ${
                    coachProvider === option.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p
              className={`text-[11px] ${missingKey ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/70"}`}
            >
              {missingKey
                ? t("coach.settings.missingKey")
                : isLocal || !effective
                  ? t("coach.settings.localOnly")
                  : t("coach.settings.using", { provider: effective.label })}
            </p>
            <p className="text-[11px] text-muted-foreground/70">
              {t("coach.settings.fallbackHint")}
            </p>
          </div>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <div className="w-full space-y-2">
            <p className="text-xs font-medium text-muted-foreground/70">
              {t("coach.settings.intensity")}
            </p>
            <div className="flex rounded-md border border-border/40 overflow-hidden w-fit">
              {COACH_INTENSITIES.map((level) => (
                <button
                  key={level}
                  onClick={() => setCoachIntensity(level)}
                  className={`h-7 px-2.5 text-[11px] font-medium transition-colors ${
                    coachIntensity === level
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(`coach.intensity.${level}`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              {t(
                `coach.intensityHint.${COACH_INTENSITIES.includes(coachIntensity as never) ? coachIntensity : "balanced"}`
              )}
            </p>
          </div>
        </SettingsPanelRow>

        {!isLocal && (
          <SettingsPanelRow>
            <div className="w-full space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground/70">
                {t("coach.settings.model")}
              </p>
              <input
                value={modelInput}
                onChange={(e) => setModelInput(e.target.value)}
                onBlur={() => {
                  if (modelInput.trim() !== coachModel) setCoachModel(modelInput.trim());
                }}
                placeholder={effective?.defaultModel ?? PROVIDERS[0].defaultModel}
                className="w-full h-8 px-3 text-xs rounded-md bg-background border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary/40 font-mono"
              />
              <p className="text-[11px] text-muted-foreground/70">
                {t("coach.settings.modelHint")}
              </p>
            </div>
          </SettingsPanelRow>
        )}

        <SettingsPanelRow>
          <div className="w-full space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground/70">
              {t("coach.settings.hotkey")}
            </p>
            <input
              value={hotkeyInput}
              onChange={(e) => setHotkeyInput(e.target.value)}
              onBlur={() => {
                const next = hotkeyInput.trim();
                if (ACCELERATOR_PATTERN.test(next) && next !== coachAskHotkey)
                  setCoachAskHotkey(next);
              }}
              placeholder="Control+Alt+A"
              className="w-full h-8 px-3 text-xs rounded-md bg-background border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary/40 font-mono"
            />
            <p
              className={`text-[11px] ${hotkeyValid ? "text-muted-foreground/70" : "text-destructive"}`}
            >
              {hotkeyValid ? t("coach.settings.hotkeyHint") : t("coach.settings.hotkeyInvalid")}
            </p>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </div>
  );
}
