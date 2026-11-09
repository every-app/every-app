// Which meeting prompts are due (port of HelperCore/ReminderPlanner.swift from the web-overhaul
// branch: a minute before (the lead time is a setting), plus a nudge once a meeting has started without notes).

import { isMeeting, type CalendarEvent } from "@shared/api";

export const REMINDER_LEAD_MS = 60_000;
export const STARTED_WINDOW_MS = 5 * 60_000;

export interface Reminder {
  /** Stable per event and start time: a moved meeting gets a new reminder. */
  id: string;
  fireAt: number;
  event: CalendarEvent;
}

const startMs = (e: CalendarEvent) => Date.parse(e.start);

export function reminderId(event: CalendarEvent): string {
  return `meeting.${event.id}.${Math.floor(startMs(event) / 1000)}`;
}

export function startedId(event: CalendarEvent): string {
  return `started.${event.id}.${Math.floor(startMs(event) / 1000)}`;
}

/** Prompts for meetings that haven't started, `leadMs` before (default one minute). One whose mark has passed fires
 * now, unless it was already delivered. The event Every App is already recording gets none. */
export function planReminders(
  events: CalendarEvent[],
  now: number,
  delivered: ReadonlySet<string> = new Set(),
  recordingEventId?: string,
  leadMs: number = REMINDER_LEAD_MS,
): Reminder[] {
  return events
    .filter((e) => isMeeting(e) && startMs(e) > now && e.id !== recordingEventId)
    .flatMap((event) => {
      const id = reminderId(event);
      const due = startMs(event) - leadMs;
      if (due > now) return [{ id, fireAt: due, event }];
      if (delivered.has(id)) return [];
      return [{ id, fireAt: now, event }];
    })
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** Meetings that started in the last five minutes and haven't been nudged. None while recording. */
export function dueStartedNudges(
  events: CalendarEvent[],
  now: number,
  recording: boolean,
  nudged: ReadonlySet<string>,
): CalendarEvent[] {
  if (recording) return [];
  return events
    .filter((e) => {
      const start = startMs(e);
      const end = e.end ? Date.parse(e.end) : Number.POSITIVE_INFINITY;
      return isMeeting(e) && start <= now && now < start + STARTED_WINDOW_MS && end > now;
    })
    .filter((e) => !nudged.has(startedId(e)))
    .sort((a, b) => startMs(a) - startMs(b));
}
