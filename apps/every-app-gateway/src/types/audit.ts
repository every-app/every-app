import type { AuditActor, AuditSubject } from "@every-app/sdk/internal";

/** Where a page of audit events continues: its last row's time and id. */
export type AuditCursor = {
  /** `time` in milliseconds since the epoch. */
  time: number;
  id: string;
};

/**
 * One event as Admin → Activity → Audit lists it: when, who, what (the
 * type in plain words and the catalogue's one-line summary) and what it
 * was about. Never the event's `data` itself: the Events tab's deliveries
 * show a payload, the audit log shows the trail.
 */
export type AuditRow = {
  id: string;
  /** Milliseconds since the epoch. */
  time: number;
  type: string;
  /** The type in plain words (the catalogue's description; "App event: …" for an app's own). */
  label: string;
  /** The catalogue's one line for the event. */
  summary: string;
  actor: AuditActor;
  subject: AuditSubject;
  /** True for an app's own event (`app.<id>.<name>`). */
  appEvent: boolean;
};

export type AuditPage = {
  events: AuditRow[];
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: AuditCursor | null;
};

/** One actor the organization's trail names, for the Who filter. */
export type AuditActorChoice = AuditActor & {
  /** How many of the organization's audit events they caused. */
  events: number;
};
