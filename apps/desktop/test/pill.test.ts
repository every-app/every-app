import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperSupervisor } from "../src/main/helper/supervisor";
import type { HelperEvent } from "@shared/protocol";
import { LiveTranscriptBuffer, TRANSCRIPT_LIMITS } from "../src/main/liveTranscript";
import {
  clampPill,
  GAP,
  HoverTracker,
  INSET,
  LIFT,
  MARGIN,
  PANEL,
  PILL,
  pillLayout,
  pillPlaceFor,
  PillPlacesStore,
  readPillPlaces,
  shouldShowPill,
  snapPill,
  takesMouse,
  withPillPlace,
  zoneAt,
  type PillLayout,
} from "../src/main/pill";
import { isDrag } from "../ui/src/lib/drag";
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

  it("takes a point to start a drag and nothing to end it", () => {
    expect(validArgs("pill:dragStart", [{ x: 310, y: 260 }])).toBe(true);
    expect(validArgs("pill:dragStart", [])).toBe(false);
    expect(validArgs("pill:dragStart", [null])).toBe(false);
    expect(validArgs("pill:dragStart", [{ x: "310", y: 260 }])).toBe(false);
    expect(validArgs("pill:dragStart", [{ x: Number.NaN, y: 0 }])).toBe(false);
    expect(validArgs("pill:dragEnd", [])).toBe(true);
    expect(validArgs("pill:dragEnd", [1])).toBe(false);
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

describe("floating recorder: where it was dragged to", () => {
  const workArea = { x: 0, y: 25, width: 1512, height: 920 };
  const onScreen = (l: PillLayout) => ({
    pill: { ...l.pill, x: l.window.x + l.pill.x, y: l.window.y + l.pill.y },
    panel: { ...l.panel, x: l.window.x + l.panel.x, y: l.window.y + l.panel.y },
  });
  const within = (r: { x: number; y: number; width: number; height: number }, area: typeof workArea) =>
    r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;

  it("a small move is still a click", () => {
    expect(isDrag({ x: 100, y: 100 }, { x: 102, y: 101 })).toBe(false);
    expect(isDrag({ x: 100, y: 100 }, { x: 100, y: 104 })).toBe(true);
    expect(isDrag({ x: 100, y: 100 }, { x: 97, y: 97 })).toBe(true);
  });

  it("keeps the pill inside the work area while it's dragged", () => {
    expect(clampPill({ x: 700, y: 400 }, workArea)).toEqual({ x: 700, y: 400 });
    expect(clampPill({ x: -500, y: -500 }, workArea)).toEqual({ x: MARGIN, y: workArea.y + MARGIN });
    expect(clampPill({ x: 9000, y: 9000 }, workArea)).toEqual({
      x: workArea.width - MARGIN - PILL.width,
      y: workArea.y + workArea.height - MARGIN - PILL.height,
    });
  });

  it("settles on the nearer side edge, at the height it was dropped", () => {
    expect(snapPill({ x: 300, y: 400 }, workArea).edge).toBe("left");
    expect(snapPill({ x: 1000, y: 400 }, workArea).edge).toBe("right");
    expect(snapPill({ x: 300, y: workArea.y + MARGIN }, workArea).y).toBe(0);
    expect(snapPill({ x: 300, y: 5000 }, workArea).y).toBe(1);
    for (const drop of [{ x: 300, y: 400 }, { x: 1200, y: 77 }, { x: 40, y: 860 }]) {
      const l = onScreen(pillLayout(workArea, snapPill(drop, workArea)));
      expect(l.pill.y).toBe(drop.y);
      expect(l.pill.x).toBe(drop.x < 756 ? MARGIN : workArea.width - MARGIN - PILL.width);
    }
  });

  it("opens the panel on the side with room, and keeps it on screen at any height", () => {
    for (const edge of ["left", "right"] as const) {
      for (const y of [0, 0.25, 0.5, 0.9, 1]) {
        const layout = pillLayout(workArea, { edge, y });
        const l = onScreen(layout);
        expect(layout.panelSide).toBe(edge === "left" ? "right" : "left");
        expect(within(l.pill, workArea)).toBe(true);
        expect(within(l.panel, workArea)).toBe(true);
        expect(l.panel).toMatchObject({ width: PANEL.width, height: PANEL.height });
        // Beside the pill, GAP apart, on its inner side.
        if (edge === "left") expect(l.panel.x).toBe(l.pill.x + PILL.width + GAP);
        else expect(l.panel.x + l.panel.width + GAP).toBe(l.pill.x);
        // The window covers both, with INSET around.
        expect(layout.window.x).toBe(Math.min(l.pill.x, l.panel.x) - INSET);
        expect(layout.window.y).toBe(Math.min(l.pill.y, l.panel.y) - INSET);
        expect(layout.window.x + layout.window.width).toBe(Math.max(l.pill.x + PILL.width, l.panel.x + PANEL.width) + INSET);
        expect(layout.window.y + layout.window.height).toBe(Math.max(l.pill.y + PILL.height, l.panel.y + PANEL.height) + INSET);
      }
    }
    // Mid-screen the panel's bottom is LIFT below the pill's; at the top it hangs down instead.
    const mid = onScreen(pillLayout(workArea, { edge: "left", y: 0.5 }));
    expect(mid.panel.y + mid.panel.height).toBe(mid.pill.y + PILL.height + LIFT);
    const top = onScreen(pillLayout(workArea, { edge: "left", y: 0 }));
    expect(top.panel.y).toBe(top.pill.y);
    const bottom = onScreen(pillLayout(workArea, { edge: "right", y: 1 }));
    expect(bottom.panel.y + bottom.panel.height).toBe(workArea.y + workArea.height - MARGIN);
  });

  it("counts the gap as the panel on whichever side the panel is", () => {
    const l = pillLayout(workArea, { edge: "left", y: 0.5 });
    const screenPoint = (x: number, y: number) => ({ x: l.window.x + x, y: l.window.y + y });
    expect(zoneAt(screenPoint(l.pill.x + 5, l.pill.y + 5), l)).toBe("pill");
    expect(zoneAt(screenPoint(l.pill.x + PILL.width + 2, l.pill.y + 5), l)).toBe("panel");
    expect(zoneAt(screenPoint(l.panel.x + l.panel.width + 2, l.panel.y + 5), l)).toBeNull();
  });

  it("stays on screen when the display gets smaller", () => {
    const position = snapPill({ x: 20, y: 900 }, workArea);
    const small = { x: 0, y: 25, width: 1024, height: 500 };
    expect(within(onScreen(pillLayout(small, position)).pill, small)).toBe(true);
    // A stored fraction outside 0–1 can't put it off screen either.
    expect(within(onScreen(pillLayout(small, { edge: "left", y: 7 })).pill, small)).toBe(true);
  });

  it("remembers a spot per display, and opens on the display it was last dragged on", () => {
    let places = withPillPlace({ displays: {} }, "1", { edge: "left", y: 0.5 });
    places = withPillPlace(places, "2", { edge: "right", y: 0.1 });
    expect(places).toEqual({ last: "2", displays: { "1": { edge: "left", y: 0.5 }, "2": { edge: "right", y: 0.1 } } });
    expect(pillPlaceFor(places, ["1", "2"], "1")).toEqual({ display: "2", position: { edge: "right", y: 0.1 } });
    // That display is unplugged: the one under the cursor, at its own remembered spot.
    expect(pillPlaceFor(places, ["1"], "1")).toEqual({ display: "1", position: { edge: "left", y: 0.5 } });
    // A display it was never dragged on: the corner.
    expect(pillPlaceFor(places, ["3"], "3")).toEqual({ display: "3", position: undefined });
    expect(pillPlaceFor({ displays: {} }, ["1", "2"], "1")).toEqual({ display: "1", position: undefined });
    // Bounded: the oldest display goes.
    for (let i = 10; i < 40; i++) places = withPillPlace(places, String(i), { edge: "left", y: 0 });
    expect(Object.keys(places.displays)).toHaveLength(16);
    expect(places.displays["1"]).toBeUndefined();
    expect(places.last).toBe("39");
  });

  it("reads the stored file leniently", () => {
    expect(readPillPlaces(undefined)).toEqual({ displays: {} });
    expect(readPillPlaces("nope")).toEqual({ displays: {} });
    expect(
      readPillPlaces({
        last: "1",
        displays: { "1": { edge: "left", y: 0.4, extra: 1 }, "2": { edge: "up", y: 0.4 }, "3": { edge: "right", y: 2 }, "4": { edge: "right", y: "0" }, __proto__x: { edge: "left", y: 0 }, "5": null },
      }),
    ).toEqual({ last: "1", displays: { "1": { edge: "left", y: 0.4 } } });
    // `last` only counts with a spot for it.
    expect(readPillPlaces({ last: "9", displays: { "1": { edge: "left", y: 0 } } })).toEqual({ displays: { "1": { edge: "left", y: 0 } } });
  });

  it("keeps the spot across restarts, and goes back to the corner when the file is gone or broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "pill-places-"));
    try {
      const path = join(dir, "nested", "recorder-position.json");
      const store = new PillPlacesStore(path);
      expect(store.value).toEqual({ displays: {} });
      store.set(withPillPlace(store.value, "1", { edge: "left", y: 0.25 }));
      expect(new PillPlacesStore(path).value).toEqual({ last: "1", displays: { "1": { edge: "left", y: 0.25 } } });
      writeFileSync(path, "{not json");
      const lines: string[] = [];
      expect(new PillPlacesStore(path, (l) => lines.push(l)).value).toEqual({ displays: {} });
      expect(lines).toHaveLength(1);
      // Reset: nothing remembered.
      store.set({ displays: {} });
      expect(new PillPlacesStore(path).value).toEqual({ displays: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
