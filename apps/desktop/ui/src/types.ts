/**
 * The shapes the screens draw. They mirror the Scribe backend's /api/v1 contract
 * (web/src/api/contract.ts in the Scribe repo) structurally; nothing here imports it.
 * Helper-protocol shapes (levels, transcript deltas, permissions) mirror
 * docs/desktop-plan.md.
 */

export type Space = "private" | "team";

export interface Folder {
  id: string;
  name: string;
  space: Space;
  defaultTemplateId: string | null;
}

export interface Template {
  id: string;
  name: string;
  instructions: string;
  builtIn: boolean;
  visibility: Space;
  mine: boolean;
}

export interface Attendee {
  email: string | null;
  name: string | null;
  self: boolean;
}

export type MeetingStatus = "recording" | "processing" | "done" | "failed";

/** One row of GET /api/v1/meetings. */
export interface MeetingRow {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  status: MeetingStatus;
  visibility: Space;
  ownerUserId: string;
  ownerEmail: string | null;
  attendeeCount: number;
  mine: boolean;
}

export interface Segment {
  seq: number;
  startedMs: number;
  endedMs: number;
  speaker: "me" | "them" | null;
  text: string;
}

export interface Notes {
  markdown: string;
  model: string;
  generatedAt: string;
  editedAt: string | null;
}

export interface Jottings {
  markdown: string;
  updatedAt: string;
}

/** GET /api/v1/meetings/:id → { meeting }. */
export interface MeetingDetail extends MeetingRow {
  attendees: Attendee[];
  folders: { id: string; name: string; space: Space }[];
  template: { id: string; name: string; chosen: boolean };
  segments: Segment[];
  notes: Notes | null;
  /** Null for anyone but the owner, or before the owner types anything. */
  jottings: Jottings | null;
  shareLinks: { id: string; createdAt: string }[];
}

export type SearchField = "title" | "notes" | "jottings" | "transcript";

/** GET /api/v1/search: one result per meeting, best match first. */
export interface SearchResult {
  meeting: MeetingRow;
  /** Where the best match is. */
  field: SearchField;
  /** Plain text with matched words as [start, end) UTF-16 offsets; "…" marks a cut. */
  snippet: { text: string; ranges: { start: number; end: number }[] };
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: Attendee[];
  conferenceUrl: string | null;
  location: string | null;
  /** The meeting already recorded for this event, if any. */
  meetingId: string | null;
}

export type ComingUp =
  | { state: "unavailable" }
  | { state: "disconnected"; reconnect: boolean }
  | { state: "error"; message: string }
  | { state: "ok"; events: CalendarEvent[] };

export interface Account {
  name: string;
  email: string;
  orgName: string;
}

/* Helper protocol ------------------------------------------------------ */

export type PermissionStatus =
  | "granted"
  | "denied"
  | "undetermined"
  | "unknown";

export interface Permissions {
  mic: PermissionStatus;
  systemAudio: PermissionStatus;
  notifications: PermissionStatus;
}

export type PermissionKind = keyof Permissions;

/** `levels` events, 0–1. */
export interface Levels {
  mic: number;
  system: number;
}

/** Text still being spoken, from `transcript.delta`, keyed by speaker. */
export interface PartialTranscript {
  me: string;
  them: string;
}

export type ChannelHealth = "ok" | "silent" | "error";

/** What the window knows about a recording in progress. */
export interface LiveRecording {
  meetingId: string;
  title: string;
  startedAt: string;
  mode: "realtime" | "fallback";
  mic: ChannelHealth;
  system: ChannelHealth;
}

/** One side of "Check microphone & Mac audio" (the helper's selftest.run / selftest.progress). */
export interface SelfTestSide {
  status: "ok" | "silent" | "denied" | "error";
  peak: number;
  sampleRate?: number;
  device?: string;
  clipping: boolean;
  clippedSamples: number;
  dropouts: number;
  message?: string;
}

export interface SelfTestReport {
  /** Whole seconds heard so far. */
  seconds: number;
  passed: boolean;
  mic: SelfTestSide;
  system: SelfTestSide;
}

/* Screen plumbing ------------------------------------------------------- */

/** A value the screen waits for. Screens never fetch; callers pass this. */
export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

/** Where the sidebar can take you. The router maps these to URLs. */
export type NavTarget =
  | { to: "home" }
  | { to: "shared" }
  | { to: "search" }
  | { to: "folder"; id: string }
  | { to: "templates" }
  | { to: "settings" };
