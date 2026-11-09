import { describe, expect, it } from "vitest";
import type { SelfTestReport, SelfTestSide } from "../types";
import { selfTestRows } from "./selftest";

const side = (s: Partial<SelfTestSide> = {}): SelfTestSide => ({
  status: "ok",
  peak: 0.4,
  clipping: false,
  clippedSamples: 0,
  dropouts: 0,
  ...s,
});
const report = (
  seconds: number,
  mic: Partial<SelfTestSide>,
  system: Partial<SelfTestSide>,
): SelfTestReport => ({
  seconds,
  passed: false,
  mic: side(mic),
  system: side(system),
});
const summary = (rows: ReturnType<typeof selfTestRows>) =>
  rows.map((r) => [r.label, r.device, r.tone, r.text, r.openSettings]);

describe("selfTestRows", () => {
  it("names each side by its device and says it works", () => {
    const rows = selfTestRows(
      report(
        2,
        { device: "MacBook Pro Microphone" },
        { device: "MacBook Pro Speakers" },
      ),
    );
    expect(summary(rows)).toEqual([
      ["Microphone", "MacBook Pro Microphone", "ok", "Working", undefined],
      ["Mac audio", "MacBook Pro Speakers", "ok", "Working", undefined],
    ]);
  });

  it("waits a few seconds before calling a side quiet, then offers its Settings pane", () => {
    expect(summary(selfTestRows(undefined))).toEqual([
      ["Microphone", undefined, "waiting", "Listening…", undefined],
      ["Mac audio", undefined, "waiting", "Listening…", undefined],
    ]);
    const early = report(2, { status: "silent" }, { status: "denied" });
    expect(selfTestRows(early).map((r) => r.tone)).toEqual([
      "waiting",
      "waiting",
    ]);
    const later = report(
      3,
      { status: "silent" },
      { status: "denied", device: "AirPods" },
    );
    expect(summary(selfTestRows(later))).toEqual([
      ["Microphone", undefined, "bad", "No sound", "mic"],
      ["Mac audio", "AirPods", "bad", "No sound", "systemAudio"],
    ]);
    // Stopped early: still quiet is quiet.
    expect(selfTestRows(early, true).map((r) => r.text)).toEqual([
      "No sound",
      "No sound",
    ]);
  });

  it("says at once when mic access is off; one short line for too loud or a failed start", () => {
    const rows = selfTestRows(
      report(0, { status: "denied" }, { status: "error", message: "tap failed" }),
    );
    expect(summary(rows)).toEqual([
      ["Microphone", undefined, "bad", "Access is off", "mic"],
      ["Mac audio", undefined, "bad", "Couldn't start", "systemAudio"],
    ]);
    const loud = selfTestRows(report(5, { clipping: true, dropouts: 3 }, { dropouts: 2 }));
    // Dropouts aren't shown: noise for a person.
    expect(loud.map((r) => [r.tone, r.text])).toEqual([
      ["warn", "Working, but too loud"],
      ["ok", "Working"],
    ]);
  });
});
