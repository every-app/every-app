// What the meeting page draws. A failed fetch never takes away a page that has something to show:
// the last data stays, and a meeting this Mac is recording always has its notepad, even when
// the first fetch fails (offline): it's drawn from the recording snapshot until the API answers.
// Bridge-free, for the tests.

import type { MeetingDetail } from "@shared/contract";
import type { RecordingSnapshot } from "@shared/ipc";

export function recordingHereOf(rec: RecordingSnapshot | undefined, id: string): rec is RecordingSnapshot {
  return !!rec && rec.state !== "idle" && rec.meetingId === id;
}

export function meetingForView(
  data: MeetingDetail | undefined,
  rec: RecordingSnapshot | undefined,
  id: string,
  ownerEmail: string | null = null,
): MeetingDetail | null {
  if (data) return data;
  if (!recordingHereOf(rec, id)) return null;
  return {
    id,
    title: rec?.title ?? "Meeting",
    startsAt: rec?.startedAt ?? new Date().toISOString(),
    endsAt: null,
    status: "recording",
    visibility: "private",
    ownerUserId: "",
    ownerEmail,
    attendeeCount: 0,
    mine: true,
    attendees: [],
    folders: [],
    template: { id: "", name: "Default template", chosen: false },
    segments: [],
    notes: null,
    jottings: null,
    shareLinks: [],
  };
}
