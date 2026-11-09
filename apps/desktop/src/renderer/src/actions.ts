import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import type { RecordingSnapshot, StartRecordingRequest } from "@shared/ipc";
import { api, cleanError, keys } from "./api";
import { notify } from "./notice";
import { liveMeetingToOpen, wasCancelledStart } from "./recording";

// While this window starts a recording itself, it navigates on its own once the meeting exists.
let ownStarts = 0;
import { bridge } from "./bridge";

/** Run a change, refresh what it touched, and say so if it failed. */
export function useRun() {
  const client = useQueryClient();
  return useCallback(
    async (work: () => Promise<unknown>, failed: string, touched: readonly (readonly unknown[])[] = []) => {
      try {
        await work();
      } catch (error) {
        notify(`${failed} ${cleanError(error)}`.trim(), "error");
      } finally {
        await Promise.all(touched.map((queryKey) => client.invalidateQueries({ queryKey })));
      }
    },
    [client],
  );
}

/**
 * Start taking notes (main creates the meeting and starts the helper), then open the meeting.
 * Jottings typed before the call are saved onto it.
 */
export function useStartRecording() {
  const navigate = useNavigate();
  const client = useQueryClient();
  return useCallback(
    async (request: StartRecordingRequest, jottings?: string) => {
      ownStarts++;
      try {
        await bridge["recording:start"](request);
      } catch (error) {
        notify(cleanError(error), "error");
        return false;
      } finally {
        // After main's snapshot for this start has arrived, so it isn't taken for an outside one.
        setTimeout(() => ownStarts--, 0);
      }
      const meetingId = (await bridge["state:get"]()).recording.meetingId;
      void client.invalidateQueries({ queryKey: keys.allMeetings });
      // No meeting: it was stopped while starting (or another one took over). Nothing started.
      if (!meetingId) return false;
      if (jottings?.trim()) {
        await api.saveJottings(meetingId, jottings, new Date().toISOString()).catch(() => {
          notify("Couldn't carry over the notes you wrote before the call.", "error");
        });
      }
      await navigate({ to: "/meetings/$id", params: { id: meetingId } });
      return true;
    },
    [client, navigate],
  );
}

export function useStopRecording() {
  const client = useQueryClient();
  return useCallback(async () => {
    const meetingId = (await bridge["state:get"]()).recording.meetingId;
    try {
      await bridge["recording:stop"]();
    } catch (error) {
      notify(cleanError(error), "error");
    }
    if (meetingId) void client.invalidateQueries({ queryKey: keys.meeting(meetingId) });
    void client.invalidateQueries({ queryKey: keys.allMeetings });
  }, [client]);
}

const DRAFT_PREFIX = "scribe.prejottings.";

/** Before-call notes for a calendar event, kept in this window until recording starts. Keyed by the
 * signed-in Scribe host too, and cleared on sign-out (clearDrafts), so another account never sees
 * them. */
export const draftKey = (eventId: string, appUrl: string | undefined) => `${DRAFT_PREFIX}${appUrl ?? ""}|${eventId}`;

/** Drops every before-call draft: on sign-out, and for drafts of events that are long gone. */
export function clearDrafts(keep: (key: string) => boolean = () => false): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX) && !keep(key)) localStorage.removeItem(key);
    }
  } catch {
    // Storage off: nothing kept.
  }
}

/**
 * When a stop cancels a recording that was still starting: nothing was recorded, so the window
 * returns to the before-meeting page if you were looking at that call (your before-call notes
 * are still there).
 */
export function useCancelledStart() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const prevRef = useRef<RecordingSnapshot | undefined>(undefined);

  return useCallback(
    (next: RecordingSnapshot) => {
      const prev = prevRef.current;
      prevRef.current = next;
      if (!prev || !wasCancelledStart(prev, next)) return;
      const { meetingId, calendarEventId } = prev;
      notify("Stopped before it started. Nothing was recorded.");
      const here = pathRef.current;
      const watching =
        here === "/" ||
        (meetingId && here === `/meetings/${meetingId}`) ||
        (calendarEventId && here === `/upcoming/${calendarEventId}`);
      const goBack = () => {
        if (!watching) return;
        if (calendarEventId) void navigate({ to: "/upcoming/$eventId", params: { eventId: calendarEventId } });
        else if (here !== "/") void navigate({ to: "/" });
      };
      goBack();
      // The empty meeting is main's to clean up (it works with the window closed); refresh lists.
      void client.invalidateQueries({ queryKey: keys.allMeetings });
    },
    [client, navigate],
  );
}

/** Copy a link through main (the sandboxed window can't write the clipboard). */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await bridge["clipboard:writeText"](url);
    return true;
  } catch {
    return false;
  }
}

/** A recording started outside the window (menu, Dock, tray): open its live page. */
export function useFollowRecording() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const prevRef = useRef<RecordingSnapshot | undefined>(undefined);
  return useCallback(
    (next: RecordingSnapshot) => {
      const prev = prevRef.current;
      prevRef.current = next;
      const id = liveMeetingToOpen(prev, next, { pathname: pathRef.current, ownStart: ownStarts > 0 });
      if (id) void navigate({ to: "/meetings/$id", params: { id } });
    },
    [navigate],
  );
}
