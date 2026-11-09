import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { HelperSupervisor } from "../src/main/helper/supervisor";
import { RecordingController } from "../src/main/recording";
import { AuthService } from "../src/main/auth/service";
import { parseHelperLine, type HelperEvent } from "@shared/protocol";
import type { HelperSnapshot } from "@shared/ipc";
import { FakeServer } from "./fakeServer";
import { tempStore } from "./helpers";

const FAKE = join(import.meta.dirname, "..", "scripts", "fake-helper.mjs");
let supervisors: HelperSupervisor[] = [];
let fake: FakeServer;

beforeEach(async () => {
  fake = await new FakeServer().start();
});
afterEach(async () => {
  await Promise.all(supervisors.map((s) => s.stop()));
  supervisors = [];
  await fake.stop();
});

function make(env: Record<string, string> = {}, opts: Partial<ConstructorParameters<typeof HelperSupervisor>[0]> = {}) {
  const logs: string[] = [];
  const s = new HelperSupervisor({
    path: FAKE,
    freshToken: async () => "fresh_token",
    env: { FAKE_HELPER_LINE_MS: "50", ...env },
    initialBackoffMs: 20,
    log: (l) => logs.push(l),
    ...opts,
  });
  supervisors.push(s);
  return { s, logs };
}

const until = <T>(f: () => T | undefined, ms = 4000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = f();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });

const ready = (s: HelperSupervisor) => until(() => (s.state.status === "ready" && s.state.permissions ? s.state : undefined));

describe("protocol lines", () => {
  it("tells responses from events and drops junk", () => {
    expect(parseHelperLine('{"id":1,"ok":true,"result":{}}')).toEqual({ kind: "response", response: { id: 1, ok: true, result: {} } });
    expect(parseHelperLine('{"event":"levels","mic":0.1,"system":0}')).toMatchObject({ kind: "event", event: { event: "levels" } });
    expect(parseHelperLine("not json")).toBeNull();
    expect(parseHelperLine("[1]")).toBeNull();
    expect(parseHelperLine("")).toBeNull();
  });
});

describe("helper supervisor", () => {
  it("says hello with protocol 1 and reads permissions", async () => {
    const { s } = make();
    s.start();
    const state = await ready(s);
    expect(state).toMatchObject({ status: "ready", version: "0.0.0-fake", permissions: { mic: "granted", systemAudio: "unknown" } });
  });

  it("returns errors as HelperRequestError with the helper's code", async () => {
    const { s } = make();
    s.start();
    await ready(s);
    await expect(s.request("record.start", { meetingId: "", apiBase: "", accessToken: "" })).rejects.toMatchObject({ code: "bad_params" });
  });

  it("answers token.needed with token.update carrying a fresh token", async () => {
    const { s } = make({ FAKE_HELPER_TOKEN_NEEDED_MS: "30", FAKE_HELPER_NO_POST: "1" });
    const tokens: number[] = [];
    s.start();
    await ready(s);
    const req = s.request.bind(s);
    s.request = ((cmd: never, params: never) => {
      if (cmd === "token.update") tokens.push(1);
      return req(cmd, params);
    }) as typeof s.request;
    await s.request("record.start", { meetingId: "m1", apiBase: fake.origin, accessToken: "old" });
    await until(() => tokens.length >= 2);
    await s.request("record.stop");
  });

  it("restarts a crashed helper with growing backoff", async () => {
    const { s } = make({ FAKE_HELPER_CRASH_AFTER_MS: "80" });
    const statuses: HelperSnapshot["status"][] = [];
    s.on("status", (st) => statuses.push(st.status));
    const exits: unknown[] = [];
    s.on("exit", (e) => exits.push(e));
    s.start();
    await until(() => (s.state.restarts >= 2 ? true : undefined));
    expect(statuses).toContain("restarting");
    expect(exits[0]).toMatchObject({ code: 3, wasRecording: false });
  });

  it("re-sends call detection after a restart and forwards call events", async () => {
    const { s } = make({ FAKE_HELPER_CALL_AFTER_MS: "40" });
    const events: HelperEvent[] = [];
    s.on("event", (e) => events.push(e));
    s.start();
    await ready(s);
    await s.setDetection(true);
    await until(() => events.find((e) => e.event === "call.started"));
    expect(events.find((e) => e.event === "call.started")).toEqual({ event: "call.started", bundleId: "us.zoom.xos", appName: "zoom.us" });
  });

  it("refuses a helper that speaks another protocol, without restarting", async () => {
    const { s } = make({ FAKE_HELPER_PROTOCOL: "2" });
    s.start();
    const state = await until(() => (s.state.status === "unavailable" ? s.state : undefined));
    expect(state.lastError).toMatch(/protocol 2/);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.state.restarts).toBe(0);
  });

  it("reports a missing helper as unavailable", async () => {
    const { s } = make({}, { path: "/nonexistent/everyapp-helper" });
    s.start();
    const state = await until(() => (s.state.status === "unavailable" ? s.state : undefined));
    expect(state.lastError).toMatch(/isn't installed/);
  });
});

describe("recording against the fake helper and fake server", () => {
  it("creates the meeting, records, posts segments and finishes", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make();
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await recording.start({ title: "Sync", calendarEventId: "ev1" });
    expect(recording.state).toMatchObject({ state: "recording", title: "Sync", calendarEventId: "ev1" });
    const meetingId = recording.state.meetingId!;
    await until(() => recording.state.lastLine);
    await recording.stop();
    expect(recording.state.state).toBe("idle");
    expect(fake.meetings[0]).toMatchObject({ id: meetingId, title: "Sync", calendarEventId: "ev1", status: "done" });
    expect((fake.segments.get(meetingId) ?? []).length).toBeGreaterThan(0);
    const post = fake.requests.find((r) => r.path.endsWith("/segments"))!;
    expect(post.headers.authorization).toBe("Bearer epat_good");
  });

  it("refuses to start when the mic is denied, and finishes nothing", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_MIC: "denied" });
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await expect(recording.start({ title: "x" })).rejects.toThrow(/Microphone access is off/);
    expect(fake.meetings).toEqual([]);
    expect(recording.state.state).toBe("idle");
  });

  it("hands what a stop couldn't save to main, to replay later", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_STOP_UNSAVED: "1", FAKE_HELPER_LINE_MS: "40" });
    const recording = new RecordingController(auth, s);
    const handed: { meetingId: string; segments: unknown[]; needsFinish: boolean; appUrl: string }[] = [];
    recording.on("unsaved", (u) => handed.push(u));
    s.start();
    await ready(s);
    await recording.start({ title: "Offline stop" });
    await until(() => recording.state.lastLine);
    const meetingId = recording.state.meetingId!;
    await recording.stop();
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ meetingId, appUrl: fake.origin, needsFinish: true });
    expect(handed[0]!.segments.length).toBeGreaterThan(0);
    expect(recording.state).toEqual({ state: "idle" });
  });

  it("doesn't show save failures as an error while they're expected (offline, expired)", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make();
    const recording = new RecordingController(auth, s);
    let expected = true;
    recording.saveFailuresExpected = () => expected;
    s.start();
    await ready(s);
    await recording.start({ title: "Flaky" });
    const emit = (message: string) => s.request("debug.emit" as never, { event: "error", code: "save_failed", message, fatal: false } as never);
    await emit("offline");
    await new Promise((r) => setTimeout(r, 50));
    expect(recording.state.error).toBeUndefined();
    expected = false;
    await emit("server said no");
    await until(() => recording.state.error);
    expect(recording.state.error).toBe("server said no");
    await recording.stop();
  });

  it("deletes the meeting when the start fails", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_START_ERROR: "capture_failed" });
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await expect(recording.start({ title: "Broken" })).rejects.toThrow(/told to fail/);
    expect(recording.state).toMatchObject({ state: "idle", error: expect.stringMatching(/told to fail/) });
    await until(() => (fake.deleted.length ? true : undefined));
    expect(fake.meetings).toEqual([]);
    expect(fake.finished).toEqual([]);
  });

  it("treats a stop during start as cancelled: no error, no /finish", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_START_DELAY_MS: "1000" });
    const logs: string[] = [];
    const recording = new RecordingController(auth, s, (...p) => logs.push(p.join(" ")));
    s.start();
    await ready(s);
    const starting = recording.start({ title: "Quick" });
    await until(() => (recording.state.meetingId && fake.requests.some((r) => r.path.endsWith("/meetings")) ? true : undefined));
    await new Promise((r) => setTimeout(r, 100));
    await recording.stop();
    await expect(starting).resolves.toBeUndefined();
    expect(recording.state).toEqual({ state: "idle" });
    expect(logs.join("\n")).toMatch(/cancelled/);
    await until(() => (fake.deleted.length ? true : undefined));
    expect(fake.finished).toEqual([]);
    expect(fake.meetings).toEqual([]);
    expect(s.state.status).toBe("ready");
  });

  it("follows the helper's transcription state, including catching up after an outage", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make();
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await recording.start({ title: "Flaky Wi-Fi" });
    const state = (transcription: string) =>
      s.request("debug.emit" as never, { event: "state", recording: true, mode: "realtime", mic: "ok", system: "ok", transcription } as never);
    for (const t of ["reconnecting", "catching_up", "live"]) {
      await state(t);
      await until(() => recording.state.transcription === t || undefined);
    }
    await recording.stop();
  });

  it("says it's stopping, since when, for a stop that takes a while, and clears it after", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_STOP_DELAY_MS: "400" });
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await recording.start({ title: "Long stop" });
    const before = Date.now();
    const stopping = recording.stop();
    expect(recording.state).toMatchObject({ state: "stopping", stopping: true, stoppingSince: expect.any(String) });
    expect(Date.parse(recording.state.stoppingSince!)).toBeGreaterThanOrEqual(before - 5);
    await stopping;
    expect(recording.state.stopping).toBeUndefined();
    expect(recording.state.stoppingSince).toBeUndefined();
    expect(recording.state.state).toBe("idle");
  });

  it("keeps the turn still being spoken on stop: its text so far, posted before /finish, counted", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    // The first line starts after 1.5 s and its words arrive 300 ms apart, so it's open from 1.5
    // to 2.7 s, and no second line starts before the stop.
    const { s, logs } = make({ FAKE_HELPER_LINE_MS: "1500", FAKE_HELPER_WORD_MS: "300" });
    const events: HelperEvent[] = [];
    s.on("event", (e) => events.push(e));
    const recording = new RecordingController(auth, s, (...p) => logs.push(p.join(" ")));
    s.start();
    await ready(s);
    await recording.start({ title: "Cut mid-sentence" });
    const meetingId = recording.state.meetingId!;
    await until(() => events.some((e) => e.event === "transcript.delta" && e.text.split(" ").length >= 2) || undefined);
    expect(events.some((e) => e.event === "transcript.segment")).toBe(false); // the turn is still open
    await recording.stop();
    const lastDelta = events.filter((e): e is Extract<HelperEvent, { event: "transcript.delta" }> => e.event === "transcript.delta").at(-1)!;
    const segments = events.filter((e): e is Extract<HelperEvent, { event: "transcript.segment" }> => e.event === "transcript.segment");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe(lastDelta.text); // the text so far, not the whole scripted line
    expect(segments[0]!.text).not.toBe("Thanks everyone for joining.");
    // Posted, then /finish, and counted in the stop's result.
    expect((fake.segments.get(meetingId) ?? []).map((x) => (x as { text: string }).text)).toEqual([lastDelta.text]);
    const paths = fake.requests.map((r) => r.path);
    expect(paths.lastIndexOf(`/api/v1/meetings/${meetingId}/finish`)).toBeGreaterThan(paths.lastIndexOf(`/api/v1/meetings/${meetingId}/segments`));
    expect(logs.join("\n")).toMatch(/stopped; 1 segments/);
  });

  it("a turn with no words yet leaves nothing behind on stop", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_LINE_MS: "60000" });
    const events: HelperEvent[] = [];
    s.on("event", (e) => events.push(e));
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await recording.start({ title: "Silent" });
    await recording.stop();
    expect(events.some((e) => e.event === "transcript.segment")).toBe(false);
  });

  it("surfaces fallback_backlog as a warning and keeps recording", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make();
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    await recording.start({ title: "Slow network" });
    await s.request("debug.emit" as never, { event: "error", code: "fallback_backlog", message: "Dropped 40 s of audio.", fatal: false } as never);
    await until(() => recording.state.warning);
    expect(recording.state).toMatchObject({ state: "recording", warning: "Dropped 40 s of audio." });
    expect(recording.state.error).toBeUndefined();
    await recording.stop();
    expect(recording.state.warning).toBeUndefined();
  });

  it("finishes the meeting when the helper crashes mid-recording", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {} });
    await auth.signInWithToken(fake.origin, "epat_good");
    const { s } = make({ FAKE_HELPER_CRASH_AFTER_MS: "400" });
    const recording = new RecordingController(auth, s);
    s.start();
    await ready(s);
    const crashes: unknown[] = [];
    recording.on("crashed", (c) => crashes.push(c));
    await recording.start({ title: "Crashy" });
    const meetingId = recording.state.meetingId;
    await until(() => (recording.state.state === "idle" ? recording.state : undefined));
    expect(recording.state.error).toMatch(/stopped unexpectedly/);
    expect(crashes).toEqual([{ meetingId }]);
    expect(recording.crashCount).toBe(1);
    await until(() => (fake.finished.length ? true : undefined));
    expect(fake.finished).toEqual([meetingId]);
    // The helper comes back on its own, idle, with the crash counted.
    await until(() => (s.state.status === "ready" && s.state.crashes >= 1 ? true : undefined));
    expect(s.state.restarts).toBeGreaterThanOrEqual(1);
    expect(s.isRecording).toBe(false);
  });
});
