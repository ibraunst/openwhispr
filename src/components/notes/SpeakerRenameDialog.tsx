import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, UserRound } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";

interface SpeakerRenameDialogProps {
  speaker: string | null;
  suggestions: string[];
  onOpenChange: (open: boolean) => void;
  onRename: (oldLabel: string, newLabel: string) => Promise<void>;
}

export default function SpeakerRenameDialog({
  speaker,
  suggestions,
  onOpenChange,
  onRename,
}: SpeakerRenameDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (speaker) {
      setValue("");
      setIsSaving(false);
    }
  }, [speaker]);

  const trimmed = value.trim();
  const canSave = !!speaker && !!trimmed && trimmed !== speaker && !isSaving;

  const handleSave = useCallback(
    async (name: string) => {
      if (!speaker) return;
      const newLabel = name.trim();
      if (!newLabel || newLabel === speaker) return;
      setIsSaving(true);
      try {
        await onRename(speaker, newLabel);
        onOpenChange(false);
      } finally {
        setIsSaving(false);
      }
    },
    [speaker, onRename, onOpenChange]
  );

  const availableSuggestions = suggestions.filter((s) => s && s !== speaker);

  return (
    <Dialog open={!!speaker} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogTitle className="text-sm">
          {t("voicebank.renameTitle", { name: speaker ?? "" })}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {t("voicebank.renameDescription")}
        </DialogDescription>

        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) handleSave(value);
          }}
          placeholder={t("voicebank.renamePlaceholder")}
          disabled={isSaving}
          className="w-full h-8 px-3 text-xs rounded-md bg-background border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
        />

        {availableSuggestions.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground/60">{t("voicebank.suggestions")}</p>
            <div className="flex flex-wrap gap-1.5">
              {availableSuggestions.map((name) => (
                <button
                  key={name}
                  onClick={() => handleSave(name)}
                  disabled={isSaving}
                  className={cn(
                    "flex items-center gap-1.5 h-6 px-2.5 rounded-full text-xs",
                    "bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15",
                    "text-primary/70 hover:text-primary hover:bg-primary/12 hover:border-primary/20",
                    "transition-colors disabled:opacity-50"
                  )}
                >
                  <UserRound size={10} />
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => handleSave(value)} disabled={!canSave}>
            {isSaving && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("voicebank.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
