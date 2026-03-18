import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, RefreshCw, Loader2, Lock } from "lucide-react";
import { Toggle } from "./ui/toggle";
import { cn } from "./lib/utils";
import type { CalendarEvent } from "../types/electron";

interface GroupedEvents {
  label: string;
  date: string;
  dayOfWeek: string;
  dayNum: number;
  month: string;
  events: CalendarEvent[];
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toUpperCase();
}

function formatDateLabel(dateStr: string): { dayNum: number; month: string; dayOfWeek: string } {
  const d = new Date(dateStr + "T12:00:00");
  const dayNum = d.getDate();
  const month = d.toLocaleDateString([], { month: "long" });
  const dayOfWeek = d.toLocaleDateString([], { weekday: "short" });
  return { dayNum, month, dayOfWeek };
}

function getDateKey(isoString: string): string {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getRelativeDateLabel(dateKey: string): string {
  const today = new Date();
  const todayKey = getDateKey(today.toISOString());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = getDateKey(yesterday.toISOString());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = getDateKey(tomorrow.toISOString());

  if (dateKey === todayKey) return "Today";
  if (dateKey === tomorrowKey) return "Tomorrow";
  if (dateKey === yesterdayKey) return "Yesterday";

  const d = new Date(dateKey + "T12:00:00");
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}


function parseConferenceData(event: CalendarEvent) {
  let isPrivate = false;
  let attendees: any[] = [];
  let attendeesCount = 0;
  
  if (event.conference_data) {
    try {
      const parsed = typeof event.conference_data === "string" 
        ? JSON.parse(event.conference_data) 
        : event.conference_data;
      
      if (parsed) {
        if (parsed.isPrivate !== undefined) isPrivate = parsed.isPrivate;
        if (parsed.attendeesCount !== undefined) attendeesCount = parsed.attendeesCount;
        if (parsed.attendees && typeof parsed.attendees === "string") {
          try { attendees = JSON.parse(parsed.attendees); } catch { /* ignore */ }
        } else if (Array.isArray(parsed.attendees)) {
          attendees = parsed.attendees;
        }
      }
    } catch {
       // ignore
    }
  }
  return { isPrivate, attendees, attendeesCount };
}


function groupEventsByDate(events: CalendarEvent[]): GroupedEvents[] {
  const groups = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const key = getDateKey(event.start_time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(event);
  }

  return Array.from(groups.entries()).map(([dateKey, evts]) => {
    const { dayNum, month, dayOfWeek } = formatDateLabel(dateKey);
    return {
      label: getRelativeDateLabel(dateKey),
      date: dateKey,
      dayOfWeek,
      dayNum,
      month,
      events: evts.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()),
    };
  });
}

interface CalendarViewProps {
  onOpenNote?: (noteId: number) => void;
}

export default function CalendarView({ onOpenNote }: CalendarViewProps) {
  const { t } = useTranslation();
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  const [active, setActive] = useState<CalendarEvent[]>([]);
  const [past, setPast] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recordMeetings, setRecordMeetings] = useState(true);

  useEffect(() => {
    window.electronAPI?.meetingDetectionGetPreferences?.().then((res) => {
      if (res?.success && res.preferences) {
        setRecordMeetings(
          res.preferences.processDetection !== false || res.preferences.audioDetection !== false
        );
      }
    });
  }, []);

  const handleRecordMeetingsToggle = useCallback((enabled: boolean) => {
    setRecordMeetings(enabled);
    window.electronAPI?.meetingDetectionSetPreferences?.({
      processDetection: enabled,
      audioDetection: enabled,
    });
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      setError(null);
      const result = await window.electronAPI?.getCalendarEvents?.();
      if (result?.success) {
        setUpcoming(result.upcoming || []);
        setActive(result.active || []);
        setPast(result.past || []);
      } else {
        setError("Failed to load calendar events");
      }
    } catch (err) {
      setError("Failed to load calendar events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, 60000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  const upcomingGroups = useMemo(() => {
    const allUpcoming = [...active, ...upcoming];
    return groupEventsByDate(allUpcoming);
  }, [active, upcoming]);

  const pastGroups = useMemo(() => {
    const groups = groupEventsByDate(past).sort((a, b) => b.date.localeCompare(a.date));
    for (const group of groups) {
      group.events.reverse();
    }
    return groups;
  }, [past]);

  const todayKey = getDateKey(new Date().toISOString());

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const noEvents = upcomingGroups.length === 0 && pastGroups.length === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 h-4" />

      {error && (
        <div className="mx-5 mb-3 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
          {error}
        </div>
      )}

      {noEvents ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground px-8">
          <CalendarDays size={32} className="opacity-40" />
          <p className="text-sm text-center">No calendar events found</p>
          <p className="text-xs text-center opacity-60">
            Connect Google Calendar or Apple Calendar in Integrations
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {/* Coming up */}
          {upcomingGroups.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-foreground">Coming up</h2>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">{t("calendar.recordMeetings")}</span>
                  <Toggle checked={recordMeetings} onChange={handleRecordMeetingsToggle} />
                  <button
                    onClick={() => { setLoading(true); fetchEvents(); }}
                    className="p-1.5 rounded-md hover:bg-foreground/5 dark:hover:bg-white/5 transition-colors text-muted-foreground hover:text-foreground"
                    title="Refresh"
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-border/20 dark:border-white/8 bg-surface-1/40 dark:bg-white/[0.02] overflow-hidden divide-y divide-border/10 dark:divide-white/5">
                {upcomingGroups.map((group, gi) => (
                  <div key={group.date} className={cn("flex", gi > 0 && "border-t border-dashed border-border/20 dark:border-white/8")}>
                    {/* Date column */}
                    <div className="shrink-0 w-20 py-3 px-3 flex flex-col items-center justify-start">
                      <span className="text-2xl font-bold text-foreground leading-tight">{group.dayNum}</span>
                      <span className="text-[11px] text-muted-foreground leading-tight">
                        {group.month.slice(0, 3)}
                      </span>
                      <span className="text-[11px] text-muted-foreground leading-tight">
                        {group.dayOfWeek}
                      </span>
                      {group.date === todayKey && (
                        <div className="mt-1 w-1.5 h-1.5 rounded-full bg-red-500" />
                      )}
                    </div>
                    {/* Events column */}
                    <div className="flex-1 py-2 pr-3 space-y-1">
                      {group.events.length === 0 ? (
                        <div className="py-2 text-xs text-muted-foreground/60">No more events today</div>
                      ) : (
                        group.events.map((event) => (
                          <EventRow key={event.id} event={event} />
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Past events */}
          {pastGroups.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-foreground mb-3">Past</h2>
              <div className="space-y-1.5">
                {pastGroups.map((group) => (
                  <div key={group.date}>
                    <div className="text-xs font-medium text-muted-foreground mb-1.5 px-1">{group.label}</div>
                    <div className="space-y-1">
                      {group.events.map((event) => (
                        <PastEventRow key={event.id} event={event} onOpenNote={onOpenNote} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const now = new Date();
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  const isActive = now >= start && now < end;
  const { isPrivate } = parseConferenceData(event);

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 px-2.5 py-2 rounded-lg transition-colors group cursor-pointer",
        isActive
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/3 dark:hover:bg-white/3"
      )}
    >
      <div
        className={cn(
          "shrink-0 w-0.5 h-full min-h-[3rem] rounded-full mt-0.5",
          isActive ? "bg-primary" : "bg-emerald-500/70"
        )}
      />
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="flex items-center gap-2">
          <div className="text-[13px] font-semibold text-foreground truncate">
            {event.summary || "Untitled Event"}
          </div>
          {isPrivate && <Lock size={12} className="shrink-0 text-muted-foreground/60" />}
        </div>
        
        <div className="text-[11px] text-muted-foreground mt-[1px]">
          {formatTime(event.start_time)} – {formatTime(event.end_time)}
        </div>
        
      </div>
    </div>
  );
}

function PastEventRow({ event, onOpenNote }: { event: CalendarEvent; onOpenNote?: (noteId: number) => void }) {
  const { isPrivate } = parseConferenceData(event);

  const handleClick = useCallback(async () => {
    if (!onOpenNote) return;
    const note = await window.electronAPI?.getNoteByCalendarEventId?.(event.id);
    if (note) {
      onOpenNote(note.id);
    }
  }, [event.id, onOpenNote]);

  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors cursor-pointer"
      onClick={handleClick}
    >
      <div className="shrink-0 w-8 h-8 rounded-lg bg-muted/30 dark:bg-white/5 flex items-center justify-center">
        <CalendarDays size={14} className="text-muted-foreground/60" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <div className="text-[13px] font-medium text-foreground truncate">
            {event.summary || "Untitled Event"}
          </div>
          {isPrivate && <Lock size={11} className="shrink-0 text-muted-foreground/50" />}
        </div>
        <div className="text-[11px] text-muted-foreground/60 mt-0.5">
          {formatTime(event.start_time)} – {formatTime(event.end_time)}
        </div>
      </div>
    </div>
  );
}
