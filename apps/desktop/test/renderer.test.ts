import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperEvent } from "@shared/protocol";
import { isAllowedApiCall, isValidApiCallOptions } from "../src/main/api/routes";
import { emptyTranscript, mergeSegments, partialOf, reduceTranscript, type LiveTranscript } from "../src/renderer/src/live";
import { DebouncedSaver } from "../src/renderer/src/saver";

const run = (events: HelperEvent[], from: LiveTranscript = emptyTranscript) => events.reduce(reduceTranscript, from);

describe("live transcript", () => {
  it("keeps the latest text per itemId and clears it when the speaker's segment lands", () => {
    let s = run([
      { event: "state", recording: true, meetingId: "m1", mode: "realtime", mic: "ok", system: "ok" },
      { event: "transcript.delta", speaker: "them", itemId: "a", text: "Sounds" },
      { event: "transcript.delta", speaker: "them", itemId: "a", text: "Sounds good" },
      { event: "transcript.delta", speaker: "me", itemId: "b", text: "Right" },
    ]);
    expect(s.meetingId).toBe("m1");
    expect(partialOf(s)).toEqual({ me: "Right", them: "Sounds good" });
    s = run([{ event: "transcript.segment", seq: 1, speaker: "them", text: "Sounds good.", startedMs: 0, endedMs: 900 }], s);
    expect(partialOf(s)).toEqual({ me: "Right", them: "" });
    expect(s.segments.map((x) => x.text)).toEqual(["Sounds good."]);
  });

  it("ignores a repeated seq and starts clean for a new meeting", () => {
    const seg: HelperEvent = { event: "transcript.segment", seq: 3, speaker: "me", text: "Hi", startedMs: 0, endedMs: 1 };
    let s = run([{ event: "state", recording: true, meetingId: "m1", mode: "realtime", mic: "ok", system: "ok" }, seg, seg]);
    expect(s.segments).toHaveLength(1);
    s = run([{ event: "state", recording: true, meetingId: "m2", mode: "realtime", mic: "ok", system: "ok" }], s);
    expect(s).toEqual({ ...emptyTranscript, meetingId: "m2" });
  });

  it("merges saved and live segments by seq", () => {
    const a = { seq: 1, startedMs: 0, endedMs: 1, speaker: "me" as const, text: "a" };
    const b = { seq: 2, startedMs: 1, endedMs: 2, speaker: "them" as const, text: "b" };
    expect(mergeSegments([b], [a, b]).map((s) => s.seq)).toEqual([1, 2]);
  });
});

describe("jottings saver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once after typing pauses, with the time of the last change", async () => {
    const save = vi.fn(async () => {});
    let t = 0;
    const saver = new DebouncedSaver(save, undefined, 800, () => new Date(Date.UTC(2026, 10, 2, 10, 0, t)));
    saver.change("a");
    t = 1;
    await vi.advanceTimersByTimeAsync(500);
    saver.change("ab");
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("ab", "2026-11-02T10:00:01.000Z");
  });

  it("keeps text that couldn't be saved, and saves it on the next flush", async () => {
    const onError = vi.fn();
    let online = false;
    const save = vi.fn(async () => (online ? undefined : Promise.reject(new Error("offline"))));
    const saver = new DebouncedSaver(save, onError);
    saver.change("x");
    await saver.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(saver.unsaved).toBe(true);
    online = true;
    await saver.flush();
    expect(save).toHaveBeenLastCalledWith("x", expect.any(String));
    expect(saver.unsaved).toBe(false);
    await saver.flush(); // nothing pending: no call
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("a newer change wins over a failed older one", async () => {
    let fail: (e: Error) => void = () => {};
    const save = vi.fn((markdown: string) => (markdown === "old" ? new Promise<void>((_, r) => (fail = r)) : Promise.resolve()));
    const saver = new DebouncedSaver(save);
    saver.change("old");
    const first = saver.flush();
    saver.change("new");
    fail(new Error("offline"));
    await first;
    await saver.flush();
    expect(save).toHaveBeenLastCalledWith("new", expect.any(String));
    expect(saver.unsaved).toBe(false);
  });
});

describe("api:call allowlist", () => {
  it("lets the window's routes through", () => {
    expect(isAllowedApiCall("GET", "api/v1/meetings")).toBe(true);
    expect(isAllowedApiCall("GET", "api/v1/search")).toBe(true);
    expect(isAllowedApiCall("POST", "api/v1/search")).toBe(false);
    expect(isAllowedApiCall("PUT", "api/v1/meetings/abc-123/jottings")).toBe(true);
    expect(isAllowedApiCall("DELETE", "api/v1/meetings/m1/share/l1")).toBe(true);
    expect(isAllowedApiCall("PUT", "api/v1/folders/f1/meetings/m1")).toBe(true);
    expect(isAllowedApiCall("POST", "api/v1/templates/general/duplicate")).toBe(true);
  });

  it("refuses recording routes, other methods, traversal and other hosts", () => {
    expect(isAllowedApiCall("POST", "api/v1/meetings/m1/segments")).toBe(false);
    expect(isAllowedApiCall("POST", "api/v1/meetings/m1/finish")).toBe(true);
    expect(isAllowedApiCall("GET", "api/v1/meetings/m1/finish")).toBe(false);
    expect(isAllowedApiCall("POST", "api/v1/meetings/m1/transcription-token")).toBe(false);
    expect(isAllowedApiCall("DELETE", "api/v1/me")).toBe(false);
    expect(isAllowedApiCall("GET", "api/v1/meetings/../../admin")).toBe(false);
    expect(isAllowedApiCall("GET", "https://evil.example/api/v1/me")).toBe(false);
    expect(isAllowedApiCall("TRACE", "api/v1/me")).toBe(false);
  });

  it("checks options", () => {
    expect(isValidApiCallOptions(undefined)).toBe(true);
    expect(isValidApiCallOptions({ query: { limit: "40" }, body: { a: 1 } })).toBe(true);
    expect(isValidApiCallOptions({ query: { limit: 40 } })).toBe(false);
    expect(isValidApiCallOptions({ headers: {} })).toBe(false);
  });
});

describe("cancelled start", () => {
  it("is a stop that lands in idle before the recording ever started", async () => {
    const { wasCancelledStart } = await import("../src/renderer/src/recording");
    const starting = { state: "starting", meetingId: "m1", calendarEventId: "e1" } as const;
    const stoppingEarly = { ...starting, state: "stopping" } as const;
    expect(wasCancelledStart(starting, { state: "idle" })).toBe(true);
    expect(wasCancelledStart(stoppingEarly, { state: "idle" })).toBe(true);
    // A normal stop: it had started.
    expect(wasCancelledStart({ state: "stopping", meetingId: "m1", startedAt: "2026-11-02T10:00:00Z" }, { state: "idle" })).toBe(false);
    // A start that failed is an error, not a cancel.
    expect(wasCancelledStart(starting, { state: "idle", error: "Microphone access is off" })).toBe(false);
    expect(wasCancelledStart(undefined, { state: "idle" })).toBe(false);
    expect(wasCancelledStart(starting, { state: "recording", startedAt: "x" })).toBe(false);
  });
});

describe("following a recording started outside the window (Codex V2)", () => {
  it("opens the live page when a recording starts from the menu, Dock or tray", async () => {
    const { liveMeetingToOpen } = await import("../src/renderer/src/recording");
    const idle = { state: "idle" } as const;
    const starting = { state: "starting", meetingId: "m9", calendarEventId: "e1" } as const;
    expect(liveMeetingToOpen(idle, starting, { pathname: "/meetings/m2", ownStart: false })).toBe("m9");
    expect(liveMeetingToOpen(idle, { ...starting, state: "recording" }, { pathname: "/", ownStart: false })).toBe("m9");
  });

  it("stays put when the window started it, when you're already there, or writing on that event's page", async () => {
    const { liveMeetingToOpen } = await import("../src/renderer/src/recording");
    const idle = { state: "idle" } as const;
    const starting = { state: "starting", meetingId: "m9", calendarEventId: "e1" } as const;
    expect(liveMeetingToOpen(idle, starting, { pathname: "/", ownStart: true })).toBeNull();
    expect(liveMeetingToOpen(idle, starting, { pathname: "/meetings/m9", ownStart: false })).toBeNull();
    expect(liveMeetingToOpen(idle, starting, { pathname: "/upcoming/e1", ownStart: false })).toBeNull();
    // Another event's before-call page doesn't hold it back.
    expect(liveMeetingToOpen(idle, starting, { pathname: "/upcoming/e2", ownStart: false })).toBe("m9");
  });

  it("fires once, on the meeting appearing, and not for one already running at launch", async () => {
    const { liveMeetingToOpen } = await import("../src/renderer/src/recording");
    const starting = { state: "starting", meetingId: "m9" } as const;
    const recording = { state: "recording", meetingId: "m9", startedAt: "2026-11-02T10:00:00Z" } as const;
    expect(liveMeetingToOpen(undefined, recording, { pathname: "/", ownStart: false })).toBeNull();
    expect(liveMeetingToOpen(starting, recording, { pathname: "/", ownStart: false })).toBeNull();
    expect(liveMeetingToOpen({ state: "idle" }, { state: "starting" }, { pathname: "/", ownStart: false })).toBeNull();
    expect(liveMeetingToOpen(recording, { state: "stopping", meetingId: "m9" }, { pathname: "/", ownStart: false })).toBeNull();
  });
});

describe("time-based segment seqs (lane H #37)", () => {
  it("slots replayed segments into place, in time order, whatever order they arrive in", () => {
    const seq = (startedMs: number, them: boolean, replayed: boolean) => startedMs * 4 + (them ? 2 : 0) + (replayed ? 1 : 0);
    const seg = (startedMs: number, speaker: "me" | "them", replayed = false) => ({
      event: "transcript.segment" as const,
      seq: seq(startedMs, speaker === "them", replayed),
      speaker,
      text: `${speaker}@${startedMs}`,
      startedMs,
      endedMs: startedMs + 900,
    });
    // Live before and after an outage, then the outage's audio replayed late.
    const s = [seg(1_000, "me"), seg(60_000, "them"), seg(20_000, "them", true), seg(30_000, "me", true), seg(20_000, "them", true)].reduce(
      reduceTranscript,
      emptyTranscript,
    );
    expect(s.segments.map((x) => x.text)).toEqual(["me@1000", "them@20000", "me@30000", "them@60000"]);
    expect(mergeSegments([], s.segments).map((x) => x.startedMs)).toEqual([1_000, 20_000, 30_000, 60_000]);
  });
});
