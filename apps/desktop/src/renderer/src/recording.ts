// Reading the recording snapshot's transitions. Pure, for the tests.

import type { RecordingSnapshot } from "@shared/ipc";

/** The wording for a `fallback_backlog` warning; the helper's own message goes in the tooltip. */
export const SLOW_CONNECTION = "Connection is slow, some audio may be skipped.";

/**
 * A stop while the recording was still starting: main goes back to idle without an error and
 * without the recording ever having started (no `startedAt`).
 */
export function wasCancelledStart(prev: RecordingSnapshot | undefined, next: RecordingSnapshot): boolean {
  if (!prev || next.state !== "idle" || next.error) return false;
  return (prev.state === "starting" || prev.state === "stopping") && !prev.startedAt;
}

/**
 * A recording someone started outside this window (app menu, Dock, tray, a calendar prompt):
 * the meeting id to open, or null. Not when the window started it (it navigates itself), not
 * when you're already on that meeting, not while you're writing on the same event's before-call
 * page, and not for a recording already running when the window opened.
 */
export function liveMeetingToOpen(
  prev: RecordingSnapshot | undefined,
  next: RecordingSnapshot,
  context: { pathname: string; ownStart: boolean },
): string | null {
  if (!prev || context.ownStart) return null;
  const id = next.meetingId;
  if (!id || id === prev.meetingId) return null;
  if (next.state !== "starting" && next.state !== "recording") return null;
  if (context.pathname === `/meetings/${id}`) return null;
  if (next.calendarEventId && context.pathname === `/upcoming/${next.calendarEventId}`) return null;
  return id;
}

/**
 * How long the recording ran: from `startedAt`, held at `stoppingSince` once Stop is pressed, so
 * the sidebar pill and the meeting page show the same time while a Stop finishes.
 */
export function recordingElapsedMs(rec: RecordingSnapshot | undefined, nowMs: number): number {
  if (!rec || rec.state === "idle" || !rec.startedAt) return 0;
  const start = Date.parse(rec.startedAt);
  const end = rec.stoppingSince ? Date.parse(rec.stoppingSince) : nowMs;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
