// Calendar polling and meeting prompts (docs/scribe.md "Meeting reminders"): ask
// /api/v1/calendar/upcoming every 5 minutes and on wake, prompt one minute before each meeting
// ("Join & take notes" / "Take notes"), nudge once a meeting has started without notes, and ask
// "Record this call?" when the helper sees a call app take the mic. Never records without a click.

import { Notification, powerMonitor } from "electron";
import { EventEmitter } from "node:events";
import type { CalendarEvent } from "@shared/api";
import type { CalendarSnapshot } from "@shared/ipc";
import type { AuthService } from "../auth/service";
import { errorMessage } from "../auth/oauth";
import { POLL_INTERVAL_MS } from "../config";
import { dueStartedNudges, planReminders, startedId, type Reminder } from "./planner";
import { parsePromptId, PromptLedger } from "./ledger";

export interface PromptHandlers {
  /** Take notes for an event; `join` also opens its call link. */
  takeNotes(event: CalendarEvent, join: boolean): void;
  /** Take notes for a call the helper detected. */
  recordCall(appName: string): void;
  isRecording(): boolean;
  recordingEventId(): string | undefined;
  /** How long before a meeting its reminder comes (the setting). Default one minute. */
  reminderLeadMs?(): number;
  /** A notification was shown (true) or macOS refused it (false). */
  notificationResult?(shown: boolean): void;
}

/** The id of the "Still recording?" notification (src/main/stillRecording.ts). */
export const STILL_RECORDING_PROMPT = "recording.still";

export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export class CalendarService extends EventEmitter<{ change: [CalendarSnapshot] }> {
  private snapshot: CalendarSnapshot = { connected: true, events: [] };
  private pollTimer: NodeJS.Timeout | undefined;
  private nudgeTimer: NodeJS.Timeout | undefined;
  private scheduled = new Map<string, NodeJS.Timeout>();
  /** Prompts already shown, kept across restarts when a ledger file is given. */
  private readonly ledger: PromptLedger;
  /** Shown notifications, kept so they aren't garbage-collected (their click handlers die with them). */
  private shown = new Map<string, Notification>();
  private running = false;

  constructor(
    private readonly auth: AuthService,
    private readonly handlers: PromptHandlers,
    private readonly log: (...parts: unknown[]) => void,
    ledger?: PromptLedger,
  ) {
    super();
    this.ledger = ledger ?? new PromptLedger("");
    powerMonitor.on("resume", () => {
      if (this.running) void this.refresh();
    });
  }

  get state(): CalendarSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    this.nudgeTimer = setInterval(() => this.nudgeStarted(), 30_000);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.pollTimer);
    clearInterval(this.nudgeTimer);
    for (const t of this.scheduled.values()) clearTimeout(t);
    this.scheduled.clear();
    for (const n of this.shown.values()) n.close();
    this.shown.clear();
    this.snapshot = { connected: true, events: [] };
    this.emit("change", this.snapshot);
  }

  async refresh(): Promise<void> {
    const api = this.auth.api;
    if (!api) return;
    try {
      const upcoming = await api.upcoming(24);
      this.snapshot = {
        connected: upcoming.connected,
        connectUrl: upcoming.connectUrl,
        events: upcoming.events,
        lastRefresh: new Date().toISOString(),
      };
      this.log(`calendar: connected ${upcoming.connected}, ${upcoming.events.length} upcoming`);
      this.reconcile();
      this.nudgeStarted();
    } catch (error) {
      if (!this.auth.handleError(error)) this.snapshot = { ...this.snapshot, error: errorMessage(error) };
    }
    this.emit("change", this.snapshot);
  }

  /** Taking notes for this event now: its prompts are moot. */
  clear(eventId: string): void {
    for (const [id, timer] of this.scheduled) {
      if (id.startsWith(`meeting.${eventId}.`)) {
        clearTimeout(timer);
        this.scheduled.delete(id);
      }
    }
    for (const [id, n] of this.shown) {
      if (id.includes(`.${eventId}.`)) {
        n.close();
        this.shown.delete(id);
      }
    }
  }

  /** The lead time changed: drop the scheduled prompts and plan again. Prompts already delivered
   * stay delivered. */
  replan(): void {
    for (const t of this.scheduled.values()) clearTimeout(t);
    this.scheduled.clear();
    if (this.running) this.reconcile();
  }

  /** Makes the scheduled prompts match the upcoming events. */
  private reconcile(): void {
    const events = this.snapshot.connected ? this.snapshot.events : [];
    const plan = planReminders(events, Date.now(), this.ledger.delivered, this.handlers.recordingEventId(), this.handlers.reminderLeadMs?.());
    const wanted = new Set(plan.map((r) => r.id));
    for (const [id, timer] of this.scheduled) {
      if (!wanted.has(id)) {
        clearTimeout(timer);
        this.scheduled.delete(id);
      }
    }
    for (const reminder of plan) {
      if (this.scheduled.has(reminder.id)) continue;
      // Timers drift across sleep; the poll on resume re-plans, and a passed mark fires at once.
      const delay = Math.max(0, Math.min(reminder.fireAt - Date.now(), 2 ** 31 - 1));
      this.scheduled.set(
        reminder.id,
        setTimeout(() => this.fire(reminder), delay),
      );
    }
  }

  private fire(reminder: Reminder): void {
    this.scheduled.delete(reminder.id);
    this.ledger.markDelivered(reminder.id);
    if (this.handlers.isRecording() && this.handlers.recordingEventId() === reminder.event.id) return;
    const event = reminder.event;
    const canJoin = !!event.conferenceUrl;
    this.show(reminder.id, {
      title: event.title,
      body: `Starts at ${formatTime(event.start)}. ${canJoin ? "Join and take notes?" : "Take notes?"}`,
      actions: canJoin ? ["Join & take notes", "Take notes"] : ["Take notes"],
      onAction: (index) => this.handlers.takeNotes(event, canJoin && index === 0),
    });
  }

  private nudgeStarted(): void {
    if (!this.snapshot.connected || !this.auth.api) return;
    for (const event of dueStartedNudges(this.snapshot.events, Date.now(), this.handlers.isRecording(), this.ledger.nudged)) {
      const id = startedId(event);
      this.ledger.markNudged(id);
      this.show(id, {
        title: `${event.title} started`,
        body: "Take notes?",
        actions: event.conferenceUrl ? ["Join & take notes", "Take notes"] : ["Take notes"],
        onAction: (index) => this.handlers.takeNotes(event, !!event.conferenceUrl && index === 0),
      });
    }
  }

  /** "Record this call?" when a call app starts using the mic. */
  callStarted(bundleId: string, appName: string): void {
    if (this.handlers.isRecording() || !this.auth.api) return;
    this.show(`call.${bundleId}`, {
      title: "Record this call?",
      body: `${appName} is using the microphone.`,
      actions: ["Take notes"],
      onAction: () => this.handlers.recordCall(appName),
    });
  }

  callEnded(bundleId: string): void {
    this.dismiss(`call.${bundleId}`);
  }

  /** A question from elsewhere in main ("Still recording?"), asked the way the meeting prompts
   * are. `onFailed`: macOS refused to show it (notifications are off for Every App). */
  prompt(id: string, o: { title: string; body: string; actions: string[]; onAction: (index: number) => void; onFailed?: () => void }): void {
    if (!Notification.isSupported()) return o.onFailed?.();
    this.show(id, o);
  }

  dismiss(id: string): void {
    this.shown.get(id)?.close();
    this.shown.delete(id);
  }

  /** Clicking the notification itself does the first action. */
  private show(id: string, o: { title: string; body: string; actions: string[]; onAction: (index: number) => void; onFailed?: () => void }): void {
    if (!Notification.isSupported()) return;
    this.shown.get(id)?.close();
    const n = new Notification({
      id,
      title: o.title,
      body: o.body,
      actions: o.actions.map((text) => ({ type: "button" as const, text })),
    });
    n.on("click", () => o.onAction(0));
    n.on("show", () => this.handlers.notificationResult?.(true));
    n.on("failed", () => {
      this.handlers.notificationResult?.(false);
      o.onFailed?.();
    });
    n.on("action", (details) => o.onAction(details.actionIndex));
    n.on("close", () => {
      if (this.shown.get(id) === n) this.shown.delete(id);
    });
    this.shown.set(id, n);
    n.show();
  }

  /** After a restart: re-attach handlers to our prompts still in Notification Center, so clicking
   * one still takes notes. "Record this call?" and "Still recording?" prompts from the last run
   * are stale and removed.
   * (macOS only; an unsigned dev run has no history.) */
  async restoreDelivered(): Promise<void> {
    if (process.platform !== "darwin" || typeof Notification.getHistory !== "function") return;
    let history: Notification[];
    try {
      history = await Notification.getHistory();
    } catch (error) {
      this.log(`notifications: no history (${errorMessage(error)})`);
      return;
    }
    for (const n of history) {
      const id = n.id;
      if (!id || this.shown.has(id)) continue;
      if (id.startsWith("call.") || id === STILL_RECORDING_PROMPT) {
        n.close();
        continue;
      }
      const prompt = parsePromptId(id);
      if (!prompt) continue;
      const act = (index: number) => void this.actOnRestored(prompt.eventId, index);
      n.on("click", () => act(0));
      n.on("action", (details) => act(details.actionIndex));
      n.on("close", () => {
        if (this.shown.get(id) === n) this.shown.delete(id);
      });
      this.shown.set(id, n);
    }
    if (history.length) this.log(`notifications: re-attached to ${this.shown.size} from the last run`);
  }

  /** A restored prompt was clicked: find its meeting (refreshing once if needed) and take notes. */
  private async actOnRestored(eventId: string, index: number): Promise<void> {
    if (this.handlers.isRecording()) return;
    let event = this.snapshot.events.find((e) => e.id === eventId);
    if (!event) {
      await this.refresh();
      event = this.snapshot.events.find((e) => e.id === eventId);
    }
    if (!event) {
      this.notify("That meeting isn't coming up anymore", "Start notes from the Scribe menu if you still need them.");
      return;
    }
    this.handlers.takeNotes(event, !!event.conferenceUrl && index === 0);
  }

  /** Generic notification with no actions. */
  notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  }
}
