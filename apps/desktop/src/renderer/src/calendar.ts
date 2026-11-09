// Home's "Coming up", from main's calendar snapshot. Bridge- and React-free (the tests run it);
// the types are @every-app/desktop-ui's, written out structurally.

import type { CalendarSnapshot } from "@shared/ipc";
import type { Loadable } from "./loadable";

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: { email: string | null; name: string | null; self: boolean }[];
  conferenceUrl: string | null;
  location: string | null;
  meetingId: string | null;
}

type ComingUp =
  | { state: "unavailable" }
  | { state: "disconnected"; reconnect: boolean }
  | { state: "error"; message: string }
  | { state: "ok"; events: CalendarEvent[] };

const HALF_HOUR = 30 * 60_000;

/**
 * Main polls the calendar (24 hours ahead); the Home card draws that. Events main already has
 * stay on screen when a refresh fails (offline): the error shows only when there's nothing else.
 */
export function comingUpFrom(calendar: CalendarSnapshot | undefined, recordingEventId?: string, recordingMeetingId?: string): Loadable<ComingUp> {
  if (!calendar) return { status: "loading" };
  if (!calendar.connected) return { status: "ready", data: { state: "disconnected", reconnect: false } };
  if (calendar.error && calendar.events.length === 0) return { status: "ready", data: { state: "error", message: calendar.error } };
  if (!calendar.lastRefresh && calendar.events.length === 0) return { status: "loading" };
  const events: CalendarEvent[] = calendar.events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end ?? new Date(new Date(e.start).getTime() + HALF_HOUR).toISOString(),
    attendees: e.attendees.map((a) => ({ email: a.email ?? null, name: a.name ?? null, self: a.self ?? false })),
    conferenceUrl: e.conferenceUrl ?? null,
    location: e.location ?? null,
    meetingId: recordingEventId === e.id ? (recordingMeetingId ?? null) : null,
  }));
  return { status: "ready", data: { state: "ok", events } };
}

