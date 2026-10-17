/**
 * Errors the deploy pipelines raise on purpose. Commands report them as
 * events (lib/output/report.ts): an `EveryAppError` is an `error` with a
 * stable code, an `ActionRequiredError` is `action_required` (exit 2: do the
 * action, then re-run the same command to resume). Either ends with the
 * command to run next (`data.rerun`), this same one unless it says otherwise.
 */
import { thisCommand } from "@/lib/output/command";
import type { RequiredAction } from "@/lib/output/events";

/**
 * Errors whose way on is a flag that takes something over (replaces a DNS
 * record, deletes data, skips a confirmation): their rerun carries the flag
 * and `authorize`, so an agent shows the error and asks before using it,
 * never retries with it on its own. (DOWNGRADE_REFUSED sets its own: only
 * `setup` takes --allow-downgrade; elsewhere the way on is `git pull`.)
 */
const TAKEOVER_FLAGS: Readonly<Record<string, string>> = {
  DNS_RECORD_CONFLICT: "--force-dns",
  CAA_BLOCKS_ISSUANCE: "--force-dns",
  DURABLE_OBJECT_REMOVED: "--allow-delete-durable-object-data",
  WORKFLOW_REMOVED: "--allow-delete-workflows",
  EMAIL_ROUTING_DISABLED: "--enable-email-routing",
  CONFIRMATION_REQUIRED: "--yes",
};

/** An expected failure, with a stable code for scripts and a message for people. */
export class EveryAppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** The command to run next, when it isn't this same one again. */
  readonly rerun?: string;
  /** `rerun` takes something over: show it and ask before running it. */
  readonly authorize: boolean;
  /** What else the error event carries for a script (`data`). */
  readonly data?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      rerun?: string;
      authorize?: boolean;
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "EveryAppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    const takeover = TAKEOVER_FLAGS[code];
    this.rerun =
      options.rerun ?? (takeover ? thisCommand([takeover]) : undefined);
    this.authorize = options.authorize ?? takeover !== undefined;
    this.data = options.data;
  }
}

/** Something only a person can do before the command can go on. */
export class ActionRequiredError extends Error {
  readonly action: RequiredAction;
  readonly url?: string;
  /** The command to run once it is done, when it isn't this same one again. */
  readonly rerun?: string;
  /** What else the event carries for a script (`data`), e.g. the choices. */
  readonly data?: Record<string, unknown>;

  constructor(
    action: RequiredAction,
    message: string,
    url?: string,
    options: { rerun?: string; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ActionRequiredError";
    this.action = action;
    this.url = url;
    this.rerun = options.rerun;
    this.data = options.data;
  }
}

const rollbacks = new WeakMap<object, string>();

/**
 * A failure after a migration changed a database: its report repeats the
 * command that restores the bookmark taken before (lib/migrations/remote.ts).
 * Returns `error`, to rethrow.
 */
export function afterMigration(
  error: unknown,
  rollbackCommand: string | null,
): unknown {
  if (rollbackCommand && typeof error === "object" && error !== null) {
    if (!rollbacks.has(error)) rollbacks.set(error, rollbackCommand);
  }
  return error;
}

/** The restore command `afterMigration` attached to `error`, if any. */
export function rollbackCommandFor(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? rollbacks.get(error)
    : undefined;
}
