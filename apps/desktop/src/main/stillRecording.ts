// "Still recording?": notices a recording that looks forgotten (the meeting is over and nobody
// pressed Stop), asks, and stops it the normal way if nobody answers (docs/scribe.md, "A recording
// left running"). The rules are in StillRecordingWatch, which only sees times handed to it; the
// guard feeds it the helper's events. No Electron import, so both run under plain Node.

import type { RecordingSnapshot } from "@shared/ipc";
import type { HelperEvent } from "@shared/protocol";

export interface StillRecordingConfig {
  /** The other side was heard earlier and has made no sound for this long: ask. */
  quietMs: number;
  /** The same, once the call app let go of the microphone or the calendar meeting is over. */
  quietAfterEndMs: number;
  /** A calendar meeting counts as over this long after its end time. */
  afterCalendarEndMs: number;
  /** Nobody on either side has said anything for this long: ask. */
  noSpeechMs: number;
  /** How long the question waits before the recording stops. */
  answerMs: number;
  /** After "Keep recording", no question for this long; doubled each time, up to `maxSnoozeMs`. */
  snoozeMs: number;
  maxSnoozeMs: number;
}

export const STILL_RECORDING: StillRecordingConfig = {
  quietMs: 5 * 60_000,
  quietAfterEndMs: 2 * 60_000,
  afterCalendarEndMs: 5 * 60_000,
  noSpeechMs: 10 * 60_000,
  answerMs: 3 * 60_000,
  snoozeMs: 30 * 60_000,
  maxSnoozeMs: 2 * 60 * 60_000,
};

/** The same rules, `factor` times faster (dev builds, to try it without waiting). */
export function scaled(config: StillRecordingConfig, factor: number): StillRecordingConfig {
  if (!(factor > 1)) return config;
  const out = { ...config };
  for (const key of Object.keys(out) as (keyof StillRecordingConfig)[]) out[key] = Math.max(1000, Math.round(out[key] / factor));
  return out;
}

/** Sound counts as "the other side" only when it lasts: this many seconds with sound out of the
 * last `SOUND_WINDOW_S`. A message ding, or the question's own sound, is not a meeting. */
export const SOUND_SECONDS = 3;
export const SOUND_WINDOW_S = 10;
/** Below this the system channel is hiss (levels are 0–1 over −60…0 dBFS). */
export const SOUND_LEVEL = 0.1;
/** Sound right after the question appears is ignored (its own alert sound). */
const ASK_SOUND_GRACE_MS = 5_000;
/** Sound this soon after a call app let go of the mic still belongs to that call. */
const CALL_END_SLACK_MS = 5_000;

export type StillReason =
  /** A call app that was on the microphone let go of it, and the other side is quiet. */
  | "call_ended"
  /** The calendar meeting's end time has passed, and the other side is quiet. */
  | "meeting_over"
  /** The other side has been quiet for `quietMs`. */
  | "quiet"
  /** Nobody has spoken for `noSpeechMs`. */
  | "no_speech";

export interface Asked {
  reason: StillReason;
  at: number;
  stopAt: number;
  /** For `call_ended`: the app that let go of the microphone. */
  appName?: string;
}

export type StillAction = { do: "ask"; asked: Asked } | { do: "withdraw" } | { do: "stop"; asked: Asked } | undefined;

/** One recording's watch. Every method takes the time; nothing here reads a clock. */
export class StillRecordingWatch {
  private readonly startedAt: number;
  /** Last time the other side made lasting sound; undefined until it has. */
  private themHeardAt: number | undefined;
  private soundSeconds: number[] = [];
  private speechAt: number;
  private transcriptionLive = true;
  private systemBroken = false;
  private callEnded: { at: number; appName: string } | undefined;
  private snoozedUntil = 0;
  private keeps = 0;
  asked: Asked | undefined;

  constructor(
    now: number,
    /** Call apps on the microphone right now (bundle ids). Shared with the guard, which keeps it. */
    private readonly calls: ReadonlySet<string>,
    public calendarEnd: number | undefined = undefined,
    private readonly config: StillRecordingConfig = STILL_RECORDING,
  ) {
    this.startedAt = now;
    this.speechAt = now;
  }

  /** The helper's `levels` for system audio (10 a second). */
  sound(now: number, level: number): void {
    if (level < SOUND_LEVEL) return;
    if (this.asked && now < this.asked.at + ASK_SOUND_GRACE_MS) return;
    const second = Math.floor(now / 1000);
    if (this.soundSeconds.at(-1) !== second) this.soundSeconds.push(second);
    this.soundSeconds = this.soundSeconds.filter((s) => s > second - SOUND_WINDOW_S);
    if (this.soundSeconds.length >= SOUND_SECONDS) this.themHeardAt = now;
  }

  /** A transcript line or part of one, from either side. */
  speech(now: number): void {
    this.speechAt = now;
  }

  /** While transcription is down there are no lines, so "nobody has spoken" can't be told. */
  transcription(now: number, live: boolean): void {
    if (live && !this.transcriptionLive) this.speechAt = now;
    this.transcriptionLive = live;
  }

  /** The system audio tap failed: its silence means nothing. */
  systemAudio(broken: boolean): void {
    this.systemBroken = broken;
  }

  /** A call app let go of the microphone (the guard has already taken it out of `calls`). */
  callEndedAt(now: number, appName: string): void {
    this.callEnded = { at: now, appName };
  }

  /** "Keep recording": no question for a while, longer each time. */
  keep(now: number): void {
    this.asked = undefined;
    this.snoozedUntil = now + Math.min(this.config.snoozeMs * 2 ** this.keeps, this.config.maxSnoozeMs);
    this.keeps++;
  }

  /** Why to ask now, if at all. */
  reason(now: number): StillReason | undefined {
    // A call app holding the microphone means a call is on, however quiet (you presenting to a
    // muted room, a break in a workshop).
    if (this.calls.size > 0) return undefined;
    const c = this.config;
    const heard = this.systemBroken ? undefined : this.themHeardAt;
    const quietFor = now - (heard ?? this.startedAt);
    if (!this.systemBroken) {
      if (this.calendarEnd !== undefined && now >= this.calendarEnd + c.afterCalendarEndMs && quietFor >= c.quietAfterEndMs) return "meeting_over";
      if (heard !== undefined) {
        // Sound that came back after the call app left is another call (in an app Every App doesn't
        // know): the plain rule applies to it.
        const call = this.callEnded;
        if (call && heard <= call.at + CALL_END_SLACK_MS && quietFor >= c.quietAfterEndMs) return "call_ended";
        if (quietFor >= c.quietMs) return "quiet";
      }
    }
    if (this.transcriptionLive && now - this.speechAt >= c.noSpeechMs) return "no_speech";
    return undefined;
  }

  /** What to do now. Call it every few seconds while recording. */
  tick(now: number): StillAction {
    const asked = this.asked;
    if (asked) {
      if (this.answeredByEvents(asked)) {
        this.asked = undefined;
        return { do: "withdraw" };
      }
      if (now >= asked.stopAt) {
        this.asked = undefined;
        return { do: "stop", asked };
      }
      return undefined;
    }
    if (now < this.snoozedUntil) return undefined;
    const reason = this.reason(now);
    if (!reason) return undefined;
    this.asked = { reason, at: now, stopAt: now + this.config.answerMs, appName: reason === "call_ended" ? this.callEnded?.appName : undefined };
    return { do: "ask", asked: this.asked };
  }

  /** The meeting went on by itself since the question: a call app took the microphone, the other
   * side made sound again, somebody spoke (for "nobody has spoken"), or the meeting was extended. */
  private answeredByEvents(asked: Asked): boolean {
    if (this.calls.size > 0) return true;
    if (asked.reason === "no_speech") return this.speechAt > asked.at;
    if (!this.systemBroken && this.themHeardAt !== undefined && this.themHeardAt > asked.at) return true;
    if (asked.reason === "meeting_over") return this.calendarEnd === undefined || asked.at < this.calendarEnd + this.config.afterCalendarEndMs;
    return false;
  }
}

const minutes = (ms: number): string => {
  const n = Math.max(1, Math.round(ms / 60_000));
  return n === 1 ? "a minute" : `${n} minutes`;
};

export interface StillPrompt {
  title: string;
  body: string;
  actions: [keep: string, stop: string];
}

/** The question's words. `time` formats a clock time ("3:42 PM"). */
export function promptFor(asked: Asked, calendarEnd: number | undefined, time: (ms: number) => string, config: StillRecordingConfig = STILL_RECORDING): StillPrompt {
  const why: Record<StillReason, string> = {
    call_ended: `${asked.appName ?? "The call app"} let go of the microphone.`,
    meeting_over: calendarEnd === undefined ? "This meeting's time is up." : `This meeting was due to end at ${time(calendarEnd)}.`,
    quiet: `Nothing from the other side for ${minutes(config.quietMs)}.`,
    no_speech: `Nobody has spoken for ${minutes(config.noSpeechMs)}.`,
  };
  return {
    title: "Still recording?",
    body: `${why[asked.reason]} Scribe stops at ${time(asked.stopAt)} unless you keep recording.`,
    actions: ["Keep recording", "Stop now"],
  };
}

export const STOPPED_NOTICE = {
  title: "Scribe stopped recording",
  body: "Nobody answered “Still recording?”. Your notes are being written.",
};

export interface GuardDeps {
  /** The setting; off means no watch at all. */
  enabled(): boolean;
  now(): number;
  /** Show the question; `answer(0)` keeps recording, `answer(1)` stops. */
  ask(prompt: StillPrompt, answer: (index: number) => void): void;
  /** Take the question down. */
  dismiss(): void;
  notify(title: string, body: string): void;
  /** Stop the recording the normal way (transcript saved, notes written). */
  stop(): void;
  time(ms: number): string;
  log(line: string): void;
  config?: StillRecordingConfig;
}

/** Follows the recording and the helper, and runs a watch for each recording. */
export class StillRecordingGuard {
  private watch: StillRecordingWatch | undefined;
  private meetingId: string | undefined;
  /** Call apps on the microphone, recording or not: a call often starts before the recording. */
  private readonly calls = new Set<string>();
  /** The end time of the calendar meeting about to be (or being) recorded. */
  private calendarEnd: number | undefined;

  constructor(private readonly deps: GuardDeps) {}

  get asking(): boolean {
    return !!this.watch?.asked;
  }

  setCalendarEnd(end: number | undefined): void {
    this.calendarEnd = end !== undefined && Number.isFinite(end) ? end : undefined;
    if (this.watch) this.watch.calendarEnd = this.calendarEnd;
  }

  recordingChanged(r: RecordingSnapshot): void {
    const recording = r.state === "recording" && !!r.meetingId;
    if (recording && this.watch && this.meetingId === r.meetingId) return;
    this.end();
    if (r.state === "idle") this.calendarEnd = undefined;
    if (!recording || !this.deps.enabled()) return;
    this.meetingId = r.meetingId;
    this.watch = new StillRecordingWatch(this.deps.now(), this.calls, this.calendarEnd, this.deps.config);
  }

  /** The setting changed. */
  enabledChanged(r: RecordingSnapshot): void {
    if (!this.deps.enabled()) this.end();
    else this.recordingChanged(r);
  }

  /** Call detection was turned off or the helper restarted: which apps hold the mic is unknown. */
  callsUnknown(): void {
    this.calls.clear();
  }

  helperEvent(event: HelperEvent): void {
    const now = this.deps.now();
    switch (event.event) {
      case "call.started":
        this.calls.add(event.bundleId);
        break;
      case "call.ended":
        if (this.calls.delete(event.bundleId) && this.calls.size === 0) this.watch?.callEndedAt(now, event.appName);
        break;
      case "levels":
        this.watch?.sound(now, event.system);
        break;
      case "transcript.delta":
      case "transcript.segment":
        this.watch?.speech(now);
        break;
      case "state":
        this.watch?.systemAudio(event.system === "error");
        this.watch?.transcription(now, (event.transcription ?? "live") === "live");
        break;
    }
  }

  tick(): void {
    const watch = this.watch;
    if (!watch) return;
    const action = watch.tick(this.deps.now());
    if (!action) return;
    if (action.do === "withdraw") {
      this.deps.log("still recording? withdrawn: the meeting went on");
      this.deps.dismiss();
    } else if (action.do === "ask") {
      const asked = action.asked;
      this.deps.log(`still recording? asking (${asked.reason}); stops at ${new Date(asked.stopAt).toISOString()}`);
      this.deps.ask(promptFor(asked, watch.calendarEnd, this.deps.time, this.deps.config), (index) => this.answer(watch, asked, index));
    } else {
      this.deps.log(`still recording? no answer (${action.asked.reason}): stopping`);
      this.end();
      this.deps.stop();
      this.deps.notify(STOPPED_NOTICE.title, STOPPED_NOTICE.body);
    }
  }

  /** An answer counts only for the question it was given to. */
  private answer(watch: StillRecordingWatch, asked: Asked, index: number): void {
    if (this.watch !== watch || watch.asked !== asked) return;
    this.deps.dismiss();
    if (index === 1) {
      this.deps.log("still recording? answered: stop");
      this.end();
      this.deps.stop();
    } else {
      this.deps.log("still recording? answered: keep recording");
      watch.keep(this.deps.now());
    }
  }

  private end(): void {
    if (this.watch?.asked) this.deps.dismiss();
    this.watch = undefined;
    this.meetingId = undefined;
  }
}
