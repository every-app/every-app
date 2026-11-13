// A types-only copy of the Scribe backend's web/src/api/contract.ts (the /api/v1 contract), without zod. Keep it in
// sync with that file; the input shapes at the bottom mirror its zod schemas.

export interface ApiError {
  /**
   * A stable code: unauthenticated, not_found, forbidden, invalid_json,
   * invalid_body, invalid_query, invalid_cursor, busy, unknown_template,
   * template_unavailable, internal_error, …
   */
  error: string;
  message?: string;
  /** zod's issues, on invalid_body and invalid_query. */
  issues?: unknown[];
}

export interface OkResponse {
  ok: true;
}

export type MeetingStatus = "recording" | "processing" | "done" | "failed";

export type Visibility = "private" | "team";

export type Speaker = "me" | "them";

export interface Attendee {
  email: string | null;
  name: string | null;
  self: boolean;
}

export interface MeetingRow {
  id: string;
  title: string;
  /** ISO 8601. */
  startsAt: string;
  endsAt: string | null;
  status: MeetingStatus;
  visibility: Visibility;
  ownerUserId: string;
  ownerEmail: string | null;
  attendeeCount: number;
  /** The caller owns it. */
  mine: boolean;
}

export interface Segment {
  seq: number;
  startedMs: number;
  endedMs: number;
  /** "me" (microphone), "them" (system audio), null for a mixed stream. */
  speaker: Speaker | null;
  text: string;
}

export interface Notes {
  markdown: string;
  /** The model that wrote them ("manual" if the owner wrote them first). */
  model: string;
  generatedAt: string;
  /** When the owner last edited them; null for notes as written. */
  editedAt: string | null;
}

export interface Jottings {
  markdown: string;
  /** ISO 8601: when the person typed it. */
  updatedAt: string;
}

/**
 * What to print for each side of the transcript, for the person asking:
 * names from the meeting's calendar guests, worked out by Scribe on every
 * read and already cleaned (one line, at most 80 characters).
 */
export interface SpeakerLabels {
  /** `me` lines: "Me" for the recorder's own view; for anyone else their name, or "Note-taker". */
  me: string;
  /** `them` lines: the one other guest's name; "Others" with several; "Them" with none. */
  them: string;
  /** With several other guests: "With Dana Lee, Sam Okafor and 2 more". Else null. */
  guests: string | null;
}

export interface MeetingDetail extends MeetingRow {
  attendees: Attendee[];
  /** The folders it is in that the caller can see. */
  folders: { id: string; name: string; space: Visibility }[];
  /**
   * The template the notes use, and whether it was chosen on the meeting.
   * Someone else's private template shows as `{ id: "", name: "Private
   * template", chosen: false }`.
   */
  template: { id: string; name: string; chosen: boolean };
  segments: Segment[];
  /** Absent from a Scribe older than speaker names: the app says Me and Them. */
  speakers?: SpeakerLabels;
  notes: Notes | null;
  /** The owner's alone: null for anyone else, or before they type. */
  jottings: Jottings | null;
  /** The owner's alone: empty for anyone else. */
  shareLinks: { id: string; createdAt: string }[];
}

export interface CreateMeetingResponse {
  id: string;
  meeting: MeetingRow;
}

export interface PatchMeetingResponse {
  meeting: MeetingDetail;
  rewriting: boolean;
}

export interface ListMeetingsResponse {
  meetings: MeetingRow[];
  nextCursor: string | null;
}

export type SearchField = "title" | "notes" | "jottings" | "transcript";

/** Plain text (never markup), with matched words as [start, end) UTF-16 offsets; "…" marks a cut. */
export interface SearchSnippet {
  text: string;
  ranges: { start: number; end: number }[];
}

export interface SearchResult {
  meeting: MeetingRow;
  /** Where the best match is. */
  field: SearchField;
  snippet: SearchSnippet;
}

/** GET /search?q&limit&cursor: one result per meeting, best match first. */
export interface SearchResponse {
  results: SearchResult[];
  nextCursor: string | null;
}

export interface GetMeetingResponse {
  meeting: MeetingDetail;
}

export interface SaveJottingsResponse {
  jottings: Jottings;
  applied: boolean;
}

export interface EditNotesResponse {
  notes: Notes;
}

export interface FinishMeetingResponse {
  meeting: MeetingRow;
}

export interface TranscriptionToken {
  value: string;
  expiresAt: number;
  model: string;
  sampleRate: 24000;
}

export interface ShareLinkResponse {
  link: { id: string; url: string };
}

export interface Folder {
  id: string;
  name: string;
  space: Visibility;
  defaultTemplateId: string | null;
}

export type FolderWithCount = Folder & {
  /** The folder's meetings the caller can read. */
  meetingCount: number;
}

export interface ListFoldersResponse {
  folders: FolderWithCount[];
}

export interface FolderResponse {
  folder: Folder | FolderWithCount;
}

export interface FileMeetingResponse {
  shared: boolean;
}

export interface Template {
  id: string;
  name: string;
  instructions: string;
  builtIn: boolean;
  visibility: Visibility;
  /** The caller owns it (false for built-ins). */
  mine: boolean;
}

export interface ListTemplatesResponse {
  templates: Template[];
  defaultTemplateId: string;
}

export interface TemplateResponse {
  template: Template;
}

export interface Settings {
  defaultTemplateId: string;
}

export interface SettingsResponse {
  settings: Settings;
}

export type CalendarStatus =
  | { available: false }
  | {
      available: true;
      connected: false;
      reconnect: boolean;
      connectUrl: string;
    }
  | { available: true; connected: true };

export interface MeResponse {
  user: { id: string; email: string; orgName: string | null };
  calendar: CalendarStatus;
  google: { connected: boolean; connectUrl: string | null };
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: { email: string | null; name: string | null; self: boolean }[];
  conferenceUrl: string | null;
  location: string | null;
}

export interface UpcomingResponse {
  events: CalendarEvent[];
  connected: boolean;
  connectUrl?: string | null;
  calendar: CalendarStatus;
  error?: string;
}

// Request bodies and queries (the contract's zod schemas, as types)

export interface CreateMeetingInput {
  title: string;
  startsAt?: string;
  calendarEventId?: string;
  attendees?: { email?: string | null; name?: string | null; self?: boolean }[];
}
export interface PatchMeetingInput {
  title?: string;
  visibility?: Visibility;
  templateId?: string | null;
}
export interface ListMeetingsQuery {
  folderId?: string;
  shared?: boolean;
  mine?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}
export interface SaveJottingsInput {
  markdown: string;
  updatedAt?: string;
}
export interface EditNotesInput {
  markdown: string;
}
export interface CreateFolderInput {
  name: string;
  space: Visibility;
}
export interface UpdateFolderInput {
  name?: string;
  defaultTemplateId?: string | null;
}
export interface SaveTemplateInput {
  name: string;
  instructions: string;
  visibility: Visibility;
}
export type UpdateTemplateInput = Partial<SaveTemplateInput>;
export interface UpdateSettingsInput {
  defaultTemplateId?: string;
}
