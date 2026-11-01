/**
 * What the harness said, read from events.jsonl only (never trusted for the
 * verdict): did it print DONE and which URL, did it say BLOCKED, did it
 * show the person the setup link, which session to resume.
 */
import { parseBlocked, parseDone } from "../scriptedUser";
import type { NormalizedEvent } from "../types";

const LINK_SURFACED =
  /est_[A-Za-z0-9_-]{20,}|open (this|the) (setup )?link|setup link|\/setup#token=/i;

/** Assistant text and result text joined, in order. */
export function assistantText(events: NormalizedEvent[]): string {
  return events
    .filter(
      (event) =>
        (event.kind === "assistant_text" || event.kind === "result") &&
        event.text,
    )
    .map((event) => event.text as string)
    .join("\n");
}

/** `DONE` with the URL the harness printed, looked for from the last turn backwards; the gateway's URL when several follow DONE. */
export function printedDone(
  events: NormalizedEvent[],
  gatewayOrigin?: string,
): {
  done: boolean;
  url: string | null;
} {
  const texts = events
    .filter(
      (event) =>
        (event.kind === "assistant_text" || event.kind === "result") &&
        event.text,
    )
    .map((e) => e.text as string);
  for (let i = texts.length - 1; i >= 0; i--) {
    const parsed = parseDone(texts[i]!, gatewayOrigin);
    if (parsed.done) return parsed;
  }
  return { done: false, url: null };
}

export function printedBlocked(events: NormalizedEvent[]): string | null {
  const texts = events
    .filter(
      (event) =>
        (event.kind === "assistant_text" || event.kind === "result") &&
        event.text,
    )
    .map((e) => e.text as string);
  for (let i = texts.length - 1; i >= 0; i--) {
    const blocked = parseBlocked(texts[i]!);
    if (blocked) return blocked;
  }
  return null;
}

/** The est_ URL or an "open this link" sentence appeared in assistant text (telemetry; the claim never depends on it). */
export function linkSurfacedToPerson(events: NormalizedEvent[]): boolean {
  return events.some(
    (event) =>
      event.kind === "assistant_text" && LINK_SURFACED.test(event.text ?? ""),
  );
}

/** The session id to resume with: the last one any event carried. */
export function lastSessionId(events: NormalizedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i]!.sessionId;
    if (id) return id;
  }
  return null;
}

/** Tool calls by tool name, for the record and `wouldPromptEstimate = toolCalls.Bash`. */
export function toolCallCounts(
  events: NormalizedEvent[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.kind !== "tool_call") continue;
    const tool = event.tool ?? "unknown";
    counts[tool] = (counts[tool] ?? 0) + 1;
  }
  return counts;
}

/** The harness exited on a provider 401/429/529/overloaded and no turn came after it. */
export function providerErrorAtExit(events: NormalizedEvent[]): boolean {
  const last = [...events]
    .reverse()
    .find(
      (event) => event.kind === "result" || event.kind === "assistant_text",
    );
  if (!last || !last.isError) return false;
  const text = `${last.text ?? ""} ${last.stopReason ?? ""}`;
  return /\b(401|429|529)\b|overloaded|rate.?limit|authentication_failed|api_error|insufficient_quota|billing/i.test(
    text,
  );
}
