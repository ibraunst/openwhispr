import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

// Floating live-transcript view shown while a meeting records. Sticks to the
// bottom of the text and keeps out of the way of note-taking.
export default function LiveTranscriptPanel({ text }: { text: string }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="absolute bottom-16 left-4 right-4 z-10 rounded-xl glass-float border overflow-hidden animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("notes.liveTranscript")}
        </span>
      </div>
      <div ref={scrollRef} className="px-3 pb-2.5 pt-1 max-h-28 overflow-y-auto">
        <p className="text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}
