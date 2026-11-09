import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperSupervisor } from "../src/main/helper/supervisor";
import type { HelperEvent } from "@shared/protocol";
import { LiveTranscriptBuffer, TRANSCRIPT_LIMITS } from "../src/main/liveTranscript";
import { GAP, HoverTracker, INSET, LIFT, MARGIN, PANEL, PILL, pillLayout, shouldShowPill, takesMouse, zoneAt } from "../src/main/pill";
import { validArgs } from "../src/main/ipcValidation";
import { parseSettingsPatch, readSettings } from "../src/main/settings";
import { pillNotice } from "../src/renderer/src/pill/view";

const state = (meetingId: string): HelperEvent => ({ event: "state", recording: true, meetingId, mode: "realtime", mic: "ok", system: "ok" });
const segment = (seq: number, text = `line ${seq}`, speaker: "me" | "them" = "them"): HelperEvent => ({
  event: "transcript.segment",
  seq,
  speaker,
  text,
  startedMs: seq * 1000,
  endedMs: seq * 1000 + 900,
});
const delta = (itemId: string, text: string, speaker: "me" | "them" = "them"): HelperEvent => ({ event: "transcript.delta", itemId, speaker, text });

describe("floating recorder: when it shows", () => {
  it("shows from start until the stop has finished, only with the setting on", () => {
    expect(shouldShowPill("idle", true)).toBe(false);
    expect(shouldShowPill("starting", true)).toBe(true);
    expect(shouldShowPill("recording", true)).toBe(true);
    expect(shouldShowPill("stopping", true)).toBe(true);
    for (const s of ["idle", "starting", "recording", "stopping"] as const) expect(shouldShowPill(s, false)).toBe(false);
  });

  it("is on by default, and the setting can be turned off", () => {
    expect(readSettings({}).floatingRecorder).toBe(true);
    expect(readSettings({ floatingRecorder: false }).floatingRecorder).toBe(false);
    expect(readSettings({ floatingRecorder: "no" }).floatingRecorder).toBe(true);
    expect(parseSettingsPatch({ floatingRecorder: false })).toEqual({ floatingRecorder: false });
    expect(parseSettingsPatch({ floatingRecorder: 1 })).toBeNull();
  });

  it("takes no arguments over IPC", () => {
    expect(validArgs("pill:get", [])).toBe(true);
    expect(validArgs("pill:openMeeting", [])).toBe(true);
    expect(validArgs("pill:openMeeting", ["m1"])).toBe(false);
  });
});

describe("floating recorder: where it sits", () => {
  const workArea = { x: 0, y: 25, width: 1512, height: 920 };

  it("puts the pill in the work area's bottom-right corner, the panel to its left", () => {
    const l = pillLayout(workArea);
    const pill = { x: l.window.x + l.pill.x, y: l.window.y + l.pill.y };
    expect(pill.x + PILL.width).toBe(workArea.x + workArea.width - MARGIN);
    // The panel's bottom is MARGIN up from the bottom; the pill sits LIFT above it.
    expect(l.window.y + l.panel.y + l.panel.height).toBe(workArea.y + workArea.height - MARGIN);
    expect(pill.y + PILL.height).toBe(workArea.y + workArea.height - MARGIN - LIFT);
    expect(l.panel).toMatchObject({ width: PANEL.width, height: PANEL.height });
    expect(l.panel.x + l.panel.width + GAP).toBe(l.pill.x);
    expect(l.window.width).toBe(l.pill.x + l.pill.width + INSET);
    expect(l.window.height).toBe(l.panel.y + l.panel.height + INSET);
  });

  it("follows a display that isn't at the origin, and shrinks the panel on a small one", () => {
    const second = { x: -1280, y: -200, width: 1280, height: 300 };
    const l = pillLayout(second);
    expect(l.window.x + l.window.width).toBe(second.x + second.width - MARGIN + INSET);
    expect(l.window.y + l.window.height).toBe(second.y + second.height - MARGIN + INSET);
    expect(l.panel.height).toBeLessThan(PANEL.height);
    expect(l.window.y).toBeGreaterThanOrEqual(second.y);
  });

  it("knows what the cursor is over", () => {
    const l = pillLayout(workArea);
    const screenPoint = (x: number, y: number) => ({ x: l.window.x + x, y: l.window.y + y });
    expect(zoneAt(screenPoint(l.pill.x + 5, l.pill.y + 5), l)).toBe("pill");
    expect(zoneAt(screenPoint(l.panel.x + 10, l.panel.y + 10), l)).toBe("panel");
    // The gap between them counts as the panel.
    expect(zoneAt(screenPoint(l.pill.x - 2, l.pill.y + 5), l)).toBe("panel");
    // Above the pill, and outside the window: nothing.
    expect(zoneAt(screenPoint(l.pill.x + 5, l.pill.y - 20), l)).toBeNull();
    expect(zoneAt({ x: l.window.x - 50, y: l.window.y }, l)).toBeNull();
  });
});

describe("floating recorder: hover", () => {
  it("opens after resting on the pill, not when passing over it", () => {
    const h = new HoverTracker(150, 400);
    expect(h.update("pill", 0)).toBe(false);
    expect(h.update(null, 100)).toBe(false);
    expect(h.update("pill", 200)).toBe(false);
    expect(h.update("pill", 300)).toBe(false);
    expect(h.update("pill", 350)).toBe(true);
  });

  it("doesn't open from the hidden panel's area", () => {
    const h = new HoverTracker(150, 400);
    for (let t = 0; t <= 1000; t += 50) expect(h.update("panel", t)).toBe(false);
  });

  it("stays open over the pill or the panel and closes shortly after leaving both", () => {
    const h = new HoverTracker(150, 400);
    h.update("pill", 0);
    expect(h.update("pill", 150)).toBe(true);
    expect(h.update("panel", 1000)).toBe(true);
    expect(h.update(null, 1100)).toBe(true);
    // Back before the delay: still open, and the delay starts over.
    expect(h.update("panel", 1300)).toBe(true);
    expect(h.update(null, 1400)).toBe(true);
    expect(h.update(null, 1750)).toBe(true);
    expect(h.update(null, 1800)).toBe(false);
    h.reset();
    expect(h.isExpanded).toBe(false);
  });

  it("lets clicks through except over the pill or the open panel", () => {
    expect(takesMouse("pill", false)).toBe(true);
    expect(takesMouse("panel", false)).toBe(false);
    expect(takesMouse("panel", true)).toBe(true);
    expect(takesMouse(null, true)).toBe(false);
  });
});

describe("floating recorder: live transcript buffer", () => {
  it("keeps finished turns and the turn in progress, with its partial text", () => {
    const b = new LiveTranscriptBuffer();
    b.observe(state("m1"));
    b.observe(segment(4, "Hello there"));
    b.observe(delta("i2", "And when you"));
    b.observe(delta("i2", "And when you hover over it"));
    expect(b.view()).toEqual({
      segments: [expect.objectContaining({ seq: 4, text: "Hello there" })],
      pending: [{ speaker: "them", text: "And when you hover over it" }],
    });
    // The turn lands: it moves from pending to the segments.
    b.observe(segment(8, "And when you hover over it, it shows"));
    expect(b.view().pending).toEqual([]);
    expect(b.view().segments.map((s) => s.seq)).toEqual([4, 8]);
  });

  it("is bounded: the newest 50 turns, a few pending, long turns clipped from the front", () => {
    const b = new LiveTranscriptBuffer();
    b.observe(state("m1"));
    for (let i = 1; i <= 120; i++) b.observe(segment(i * 4));
    const segs = b.view().segments;
    expect(segs).toHaveLength(TRANSCRIPT_LIMITS.segments);
    expect(segs[0]!.seq).toBe(71 * 4);
    expect(segs.at(-1)!.seq).toBe(120 * 4);
    for (let i = 0; i < 10; i++) b.observe(delta(`x${i}`, `turn ${i}`, i % 2 ? "me" : "them"));
    expect(b.view().pending).toHaveLength(TRANSCRIPT_LIMITS.pending);
    expect(b.view().pending.at(-1)!.text).toBe("turn 9");
    b.observe(delta("long", `${"a".repeat(5000)} the end`));
    const long = b.view().pending.at(-1)!.text;
    expect(long.length).toBe(TRANSCRIPT_LIMITS.chars);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("the end")).toBe(true);
  });

  it("ignores duplicate segments and other events, and skips empty partials", () => {
    const b = new LiveTranscriptBuffer();
    let changes = 0;
    b.on("change", () => changes++);
    b.observe(state("m1"));
    b.observe(segment(4));
    b.observe(segment(4));
    b.observe({ event: "levels", mic: 0.4, system: 0.1 });
    b.observe(delta("i1", "  "));
    expect(b.view().segments).toHaveLength(1);
    expect(b.view().pending).toEqual([]);
    expect(changes).toBe(3);
  });

  it("starts clean for a new meeting and drops everything when recording ends", () => {
    const b = new LiveTranscriptBuffer();
    b.reset("m1");
    b.observe(segment(4));
    b.observe(state("m2"));
    expect(b.value).toEqual({ meetingId: "m2", segments: [], pending: [] });
    b.observe(segment(8));
    b.reset();
    expect(b.value).toEqual({ meetingId: undefined, segments: [], pending: [] });
  });
});

describe("floating recorder: notice", () => {
  it("says when the transcript is finishing or reconnecting", () => {
    expect(pillNotice({ state: "recording", transcription: "live" })).toBeUndefined();
    expect(pillNotice({ state: "stopping" })).toMatch(/Finishing/);
    expect(pillNotice({ state: "recording", transcription: "reconnecting" })).toMatch(/Reconnecting/);
    expect(pillNotice({ state: "recording", transcription: "catching_up" })).toMatch(/Catching up/);
  });
});

describe("floating recorder: with the fake helper", () => {
  let supervisor: HelperSupervisor | undefined;
  afterEach(async () => {
    await supervisor?.stop();
    supervisor = undefined;
  });

  it("collects the turn in progress and the finished turns from a real event stream", async () => {
    supervisor = new HelperSupervisor({
      path: join(import.meta.dirname, "..", "scripts", "fake-helper.mjs"),
      freshToken: async () => "t",
      env: { FAKE_HELPER_LINE_MS: "30", FAKE_HELPER_WORD_MS: "15" },
      initialBackoffMs: 20,
    });
    const buffer = new LiveTranscriptBuffer();
    let sawPartial = false;
    supervisor.on("event", (e) => {
      buffer.observe(e);
      if (buffer.view().pending.length) sawPartial = true;
    });
    supervisor.start();
    await new Promise<void>((resolve) => supervisor!.on("status", (h) => h.status === "ready" && resolve()));
    // Nothing listens on port 9: the posts fail, which doesn't matter here.
    await supervisor.request("record.start", { meetingId: "m1", apiBase: "http://127.0.0.1:9", accessToken: "t" });
    const t0 = Date.now();
    while (buffer.view().segments.length < 2 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
    expect(buffer.value.meetingId).toBe("m1");
    expect(buffer.view().segments.length).toBeGreaterThanOrEqual(2);
    expect(sawPartial).toBe(true);
    await supervisor.request("record.stop").catch(() => {});
  }, 15_000);
});
