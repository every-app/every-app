import { describe, expect, it } from "vitest";
import type { CalendarSnapshot } from "@shared/ipc";
import { comingUpFrom } from "../src/renderer/src/calendar";
import { cameBackOnline } from "../src/renderer/src/connection";

const event = { id: "e1", title: "Acme renewal", start: "2026-11-02T15:00:00.000Z", end: "2026-11-02T15:30:00.000Z", attendees: [] };

describe("Coming up after an outage (Codex V5)", () => {
  it("keeps the events main already has when a refresh fails", () => {
    const failedRefresh: CalendarSnapshot = { connected: true, events: [event], lastRefresh: "2026-11-02T14:00:00.000Z", error: "Couldn't reach Scribe: fetch failed" };
    const shown = comingUpFrom(failedRefresh);
    expect(shown).toMatchObject({ status: "ready", data: { state: "ok", events: [{ id: "e1", title: "Acme renewal" }] } });
  });

  it("shows the error only when there's nothing else, and clears when main refreshes", () => {
    const nothing: CalendarSnapshot = { connected: true, events: [], error: "Couldn't reach Scribe: fetch failed" };
    expect(comingUpFrom(nothing)).toEqual({ status: "ready", data: { state: "error", message: "Couldn't reach Scribe: fetch failed" } });
    // A successful refresh drops `error` (main's CalendarService): the card is back.
    const refreshed: CalendarSnapshot = { connected: true, events: [event], lastRefresh: "2026-11-02T14:05:00.000Z" };
    expect(comingUpFrom(refreshed)).toMatchObject({ status: "ready", data: { state: "ok" } });
  });

  it("asks for a refresh exactly when the connection comes back", () => {
    expect(cameBackOnline("offline", "online")).toBe(true);
    expect(cameBackOnline("signin-needed", "online")).toBe(true);
    expect(cameBackOnline("online", "online")).toBe(false);
    expect(cameBackOnline("online", "offline")).toBe(false);
  });
});
