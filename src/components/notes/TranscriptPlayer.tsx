import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, ChevronDown, UserRound, Users, Pencil } from "lucide-react";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";
import { formatSpeakerName } from "../../utils/speakerNameFormatter";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "../ui/dropdown-menu";

interface SpeakerRenameProps {
  onRenameSpeaker?: (oldLabel: string, newLabel: string) => Promise<void>;
  onAssignParagraph?: (paragraphIndex: number, newLabel: string) => Promise<void>;
  speakerSuggestions?: string[];
  onRequestCustomName?: (speaker: string, paragraphIndex?: number | null) => void;
  onResetParagraph?: (paragraphIndex: number) => Promise<void>;
}

const GENERIC_SPEAKER_RE = /^Guest \d+$/i;

/**
 * A speaker name inline in the transcript. Picking a name changes ONLY this
 * paragraph — correcting one misattributed line must never ripple across the
 * transcript. The cluster-wide rename ("this voice is person X everywhere")
 * lives behind an explicit "Rename everywhere" submenu.
 */
function SpeakerLabel({
  speaker,
  paragraphIndex,
  onRenameSpeaker,
  onAssignParagraph,
  speakerSuggestions,
  onRequestCustomName,
  onResetParagraph,
}: SpeakerRenameProps & { speaker: string; paragraphIndex?: number | null }) {
  const { t } = useTranslation();
  const displayName = formatSpeakerName(speaker);
  if (!onRenameSpeaker) {
    return <span className="font-semibold text-foreground/90">{displayName}: </span>;
  }
  const availableNames = (speakerSuggestions ?? []).filter((name) => name !== speaker);
  // Paragraph-scoped actions need a reconciled paragraph index; without one
  // (reconciliation unavailable) the menu falls back to global rename only.
  const canScope = !!onAssignParagraph && paragraphIndex != null;
  // Only a paragraph already identified as a real person is worth "undoing" —
  // a still-generic "Guest N" has nothing to reset back to.
  const canReset =
    !!onResetParagraph && paragraphIndex != null && !GENERIC_SPEAKER_RE.test(speaker);

  const nameItems = (onPick: (name: string) => void) =>
    availableNames.map((name) => (
      <DropdownMenuItem key={name} onClick={() => onPick(name)} className="text-xs gap-2">
        <UserRound size={12} className="text-foreground/40" />
        {formatSpeakerName(name)}
      </DropdownMenuItem>
    ));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title={t("voicebank.renameTooltip")}
          className="group inline-flex items-center gap-0.5 font-semibold text-foreground/90 hover:text-primary transition-colors duration-150 align-baseline"
        >
          {displayName}:
          <ChevronDown
            size={10}
            className="text-foreground/25 group-hover:text-primary/60 transition-colors"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-40">
        {canScope ? (
          <>
            {nameItems((name) => void onAssignParagraph!(paragraphIndex!, name))}
            <DropdownMenuItem
              onClick={() => onRequestCustomName?.(speaker, paragraphIndex)}
              className="text-xs gap-2"
            >
              <Pencil size={12} className="text-foreground/40" />
              {t("voicebank.customName")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-xs gap-2">
                <Users size={12} className="text-foreground/40" />
                {t("voicebank.renameEverywhere", { name: displayName })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-40">
                {nameItems((name) => void onRenameSpeaker(speaker, name))}
                {availableNames.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={() => onRequestCustomName?.(speaker, null)}
                  className="text-xs gap-2"
                >
                  <Pencil size={12} className="text-foreground/40" />
                  {t("voicebank.customName")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {canReset && (
              <DropdownMenuItem
                onClick={() => void onResetParagraph!(paragraphIndex!)}
                className="text-xs gap-2"
              >
                <UserRound size={12} className="text-foreground/40" />
                {t("voicebank.resetLine")}
              </DropdownMenuItem>
            )}
          </>
        ) : (
          <>
            {nameItems((name) => void onRenameSpeaker(speaker, name))}
            {availableNames.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => onRequestCustomName?.(speaker, null)}
              className="text-xs gap-2"
            >
              <Pencil size={12} className="text-foreground/40" />
              {t("voicebank.customName")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface PlaybackSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  paragraphIndex?: number;
}

interface SpeakerBlock {
  speaker: string | null;
  // The paragraph's block index in the note markdown (stamped on segments
  // by reconciliation); null when reconciliation is unavailable — the
  // per-paragraph menu actions are hidden in that case.
  paragraphIndex: number | null;
  segments: { segIndex: number; start: number; end: number; words: string[] }[];
}

interface TranscriptPlayerProps extends SpeakerRenameProps {
  noteId: number;
  hasRecording: boolean;
  transcript: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function toFileUrl(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const withLeadingSlash = /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized;
  return `file://${encodeURI(withLeadingSlash)}`;
}

/**
 * Group consecutive segments into paragraph blocks — by markdown paragraph
 * when reconciliation stamped indexes (so adjacent paragraphs renamed to the
 * same person stay separate blocks with their own per-paragraph menu), and
 * by speaker alone otherwise.
 */
function buildSpeakerBlocks(segments: PlaybackSegment[]): SpeakerBlock[] {
  const blocks: SpeakerBlock[] = [];
  segments.forEach((seg, segIndex) => {
    const text = seg.text.trim();
    if (!text) return;
    const speaker = seg.speaker || null;
    const paragraphIndex = seg.paragraphIndex ?? null;
    const last = blocks[blocks.length - 1];
    const entry = { segIndex, start: seg.start, end: seg.end, words: text.split(/\s+/) };
    if (last && last.speaker === speaker && last.paragraphIndex === paragraphIndex) {
      last.segments.push(entry);
    } else {
      blocks.push({ speaker, paragraphIndex, segments: [entry] });
    }
  });
  return blocks;
}

/** Fallback rendering of the stored markdown transcript (`**Speaker:** text` paragraphs). */
function StaticTranscript({
  transcript,
  onRenameSpeaker,
  onAssignParagraph,
  speakerSuggestions,
  onRequestCustomName,
  onResetParagraph,
}: SpeakerRenameProps & { transcript: string }) {
  const paragraphs = useMemo(() => {
    // Track each paragraph's index in the RAW (unfiltered) split — that's
    // what the backend's meeting-reset-paragraph-speaker handler uses to
    // target this exact paragraph, so it must not shift after filtering.
    return transcript
      .split(/\n{2,}/)
      .map((raw, paragraphIndex) => ({ raw: raw.trim(), paragraphIndex }))
      .filter((p) => p.raw.length > 0)
      .map(({ raw, paragraphIndex }) => {
        const match = raw.match(/^\*\*(.+?):\*\*\s*([\s\S]*)$/);
        return match
          ? { speaker: match[1], text: match[2], paragraphIndex }
          : { speaker: null, text: raw, paragraphIndex };
      });
  }, [transcript]);

  return (
    <div className="px-5 py-3 pb-24 space-y-4">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-sm leading-[1.7] text-foreground/90 whitespace-pre-wrap break-words">
          {p.speaker && (
            <SpeakerLabel
              speaker={p.speaker}
              paragraphIndex={p.paragraphIndex}
              onRenameSpeaker={onRenameSpeaker}
              onAssignParagraph={onAssignParagraph}
              speakerSuggestions={speakerSuggestions}
              onRequestCustomName={onRequestCustomName}
              onResetParagraph={onResetParagraph}
            />
          )}{" "}
          {p.text}
        </p>
      ))}
    </div>
  );
}

interface KaraokeSegmentProps {
  segIndex: number;
  words: string[];
  status: "idle" | "future" | "past" | "active";
  activeWordIdx: number;
  onSeekWord: (segIndex: number, wordIdx: number) => void;
}

const KaraokeSegment = memo(function KaraokeSegment({
  segIndex,
  words,
  status,
  activeWordIdx,
  onSeekWord,
}: KaraokeSegmentProps) {
  return (
    <>
      {words.map((word, i) => (
        <span
          key={i}
          onClick={() => onSeekWord(segIndex, i)}
          className={cn(
            "cursor-pointer rounded-xs transition-colors duration-150",
            status === "idle" && "text-foreground/90",
            status === "past" && "text-foreground/90",
            status === "future" && "text-foreground/35",
            status === "active" &&
              (i < activeWordIdx
                ? "text-foreground/90"
                : i === activeWordIdx
                  ? "text-primary bg-primary/10"
                  : "text-foreground/35")
          )}
        >
          {word}{" "}
        </span>
      ))}
    </>
  );
});

export default function TranscriptPlayer({
  noteId,
  hasRecording,
  transcript,
  onRenameSpeaker,
  onAssignParagraph,
  speakerSuggestions,
  onRequestCustomName,
  onResetParagraph,
}: TranscriptPlayerProps) {
  const { t } = useTranslation();
  const [segments, setSegments] = useState<PlaybackSegment[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [engaged, setEngaged] = useState(false); // playback started at least once
  const [duration, setDuration] = useState(0);
  const [displayTime, setDisplayTime] = useState(0);
  const [active, setActive] = useState<{ segIdx: number; wordIdx: number }>({ segIdx: -1, wordIdx: -1 });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number>(0);
  const activeSegElRef = useRef<HTMLSpanElement | null>(null);

  // Load playback bundle (mixed audio + timestamped segments)
  useEffect(() => {
    let cancelled = false;
    setSegments([]);
    setAudioUrl(null);
    setEngaged(false);
    setIsPlaying(false);
    setActive({ segIdx: -1, wordIdx: -1 });
    setDisplayTime(0);
    setDuration(0);

    if (!hasRecording) return;

    (async () => {
      try {
        const result = await window.electronAPI?.meetingGetPlayback?.(noteId);
        if (cancelled) return;
        if (result?.segments?.length) setSegments(result.segments);
        if (result?.success && result.audioPath) {
          setAudioUrl(toFileUrl(result.audioPath));
        } else if (result?.error) {
          logger.info("Meeting playback unavailable", { noteId, error: result.error }, "notes");
        }
      } catch (err) {
        if (!cancelled) {
          logger.error("Failed to load meeting playback", { error: (err as Error).message }, "notes");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [noteId, hasRecording, transcript]);

  // Pause and release the audio element on unmount / note switch
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      cancelAnimationFrame(rafRef.current);
    };
  }, [audioUrl]);

  const blocks = useMemo(() => buildSpeakerBlocks(segments), [segments]);

  // Map current playback time → active segment + interpolated word index.
  // displayTime is quantized to 250ms so the 60fps rAF loop doesn't re-render
  // the whole transcript every frame — only the active segment updates often.
  const syncToTime = useCallback(
    (time: number) => {
      const quantized = Math.round(time * 4) / 4;
      setDisplayTime((prev) => (prev === quantized ? prev : quantized));
      let segIdx = -1;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].start <= time) segIdx = i;
        else break;
      }
      let wordIdx = -1;
      if (segIdx >= 0) {
        const seg = segments[segIdx];
        if (time < seg.end) {
          const words = seg.text.trim().split(/\s+/);
          const span = Math.max(seg.end - seg.start, 0.001);
          wordIdx = Math.min(words.length - 1, Math.floor(((time - seg.start) / span) * words.length));
        } else {
          wordIdx = Number.MAX_SAFE_INTEGER; // segment fully played, between segments
        }
      }
      setActive((prev) => (prev.segIdx === segIdx && prev.wordIdx === wordIdx ? prev : { segIdx, wordIdx }));
    },
    [segments]
  );

  // rAF loop while playing keeps the highlight moving smoothly
  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) syncToTime(audio.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, syncToTime]);

  // Keep the active segment visible while playing
  useEffect(() => {
    if (isPlaying && activeSegElRef.current) {
      activeSegElRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active.segIdx, isPlaying]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      setEngaged(true);
      audio.play().catch((err: Error) => {
        logger.error("Meeting audio playback failed", { error: err.message }, "notes");
      });
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback(
    (time: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = time;
      setEngaged(true);
      syncToTime(time);
      if (audio.paused) {
        audio.play().catch((err: Error) => {
          logger.error("Meeting audio playback failed", { error: err.message }, "notes");
        });
      }
    },
    [syncToTime]
  );

  // Stable per-word seek handler so memoized segments don't re-render on
  // every playback tick
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const handleWordSeek = useCallback(
    (segIndex: number, wordIdx: number) => {
      const seg = segmentsRef.current[segIndex];
      if (!seg || !audioRef.current) return;
      const words = seg.text.trim().split(/\s+/);
      const span = Math.max(seg.end - seg.start, 0.001);
      seekTo(seg.start + (wordIdx / Math.max(words.length, 1)) * span);
    },
    [seekTo]
  );

  // Karaoke needs both timing data and the audio itself — anything less
  // renders the stored transcript as plain scrollable text.
  if (!segments.length || !audioUrl) {
    return (
      <StaticTranscript
        transcript={transcript}
        onRenameSpeaker={onRenameSpeaker}
        onAssignParagraph={onAssignParagraph}
        speakerSuggestions={speakerSuggestions}
        onRequestCustomName={onRequestCustomName}
        onResetParagraph={onResetParagraph}
      />
    );
  }

  return (
    <div className="pb-24">
      {audioUrl && (
        <>
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="metadata"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onError={() => {
              logger.error("Meeting audio failed to load", { noteId }, "notes");
              setAudioUrl(null);
            }}
          />
          <div className="sticky top-0 z-10 mx-5 mt-3 flex items-center gap-3 rounded-xl glass-float border px-3 py-2">
            <button
              onClick={togglePlayback}
              aria-label={isPlaying ? t("notes.editor.pauseRecording") : t("notes.editor.playRecording")}
              title={isPlaying ? t("notes.editor.pauseRecording") : t("notes.editor.playRecording")}
              className={cn(
                "shrink-0 h-8 w-8 flex items-center justify-center rounded-full",
                "bg-primary/10 text-primary hover:bg-primary/20 transition-colors duration-150"
              )}
            >
              {isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
            </button>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(displayTime, duration || 0)}
              onChange={(e) => seekTo(Number(e.target.value))}
              aria-label={t("notes.editor.playRecording")}
              className="flex-1 h-1 accent-[var(--color-primary)] cursor-pointer"
            />
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatTime(displayTime)} / {formatTime(duration)}
            </span>
          </div>
        </>
      )}

      <div className="px-5 py-3 space-y-4">
        {blocks.map((block, bi) => (
          <p key={bi} className="text-sm leading-[1.7] whitespace-pre-wrap break-words">
            {block.speaker && (
              <>
                <SpeakerLabel
                  speaker={block.speaker}
                  paragraphIndex={block.paragraphIndex}
                  onRenameSpeaker={onRenameSpeaker}
                  onAssignParagraph={onAssignParagraph}
                  speakerSuggestions={speakerSuggestions}
                  onRequestCustomName={onRequestCustomName}
                  onResetParagraph={onResetParagraph}
                />{" "}
              </>
            )}
            {block.segments.map((seg) => {
              const isActive = engaged && seg.segIndex === active.segIdx;
              const status: KaraokeSegmentProps["status"] = !engaged
                ? "idle"
                : isActive
                  ? "active"
                  : seg.segIndex < active.segIdx
                    ? "past"
                    : "future";
              return (
                <span key={seg.segIndex} ref={isActive ? activeSegElRef : undefined}>
                  <KaraokeSegment
                    segIndex={seg.segIndex}
                    words={seg.words}
                    status={status}
                    activeWordIdx={isActive ? active.wordIdx : -1}
                    onSeekWord={handleWordSeek}
                  />
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </div>
  );
}
