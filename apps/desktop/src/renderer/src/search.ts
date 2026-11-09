// Search helpers, bridge-free for the tests.

import type { Connection } from "@shared/ipc";
import type { SearchField, SearchResult } from "@shared/contract";

/** The meeting page's tabs (MeetingTab in @every-app/desktop-ui; kept here so tests don't load React code). */
export type MeetingTab = "notes" | "jottings" | "transcript";

/** Worth sending: at least one letter or digit (punctuation alone matches nothing). */
export function searchable(q: string): boolean {
  return /[\p{L}\p{N}]/u.test(q);
}

/** Open the meeting where the match is: its transcript or jottings tab; notes is the default. */
export function tabFor(field: SearchField): MeetingTab | undefined {
  return field === "transcript" ? "transcript" : field === "jottings" ? "jottings" : undefined;
}

export function parseTab(value: unknown): MeetingTab | undefined {
  return value === "notes" || value === "jottings" || value === "transcript" ? value : undefined;
}

export const OFFLINE_TEXT = "Search needs a connection. Your meetings come back when you're online.";
export const SIGNIN_TEXT = "Sign in again to search your meetings.";

type State =
  | { status: "idle" }
  | { status: "offline"; message: string }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: { results: SearchResult[]; hasMore: boolean } };

/** What search shows, from the query, the connection and the request's state. */
export function searchState(input: {
  settled: string;
  connection: Connection;
  pending: boolean;
  error: string | null;
  results: SearchResult[];
  hasMore: boolean;
}): State {
  if (!input.settled) return { status: "idle" };
  if (input.connection === "offline") return { status: "offline", message: OFFLINE_TEXT };
  if (input.connection === "signin-needed") return { status: "offline", message: SIGNIN_TEXT };
  if (!searchable(input.settled)) return { status: "ready", data: { results: [], hasMore: false } };
  if (input.error) return { status: "error", message: input.error };
  if (input.pending) return { status: "loading" };
  return { status: "ready", data: { results: input.results, hasMore: input.hasMore } };
}
