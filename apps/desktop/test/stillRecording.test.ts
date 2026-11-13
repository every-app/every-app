import { describe, expect, it } from "vitest";
import type { RecordingSnapshot } from "@shared/ipc";
import type { HelperEvent } from "@shared/protocol";
import { promptFor, scaled, STILL_RECORDING as C, StillRecordingGuard, StillRecordingWatch, STOPPED_NOTICE, type StillPrompt } from "../src/main/stillRecording";
import { parseSettingsPatch, readSettings } from "../src/main/settings";

const MIN = 60_000;
const T0 = Date.parse("2026-11-13T15:00:00.000Z");

/** The other side talks from `from` for `ms` (levels ten times a second). */
function talk(watch: StillRecordingWatch, from: number, ms = 5_000): number {
  for (let t = from; t < from + ms; t += 100) watch.sound(t, 0.3);
  return from + ms;
}

describe("Still recording? — when to ask", () => {
  it("asks once the other side, heard earlier, has been quiet for 5 minutes", () => {
    const watch = new StillRecordingWatch(T0, new Set());
    const heard = talk(watch, T0);
    // People go on talking in the room: the microphone's side doesn't matter.
    for (let t = heard; t < heard + 6 * MIN; t += 30_000) watch.speech(t);
    expect(watch.tick(heard + C.quietMs - 10_000)).toBeUndefined();
    const action = watch.tick(heard + C.quietMs);
    expect(action).toMatchObject({ do: "ask", asked: { reason: "quiet", stopAt: heard + C.quietMs + C.answerMs } });
  });

  it("doesn't take a recording with no other side (a meeting in the room) for a quiet one", () => {
    const watch = new StillRecordingWatch(T0, new Set());
    for (let t = T0; t <= T0 + 30 * MIN; t += 30_000) {
      watch.speech(t);
      expect(watch.tick(t)).toBeUndefined();
    }
  });

  it("doesn't count a ding as the other side", () => {
    const watch = new StillRecordingWatch(T0, new Set());
    const heard = talk(watch, T0);
    for (let t = heard; t < heard + 6 * MIN; t += 30_000) watch.speech(t);
    // A one-second message sound every minute.
    for (let m = 1; m <= 4; m++) talk(watch, heard + m * MIN, 1_000);
    expect(watch.tick(heard + C.quietMs)).toMatchObject({ do: "ask", asked: { reason: "quiet" } });
  });

  it("ignores hiss on the system channel", () => {
    const watch = new StillRecordingWatch(T0, new Set());
    for (let t = T0; t < T0 + 20_000; t += 100) watch.sound(t, 0.05);
    watch.speech(T0 + C.quietMs);
    expect(watch.tick(T0 + C.quietMs + MIN)).toBeUndefined();
  });

  it("asks 2 minutes after the call app let go of the microphone, naming it", () => {
    const calls = new Set(["us.zoom.xos"]);
    const watch = new StillRecordingWatch(T0, calls);
    const heard = talk(watch, T0);
    calls.clear();
    watch.callEndedAt(heard + 1_000, "Zoom");
    watch.speech(heard + C.quietAfterEndMs);
    expect(watch.tick(heard + C.quietAfterEndMs - 5_000)).toBeUndefined();
    const action = watch.tick(heard + C.quietAfterEndMs);
    expect(action).toMatchObject({ do: "ask", asked: { reason: "call_ended", appName: "Zoom" } });
  });

  it("goes back to 5 minutes when sound returns after the call app left (another call)", () => {
    const calls = new Set(["us.zoom.xos"]);
    const watch = new StillRecordingWatch(T0, calls);
    const heard = talk(watch, T0);
    calls.clear();
    watch.callEndedAt(heard, "Zoom");
    const again = talk(watch, heard + MIN);
    watch.speech(again + C.quietAfterEndMs);
    expect(watch.tick(again + C.quietAfterEndMs)).toBeUndefined();
    watch.speech(again + C.quietMs);
    expect(watch.tick(again + C.quietMs)).toMatchObject({ do: "ask", asked: { reason: "quiet" } });
  });

  it("never asks while a call app holds the microphone", () => {
    const watch = new StillRecordingWatch(T0, new Set(["us.zoom.xos"]), T0 + 30 * MIN);
    talk(watch, T0);
    // Presenting to a muted room, past the meeting's end, then a long silence.
    expect(watch.tick(T0 + 20 * MIN)).toBeUndefined();
    expect(watch.tick(T0 + 60 * MIN)).toBeUndefined();
  });

  it("asks 5 minutes after the calendar meeting's end, once the other side has been quiet for 2", () => {
    const end = T0 + 30 * MIN;
    const watch = new StillRecordingWatch(T0, new Set(), end);
    // The meeting runs over: they are still talking at the mark.
    for (let t = T0; t < end + C.afterCalendarEndMs + MIN; t += 20_000) {
      talk(watch, t);
      watch.speech(t);
      expect(watch.tick(t)).toBeUndefined();
    }
    const last = end + C.afterCalendarEndMs + MIN;
    watch.speech(last + C.quietAfterEndMs);
    expect(watch.tick(last + C.quietAfterEndMs - 30_000)).toBeUndefined();
    expect(watch.tick(last + C.quietAfterEndMs + 5_000)).toMatchObject({ do: "ask", asked: { reason: "meeting_over" } });
  });

  it("asks at the calendar end plus 5 minutes for a meeting in the room", () => {
    const end = T0 + 30 * MIN;
    const watch = new StillRecordingWatch(T0, new Set(), end);
    for (let t = T0; t < end + C.afterCalendarEndMs; t += 30_000) {
      watch.speech(t);
      expect(watch.tick(t)).toBeUndefined();
    }
    watch.speech(end + C.afterCalendarEndMs);
    expect(watch.tick(end + C.afterCalendarEndMs)).toMatchObject({ do: "ask", asked: { reason: "meeting_over" } });
  });

  it("asks after 10 minutes with nobody speaking, but not while transcription is down", () => {
    const watch = new StillRecordingWatch(T0, new Set());
    watch.speech(T0 + MIN);
    expect(watch.tick(T0 + MIN + C.noSpeechMs - 1_000)).toBeUndefined();
    expect(watch.tick(T0 + MIN + C.noSpeechMs)).toMatchObject({ do: "ask", asked: { reason: "no_speech" } });

    const down = new StillRecordingWatch(T0, new Set());
    down.transcription(T0 + MIN, false);
    expect(down.tick(T0 + 20 * MIN)).toBeUndefined();
    // Back: the count starts over.
    down.transcription(T0 + 20 * MIN, true);
    expect(down.tick(T0 + 25 * MIN)).toBeUndefined();
    expect(down.tick(T0 + 20 * MIN + C.noSpeechMs)).toMatchObject({ do: "ask", asked: { reason: "no_speech" } });
  });

  it("doesn't read a failed system audio tap as quiet", () => {
    const watch = new StillRecordingWatch(T0, new Set());
    const heard = talk(watch, T0);
    watch.systemAudio(true);
    watch.speech(heard + C.quietMs);
    expect(watch.tick(heard + C.quietMs)).toBeUndefined();
  });
});

describe("Still recording? — after asking", () => {
  const asked = () => {
    const watch = new StillRecordingWatch(T0, new Set());
    const heard = talk(watch, T0);
    const at = heard + C.quietMs;
    watch.speech(at);
    expect(watch.tick(at)).toMatchObject({ do: "ask" });
    return { watch, at };
  };

  it("stops when nobody answers for 3 minutes, and not before", () => {
    const { watch, at } = asked();
    expect(watch.tick(at + C.answerMs - 5_000)).toBeUndefined();
    expect(watch.tick(at + C.answerMs)).toMatchObject({ do: "stop", asked: { reason: "quiet" } });
  });

  it("Keep recording: quiet for 30 minutes, then 60, then 120 at most", () => {
    const { watch, at } = asked();
    let t = at + 10_000;
    for (const snooze of [30 * MIN, 60 * MIN, 120 * MIN, 120 * MIN]) {
      watch.keep(t);
      watch.speech(t + snooze - 5_000);
      expect(watch.tick(t + snooze - 5_000)).toBeUndefined();
      expect(watch.tick(t + snooze)).toMatchObject({ do: "ask", asked: { reason: "quiet" } });
      t += snooze + 10_000;
    }
  });

  it("takes the question back when the other side is heard again, and asks afresh later", () => {
    const { watch, at } = asked();
    const heard = talk(watch, at + 30_000);
    expect(watch.tick(heard)).toEqual({ do: "withdraw" });
    expect(watch.tick(at + C.answerMs)).toBeUndefined();
    watch.speech(heard + C.quietMs);
    expect(watch.tick(heard + C.quietMs)).toMatchObject({ do: "ask", asked: { reason: "quiet" } });
  });

  it("doesn't take its own alert sound for the other side", () => {
    const { watch, at } = asked();
    talk(watch, at, 4_000);
    expect(watch.tick(at + 5_000)).toBeUndefined();
    expect(watch.tick(at + C.answerMs)).toMatchObject({ do: "stop" });
  });

  it("takes the question back when a call app takes the microphone", () => {
    const calls = new Set<string>();
    const watch = new StillRecordingWatch(T0, calls);
    expect(watch.tick(T0 + C.noSpeechMs)).toMatchObject({ do: "ask", asked: { reason: "no_speech" } });
    calls.add("us.zoom.xos");
    expect(watch.tick(T0 + C.noSpeechMs + 5_000)).toEqual({ do: "withdraw" });
  });

  it("takes back “the meeting is over” when the meeting is extended, and “nobody has spoken” when someone does", () => {
    const end = T0 + 30 * MIN;
    const watch = new StillRecordingWatch(T0, new Set(), end);
    const at = end + C.afterCalendarEndMs;
    watch.speech(at);
    expect(watch.tick(at)).toMatchObject({ do: "ask", asked: { reason: "meeting_over" } });
    watch.calendarEnd = end + 30 * MIN;
    expect(watch.tick(at + 5_000)).toEqual({ do: "withdraw" });

    const silent = new StillRecordingWatch(T0, new Set());
    expect(silent.tick(T0 + C.noSpeechMs)).toMatchObject({ do: "ask", asked: { reason: "no_speech" } });
    silent.speech(T0 + C.noSpeechMs + 20_000);
    expect(silent.tick(T0 + C.noSpeechMs + 25_000)).toEqual({ do: "withdraw" });
  });
});

describe("Still recording? — the words", () => {
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const at = T0 + 40 * MIN;
  const ask = (reason: "call_ended" | "meeting_over" | "quiet" | "no_speech", appName?: string) =>
    promptFor({ reason, at, stopAt: at + C.answerMs, appName }, T0 + 30 * MIN, time);

  it("says why and when it stops", () => {
    expect(ask("quiet")).toEqual({
      title: "Still recording?",
      body: "Nothing from the other side for 5 minutes. Scribe stops at 15:43 unless you keep recording.",
      actions: ["Keep recording", "Stop now"],
    });
    expect(ask("call_ended", "Zoom").body).toBe("Zoom let go of the microphone. Scribe stops at 15:43 unless you keep recording.");
    expect(ask("meeting_over").body).toBe("This meeting was due to end at 15:30. Scribe stops at 15:43 unless you keep recording.");
    expect(ask("no_speech").body).toBe("Nobody has spoken for 10 minutes. Scribe stops at 15:43 unless you keep recording.");
  });

  it("scales every wait for dev builds, and leaves them alone otherwise", () => {
    expect(scaled(C, 10)).toMatchObject({ quietMs: 30_000, answerMs: 18_000, snoozeMs: 3 * MIN });
    expect(scaled(C, Number(undefined))).toBe(C);
    expect(scaled(C, 1)).toBe(C);
  });
});

describe("Still recording? — following the recording", () => {
  const recordingOf = (meetingId: string): RecordingSnapshot => ({ state: "recording", meetingId, title: "Acme renewal" });
  const levels = (system: number): HelperEvent => ({ event: "levels", mic: 0.3, system });

  function setup(enabled = true) {
    const seen = { now: T0, asks: [] as { prompt: StillPrompt; answer: (index: number) => void }[], dismissed: 0, stops: 0, notices: [] as string[], enabled };
    const guard = new StillRecordingGuard({
      enabled: () => seen.enabled,
      now: () => seen.now,
      ask: (prompt, answer) => seen.asks.push({ prompt, answer }),
      dismiss: () => seen.dismissed++,
      notify: (title) => seen.notices.push(title),
      stop: () => seen.stops++,
      time: (ms) => new Date(ms).toISOString().slice(11, 16),
      log: () => {},
    });
    /** The other side talks for 5 s, then `quietMs` of quiet, ticking as main does. */
    const talkThenQuiet = (quietMs: number) => {
      for (let i = 0; i < 50; i++) {
        seen.now += 100;
        guard.helperEvent(levels(0.3));
      }
      const until = seen.now + quietMs;
      while (seen.now < until) {
        seen.now += 5_000;
        guard.helperEvent(levels(0));
        guard.helperEvent({ event: "transcript.delta", speaker: "me", text: "and", itemId: "i" });
        guard.tick();
      }
    };
    return { guard, seen, talkThenQuiet };
  }

  it("asks, and stops the recording the normal way when nobody answers", () => {
    const { guard, seen, talkThenQuiet } = setup();
    guard.recordingChanged(recordingOf("m1"));
    talkThenQuiet(C.quietMs);
    expect(seen.asks).toHaveLength(1);
    expect(seen.asks[0]!.prompt.title).toBe("Still recording?");
    expect(seen.stops).toBe(0);
    talkThenQuietOnly(guard, seen, C.answerMs);
    expect(seen.stops).toBe(1);
    expect(seen.notices).toEqual([STOPPED_NOTICE.title]);
    // The stop makes the recording idle; nothing more happens.
    guard.recordingChanged({ state: "idle" });
    seen.now += 60 * MIN;
    guard.tick();
    expect(seen.stops).toBe(1);
  });

  it("Keep recording keeps it, Stop now stops it, and a late answer to an old question does nothing", () => {
    const { guard, seen, talkThenQuiet } = setup();
    guard.recordingChanged(recordingOf("m1"));
    talkThenQuiet(C.quietMs);
    seen.asks[0]!.answer(0);
    talkThenQuietOnly(guard, seen, C.answerMs + MIN);
    expect(seen.stops).toBe(0);
    expect(seen.asks).toHaveLength(1);
    // Asked again after the 30 minutes: Stop now.
    talkThenQuietOnly(guard, seen, C.snoozeMs - C.answerMs - MIN + 10_000);
    expect(seen.asks).toHaveLength(2);
    seen.asks[0]!.answer(1);
    expect(seen.stops).toBe(0);
    seen.asks[1]!.answer(1);
    expect(seen.stops).toBe(1);
    expect(seen.notices).toEqual([]);
  });

  it("takes the question down when the recording is stopped by hand", () => {
    const { guard, seen, talkThenQuiet } = setup();
    guard.recordingChanged(recordingOf("m1"));
    talkThenQuiet(C.quietMs);
    expect(guard.asking).toBe(true);
    guard.recordingChanged({ state: "stopping", meetingId: "m1", title: "Acme renewal" });
    expect(seen.dismissed).toBe(1);
    expect(guard.asking).toBe(false);
    seen.now += C.answerMs;
    guard.tick();
    expect(seen.stops).toBe(0);
  });

  it("does nothing with the setting off, and starts watching when it's turned on", () => {
    const { guard, seen, talkThenQuiet } = setup(false);
    guard.recordingChanged(recordingOf("m1"));
    talkThenQuiet(C.quietMs + C.answerMs);
    expect(seen.asks).toHaveLength(0);
    seen.enabled = true;
    guard.enabledChanged(recordingOf("m1"));
    talkThenQuiet(C.quietMs);
    expect(seen.asks).toHaveLength(1);
    seen.enabled = false;
    guard.enabledChanged(recordingOf("m1"));
    expect(seen.dismissed).toBe(1);
  });

  it("knows a call that started before the recording, and asks once its app lets go of the microphone", () => {
    const { guard, seen, talkThenQuiet } = setup();
    guard.helperEvent({ event: "call.started", bundleId: "us.zoom.xos", appName: "Zoom" });
    guard.recordingChanged(recordingOf("m1"));
    talkThenQuiet(C.quietMs + MIN);
    expect(seen.asks).toHaveLength(0);
    guard.helperEvent({ event: "call.ended", bundleId: "us.zoom.xos", appName: "Zoom" });
    guard.tick();
    expect(seen.asks).toHaveLength(1);
    expect(seen.asks[0]!.prompt.body).toMatch(/^Zoom let go of the microphone\./);
  });

  it("uses the calendar end set before the start, and forgets it with the recording", () => {
    const { guard, seen } = setup();
    guard.setCalendarEnd(T0 + 30 * MIN);
    guard.recordingChanged({ state: "starting", title: "Acme renewal" });
    guard.recordingChanged(recordingOf("m1"));
    seen.now = T0 + 30 * MIN + C.afterCalendarEndMs - 5_000;
    guard.helperEvent({ event: "transcript.delta", speaker: "me", text: "so", itemId: "i" });
    guard.tick();
    expect(seen.asks).toHaveLength(0);
    seen.now += 5_000;
    guard.tick();
    expect(seen.asks[0]!.prompt.body).toMatch(/^This meeting was due to end at 15:30\./);
    guard.recordingChanged({ state: "idle" });
    // The next recording has no calendar meeting.
    guard.recordingChanged(recordingOf("m2"));
    seen.now += 5 * MIN;
    guard.helperEvent({ event: "transcript.delta", speaker: "me", text: "so", itemId: "i" });
    guard.tick();
    expect(seen.asks).toHaveLength(1);
  });
});

/** Quiet on the other side with the room still talking, ticking as main does. */
function talkThenQuietOnly(guard: StillRecordingGuard, seen: { now: number }, ms: number): void {
  const until = seen.now + ms;
  while (seen.now < until) {
    seen.now += 5_000;
    guard.helperEvent({ event: "levels", mic: 0.3, system: 0 });
    guard.helperEvent({ event: "transcript.delta", speaker: "me", text: "and", itemId: "i" });
    guard.tick();
  }
}

describe("the autoStop setting", () => {
  it("is on by default and takes only a boolean", () => {
    expect(readSettings({}).autoStop).toBe(true);
    expect(readSettings({ autoStop: false }).autoStop).toBe(false);
    expect(parseSettingsPatch({ autoStop: false })).toEqual({ autoStop: false });
    expect(parseSettingsPatch({ autoStop: "no" })).toBeNull();
  });
});
