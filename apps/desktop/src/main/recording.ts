// Starting and stopping a recording: create the meeting on the Worker, hand the helper the meeting
// id and a token, and follow the helper's state and transcript. Electron-free, for the tests.

import { EventEmitter } from "node:events";
import type { Attendee, CalendarEvent } from "@shared/api";
import type { RecordingSnapshot } from "@shared/ipc";
import type { HelperEvent, TranscriptSegment } from "@shared/protocol";
import type { TranscriptionServerParams } from "@shared/transcriptionServer";
import type { AuthService } from "./auth/service";
import { errorMessage } from "./auth/oauth";
import { HelperRequestError, type HelperSupervisor } from "./helper/supervisor";

export interface StartOptions {
  title: string;
  startsAt?: string;
  calendarEventId?: string;
  attendees?: Attendee[];
}

export interface RecordingEvents {
  change: [RecordingSnapshot];
  /** The helper died mid-recording; main notifies the person. `meetingId` is being finished. */
  crashed: [{ meetingId?: string }];
  /** A stop couldn't save everything: keep it and replay it later (pending.ts). */
  unsaved: [{ meetingId: string; appUrl: string; segments: TranscriptSegment[]; needsFinish: boolean }];
}

export class RecordingController extends EventEmitter<RecordingEvents> {
  private snapshot: RecordingSnapshot = { state: "idle" };
  /** Recordings cut short by a helper crash since launch (for diagnostics). */
  crashCount = 0;
  /** While offline or waiting for a new sign-in, failed posts are expected (the helper keeps them
   * and retries); main's banner says so, so they aren't shown as a recording error. */
  saveFailuresExpected: () => boolean = () => false;
  /** Why a recording can't start right now (a microphone test is running), or undefined. */
  startBlocked: () => string | undefined = () => undefined;
  /** The person's own transcription server, when they turned one on (transcription.ts). It throws
   * when the setting is on but incomplete: the recording then doesn't start, since its audio
   * must not go anywhere else. */
  transcription: () => TranscriptionServerParams | undefined = () => undefined;

  constructor(
    private readonly auth: AuthService,
    private readonly helper: HelperSupervisor,
    private readonly log: (...parts: unknown[]) => void = () => {},
  ) {
    super();
    helper.on("event", (event) => this.onHelperEvent(event));
    helper.on("exit", ({ wasRecording }) => {
      if (this.snapshot.state === "idle") return;
      const meetingId = this.snapshot.meetingId;
      const cutShort = wasRecording || !!meetingId;
      this.set({ state: "idle", error: cutShort ? "The recorder stopped unexpectedly. What it saved is kept." : undefined }, true);
      if (cutShort) {
        this.crashCount++;
        this.log(`recording ${meetingId ?? ""} cut short by a helper crash (${this.crashCount} since launch)`);
        this.emit("crashed", { meetingId });
      }
      // The helper didn't get to /finish: do it, so notes are written from what was posted.
      if (meetingId) void this.auth.api?.finish(meetingId).catch((e) => this.log(`finish after crash failed: ${errorMessage(e)}`));
    });
  }

  get state(): RecordingSnapshot {
    return this.snapshot;
  }

  get isActive(): boolean {
    return this.snapshot.state !== "idle";
  }

  static titleFor(event: CalendarEvent): StartOptions {
    return { title: event.title, startsAt: event.start, calendarEventId: event.id, attendees: event.attendees };
  }

  static nowTitle(now = new Date()): string {
    return `Meeting at ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  async start(options: StartOptions): Promise<void> {
    if (this.isActive) throw new Error(`Scribe is already taking notes for “${this.snapshot.title}”.`);
    const blocked = this.startBlocked();
    if (blocked) throw new Error(blocked);
    const api = this.auth.api;
    if (!api) throw new Error("Sign in to Scribe first.");
    const transcription = this.transcription();
    this.set({ state: "starting", title: options.title, calendarEventId: options.calendarEventId, error: undefined }, true);
    let meetingId: string | undefined;
    try {
      await this.ensureMic();
      meetingId = await api.createMeeting({
        title: options.title,
        startsAt: options.startsAt ?? new Date().toISOString(),
        calendarEventId: options.calendarEventId,
        attendees: options.attendees?.length ? options.attendees : undefined,
      });
      this.set({ meetingId });
      const accessToken = await this.auth.accessToken();
      if (!accessToken) throw new Error("You're signed out. Sign in again.");
      const { startedAt } = await this.helper.request("record.start", {
        meetingId,
        apiBase: api.appUrl,
        accessToken,
        ...(transcription ? { transcription } : {}),
      });
      this.set({ state: "recording", startedAt });
      this.log(`recording ${meetingId}`);
    } catch (error) {
      // Cancelled (stopped while still starting: a normal outcome, nothing captured, no /finish) or
      // failed: either way the meeting has no recording behind it. Delete it, so it doesn't sit in
      // the list as "recording" or as an empty meeting.
      if (meetingId) void this.discard(meetingId);
      if (error instanceof HelperRequestError && error.code === "cancelled") {
        this.log(`start of ${meetingId ?? "a meeting"} cancelled by a stop`);
        this.set({ state: "idle" }, true);
        return;
      }
      this.auth.handleError(error);
      this.set({ state: "idle", error: errorMessage(error) }, true);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.snapshot.state !== "recording" && this.snapshot.state !== "starting") return;
    this.set({ state: "stopping", stopping: true, stoppingSince: new Date().toISOString() });
    try {
      const meetingId = this.snapshot.meetingId;
      const { segments, cancelled, finished, unsaved } = await this.helper.request("record.stop");
      this.log(cancelled ? "stopped before the recording started (cancelled)" : `stopped; ${segments} segments${unsaved?.length ? `, ${unsaved.length} unsaved` : ""}${finished === false ? ", not finished" : ""}`);
      const leftovers = Array.isArray(unsaved) ? unsaved : [];
      const appUrl = this.auth.api?.appUrl ?? this.auth.state.appUrl;
      if (!cancelled && meetingId && appUrl && (leftovers.length || finished === false)) {
        // The helper skips /finish whenever it hands segments back, so those always need it.
        this.emit("unsaved", { meetingId, appUrl, segments: leftovers, needsFinish: finished === false || leftovers.length > 0 });
      }
      this.set({ state: "idle", error: undefined }, true);
    } catch (error) {
      // Already stopped on its own: nothing to do.
      if (error instanceof HelperRequestError && error.code === "not_recording") return this.set({ state: "idle" }, true);
      this.set({ state: "idle", error: errorMessage(error) }, true);
      throw error;
    }
  }

  private async discard(meetingId: string): Promise<void> {
    try {
      await this.auth.api?.deleteMeeting(meetingId);
      this.log(`deleted meeting ${meetingId}: its recording never started`);
    } catch (error) {
      this.log(`couldn't delete meeting ${meetingId} after a failed start: ${errorMessage(error)}`);
    }
  }

  /** Asks for the mic before the first recording (never from inside capture). */
  private async ensureMic(): Promise<void> {
    let status = await this.helper.refreshPermissions();
    if (status.mic === "undetermined") status = await this.helper.requestPermission("mic");
    if (status.mic === "denied") {
      throw new Error("Microphone access is off for Every App. Turn it on in System Settings → Privacy & Security → Microphone.");
    }
  }

  private onHelperEvent(event: HelperEvent): void {
    switch (event.event) {
      case "state":
        if (event.recording) {
          this.set({ state: this.snapshot.state === "stopping" ? "stopping" : "recording", mode: event.mode, mic: event.mic, system: event.system, transcription: event.transcription });
        } else if (this.snapshot.state === "recording") {
          this.set({ state: "idle" }, true);
        }
        break;
      case "transcript.segment":
        this.set({ lastLine: event.text });
        break;
      case "error":
        // save_failed: segments didn't reach the Worker (the helper retries); say so.
        if (event.fatal || (event.code === "save_failed" && !this.saveFailuresExpected())) this.set({ error: event.message });
        // fallback_backlog: the chunked fallback fell behind and dropped some audio (or the
        // person's own server left some untranscribed); keep going.
        else if (event.code === "fallback_backlog") this.set({ warning: event.message });
        break;
    }
  }

  /** `reset` drops everything from the last recording first. */
  private set(patch: Partial<RecordingSnapshot>, reset = false): void {
    const base: RecordingSnapshot = reset ? { state: "idle" } : this.snapshot;
    this.snapshot = { ...base, ...patch };
    this.emit("change", this.snapshot);
  }
}
