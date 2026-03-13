import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";
import { Button } from "./button";
import { useToast } from "./Toast";
import { DEFAULT_MEETING_NOTE_PROMPT } from "../../config/prompts";

const STORAGE_KEY = "customMeetingNotePrompt";

function getCurrentPrompt(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return DEFAULT_MEETING_NOTE_PROMPT;
    }
  }
  return DEFAULT_MEETING_NOTE_PROMPT;
}

export default function MeetingNotePromptEditor({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [prompt, setPrompt] = useState(getCurrentPrompt);
  const isModified = prompt !== DEFAULT_MEETING_NOTE_PROMPT;
  const hasStoredCustom = localStorage.getItem(STORAGE_KEY) !== null;

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompt));
    toast({
      title: t("meetingNotePrompt.saved"),
      variant: "default",
    });
  };

  const handleReset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPrompt(DEFAULT_MEETING_NOTE_PROMPT);
    toast({
      title: t("meetingNotePrompt.reset"),
      variant: "default",
    });
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {t("meetingNotePrompt.title")}
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          {t("meetingNotePrompt.description")}
        </p>
      </div>

      <textarea
        className="w-full min-h-[140px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={DEFAULT_MEETING_NOTE_PROMPT}
      />

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!prompt.trim() || (hasStoredCustom && prompt === getCurrentPrompt())}
        >
          {t("meetingNotePrompt.save")}
        </Button>
        {isModified && (
          <Button size="sm" variant="ghost" onClick={handleReset}>
            <RotateCw className="w-3 h-3 mr-1" />
            {t("meetingNotePrompt.resetToDefault")}
          </Button>
        )}
      </div>
    </div>
  );
}
