// The shapes of Scribe's /api/v1 (docs/scribe.md "API"), and lenient decoders ported from
// mac/Sources/HelperCore/APIModels.swift: a list may come bare or wrapped, a date as ISO 8601 or
// epoch, an attendee as an object or a plain email. Dates cross IPC as ISO strings.

export interface Me {
  id?: string;
  email?: string;
  name?: string;
  orgName?: string;
  googleConnected: boolean;
  connectUrl?: string;
}

export interface Attendee {
  email?: string;
  name?: string;
  /** Google marks the calendar's owner `self: true`; undefined when the server didn't say. */
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601. */
  start: string;
  end?: string;
  attendees: Attendee[];
  conferenceUrl?: string;
  location?: string;
}

export interface UpcomingResponse {
  events: CalendarEvent[];
  connected: boolean;
  connectUrl?: string;
}

export interface MeetingSummary {
  id: string;
  title: string;
  startsAt?: string;
  endsAt?: string;
  status?: string;
  visibility?: string;
  url?: string;
}

export interface Segment {
  seq: number;
  startedMs: number;
  endedMs: number;
  speaker: "me" | "them" | null;
  text: string;
}

export interface MeetingDetail extends MeetingSummary {
  segments: Segment[];
  notes?: { markdown: string; generatedAt?: string; editedAt?: string } | null;
  shareLinks: { id: string; url?: string }[];
}

export interface MeetingPatch {
  title?: string;
  visibility?: "private" | "team";
}

export interface CreateMeetingRequest {
  title: string;
  startsAt?: string;
  calendarEventId?: string;
  attendees?: Attendee[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nonEmpty = (v: unknown): string | undefined => {
  const s = str(v);
  return s ? s : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** An id that may arrive as a string or a number. */
export function lenientId(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** ISO 8601 (with or without fractional seconds, or a bare date) or epoch seconds/milliseconds. */
export function flexibleDate(v: unknown): Date | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 100_000_000_000 ? v : v * 1000);
  if (typeof v !== "string" || !v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const iso = (v: unknown): string | undefined => flexibleDate(v)?.toISOString();

export function decodeMe(json: unknown): Me {
  if (!isObj(json)) throw new DecodeError("me");
  const user = isObj(json.user) ? json.user : json;
  const google = isObj(json.google) ? json.google : undefined;
  return {
    id: lenientId(user.id),
    email: str(user.email),
    name: str(user.name),
    orgName: str(user.orgName) ?? str(json.orgName),
    googleConnected: google ? (bool(google.connected) ?? false) : (bool(json.googleConnected) ?? bool(json.connected) ?? false),
    connectUrl: google ? str(google.connectUrl) : str(json.connectUrl),
  };
}

export function decodeAttendee(v: unknown): Attendee | undefined {
  if (typeof v === "string") return { email: v };
  if (!isObj(v)) return undefined;
  return { email: str(v.email), name: str(v.name) ?? str(v.displayName), self: bool(v.self) };
}

export function decodeEvent(v: unknown): CalendarEvent | undefined {
  if (!isObj(v)) return undefined;
  const id = lenientId(v.id);
  const start = iso(v.start) ?? iso(v.startsAt);
  if (!id || !start) return undefined;
  const attendees = Array.isArray(v.attendees)
    ? v.attendees.map(decodeAttendee).filter((a): a is Attendee => !!a)
    : [];
  return {
    id,
    title: nonEmpty(v.title) ?? nonEmpty(v.summary) ?? "Untitled meeting",
    start,
    end: iso(v.end) ?? iso(v.endsAt),
    attendees,
    conferenceUrl: nonEmpty(v.conferenceUrl) ?? nonEmpty(v.hangoutLink),
    location: str(v.location),
  };
}

export function decodeUpcoming(json: unknown): UpcomingResponse {
  const decodeList = (list: unknown[]) => list.map(decodeEvent).filter((e): e is CalendarEvent => !!e);
  if (Array.isArray(json)) return { events: decodeList(json), connected: true };
  if (!isObj(json)) throw new DecodeError("calendar");
  const list = Array.isArray(json.events) ? json.events : Array.isArray(json.items) ? json.items : [];
  const connectUrl = str(json.connectUrl);
  return {
    events: decodeList(list),
    connected: bool(json.connected) ?? bool(json.googleConnected) ?? connectUrl === undefined,
    connectUrl,
  };
}

export function decodeMeetingSummary(v: unknown): MeetingSummary | undefined {
  if (!isObj(v)) return undefined;
  const id = lenientId(v.id);
  if (!id) return undefined;
  return {
    id,
    title: nonEmpty(v.title) ?? "Untitled meeting",
    startsAt: iso(v.startsAt) ?? iso(v.starts_at) ?? iso(v.createdAt),
    endsAt: iso(v.endsAt) ?? iso(v.ends_at),
    status: str(v.status),
    visibility: str(v.visibility),
    url: str(v.url),
  };
}

export function decodeMeetingList(json: unknown): MeetingSummary[] {
  const list = Array.isArray(json)
    ? json
    : isObj(json) && Array.isArray(json.meetings)
      ? json.meetings
      : isObj(json) && Array.isArray(json.items)
        ? json.items
        : undefined;
  if (!list) throw new DecodeError("meetings");
  return list.map(decodeMeetingSummary).filter((m): m is MeetingSummary => !!m);
}

/** `{ meeting }` or a bare meeting, with `segments`, `notes`, `shareLinks` (inside or beside it). */
export function decodeMeetingDetail(json: unknown): MeetingDetail {
  if (!isObj(json)) throw new DecodeError("meeting");
  const m = isObj(json.meeting) ? json.meeting : json;
  const summary = decodeMeetingSummary(m);
  if (!summary) throw new DecodeError("meeting");
  const pick = (key: string) => m[key] ?? json[key];
  const segments: Segment[] = (Array.isArray(pick("segments")) ? (pick("segments") as unknown[]) : [])
    .filter(isObj)
    .map((s) => ({
      seq: Number(s.seq ?? 0),
      startedMs: Number(s.startedMs ?? s.started_ms ?? 0),
      endedMs: Number(s.endedMs ?? s.ended_ms ?? 0),
      speaker: s.speaker === "me" || s.speaker === "them" ? (s.speaker as "me" | "them") : null,
      text: str(s.text) ?? "",
    }));
  const n = pick("notes");
  const notes = isObj(n)
    ? { markdown: str(n.markdown) ?? "", generatedAt: iso(n.generatedAt), editedAt: iso(n.editedAt) }
    : typeof n === "string"
      ? { markdown: n }
      : null;
  const shareLinks = (Array.isArray(pick("shareLinks")) ? (pick("shareLinks") as unknown[]) : [])
    .filter(isObj)
    .map((l) => ({ id: lenientId(l.id) ?? "", url: str(l.url) }))
    .filter((l) => l.id);
  return { ...summary, segments, notes, shareLinks };
}

export function decodeCreatedMeetingId(json: unknown): string {
  if (!isObj(json)) throw new DecodeError("meeting");
  const id = isObj(json.meeting) ? lenientId(json.meeting.id) : lenientId(json.id);
  if (!id) throw new DecodeError("meeting");
  return id;
}

/** SPEC: remind for an event that has other attendees or a conference link. */
export function isMeeting(event: CalendarEvent): boolean {
  if (event.conferenceUrl) return true;
  if (event.attendees.some((a) => a.self !== undefined)) return event.attendees.some((a) => a.self !== true);
  // Without `self` flags the owner is probably in the list too.
  return event.attendees.length >= 2;
}

export class DecodeError extends Error {
  constructor(readonly what: string) {
    super(`Scribe sent something unexpected (${what}).`);
    this.name = "DecodeError";
  }
}
