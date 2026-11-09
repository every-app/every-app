import { describe, expect, it } from "vitest";
import type { UseQueryResult } from "@tanstack/react-query";
import type { MeetingDetail } from "@shared/contract";
import { loadable } from "../src/renderer/src/loadable";
import { meetingForView } from "../src/renderer/src/meeting-view";
import { recordingElapsedMs } from "../src/renderer/src/recording";

const meeting = { id: "m1", title: "Saved title", status: "recording" } as unknown as MeetingDetail;
const recording = { state: "recording", meetingId: "m1", title: "Live title", startedAt: "2026-11-02T10:00:00.000Z" } as const;

describe("offline: a failed fetch never replaces a page (Codex V3, high)", () => {
  it("keeps cached data when a refetch fails", () => {
    const failedRefetch = { isPending: false, isError: true, error: new Error("fetch failed"), data: [1, 2] } as unknown as UseQueryResult<number[]>;
    expect(loadable(failedRefetch)).toEqual({ status: "ready", data: [1, 2] });
    const failedFirstLoad = { isPending: false, isError: true, error: new Error("fetch failed"), data: undefined } as unknown as UseQueryResult<number[]>;
    expect(loadable(failedFirstLoad)).toEqual({ status: "error", message: "fetch failed" });
  });

  it("draws a meeting this Mac is recording from the snapshot when nothing could be fetched", () => {
    expect(meetingForView(meeting, recording, "m1")).toBe(meeting);
    const fallback = meetingForView(undefined, recording, "m1", "ben@every.to");
    expect(fallback).toMatchObject({ id: "m1", title: "Live title", status: "recording", mine: true, startsAt: recording.startedAt, jottings: null });
    // Not recording here: nothing to draw, so the page may show its error.
    expect(meetingForView(undefined, { state: "idle" }, "m1")).toBeNull();
    expect(meetingForView(undefined, recording, "m2")).toBeNull();
  });
});

describe("one recording time for the pill and the page (Codex V3, low)", () => {
  const start = Date.parse(recording.startedAt);
  it("counts from the start, and holds at Stop while it finishes", () => {
    expect(recordingElapsedMs(recording, start + 51_000)).toBe(51_000);
    const stopping = { ...recording, state: "stopping", stoppingSince: new Date(start + 51_000).toISOString() } as const;
    expect(recordingElapsedMs(stopping, start + 90_000)).toBe(51_000);
    expect(recordingElapsedMs({ state: "idle" }, start + 1)).toBe(0);
    expect(recordingElapsedMs({ state: "starting", meetingId: "m1" }, start + 1)).toBe(0);
  });
});
