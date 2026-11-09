// `everyapp://scribe/record[?event=<calendarEventId>&title=<t>&start=<ISO 8601>&join=1]`
// (`everyapp-dev://` in dev builds), opened by the Scribe web app's Record buttons. The first
// segment is the feature (src/shared/features.ts), so later features get their own links. Any web
// page can open one, so nothing in it is trusted: Scribe starts at once only for an event in its
// own upcoming list.

import { flexibleDate, type CalendarEvent } from "@shared/api";
import { SCRIBE } from "@shared/features";

const MAX_TITLE = 200;

export interface DeepLink {
  eventId?: string;
  title?: string;
  start?: string;
  join: boolean;
}

/** undefined for anything but an `everyapp://scribe/record` URL. `schemes` are the ones this build
 * owns (a dev build owns `everyapp-dev`, so it never takes links meant for the installed app). */
export function parseDeepLink(raw: string, schemes: readonly string[] = ["everyapp"]): DeepLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!schemes.includes(url.protocol.toLowerCase().replace(/:$/, ""))) return undefined;
  // `everyapp://scribe/record` puts the feature in the host; `everyapp:scribe/record` has it all in
  // the path.
  const command = `${url.host}/${url.pathname}`.replace(/\/+/g, "/").replace(/^\/|\/$/g, "").toLowerCase();
  if (command !== `${SCRIBE.id}/record`) return undefined;
  const value = (name: string) => {
    const v = url.searchParams.get(name)?.trim();
    return v ? v : undefined;
  };
  // eslint-disable-next-line no-control-regex
  const title = value("title")?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, MAX_TITLE);
  const join = ["1", "true", "yes"].includes((value("join") ?? "").toLowerCase());
  return { eventId: value("event"), title: title || undefined, start: flexibleDate(value("start"))?.toISOString(), join };
}

export type DeepLinkAction =
  /** An event the app already knows: start at once, with the app's own details. */
  | { kind: "start"; event: CalendarEvent; join: boolean }
  /** Anything else: ask the person first. Never opens a link from the URL. */
  | { kind: "confirm"; title: string; start?: string; eventId?: string };

export function resolveDeepLink(request: DeepLink, upcoming: CalendarEvent[], fallbackTitle: string): DeepLinkAction {
  const event = request.eventId ? upcoming.find((e) => e.id === request.eventId) : undefined;
  if (event) return { kind: "start", event, join: request.join };
  return { kind: "confirm", title: request.title ?? fallbackTitle, start: request.start, eventId: request.eventId };
}
