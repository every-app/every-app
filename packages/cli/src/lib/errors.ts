/**
 * Errors the commands raise on purpose. Commands report them as events
 * (lib/output/report.ts): an `EveryAppError` is an `error` with a stable
 * code, an `ActionRequiredError` is `action_required` (exit 2: do the
 * action, then run the same command again to resume), and a
 * `CancelledError` is the person declining a prompt (exit 1, shown dim:
 * "Cancelled. Nothing changed.").
 *
 * What to do next is each error's own to say, never the command that just
 * failed by default:
 *  - `fix`: a remedy that isn't a command ("use a name with lowercase
 *    letters, digits and dashes");
 *  - `rerun`: a command to run, with `rerunNote` after it ("once it's
 *    done"). It defaults to this same command only where running it again
 *    can help: an `ActionRequiredError` (do the action, then run it again),
 *    a `retryable` error, and a takeover (the command with its flag,
 *    `authorize`d).
 * A validation error says what's wrong and how to fix it, with no rerun.
 */
import { thisCommand } from "@/lib/output/command";
import type { RequiredAction } from "@/lib/output/events";
import { InstallationError } from "@every-app/perimeter/install";

/** Codes the reporting itself gives, rather than one place that raised them. */
export enum ReportCode {
  /** The person declined a prompt or pressed Ctrl-C at it. */
  Cancelled = "CANCELLED",
  /** Not an error everyapp raised on purpose: a bug. */
  Unexpected = "UNEXPECTED",
  /** The network failed under a request (offline, DNS, a reset connection). */
  Network = "NETWORK_ERROR",
  /** The system refused something (a file, a permission). */
  System = "SYSTEM_ERROR",
}

/**
 * Errors whose way on is a flag that takes something over (replaces a DNS
 * record, deletes data, skips a confirmation): their rerun carries the flag
 * and `authorize`, so an agent shows the error and asks before using it,
 * never retries with it on its own. (DOWNGRADE_REFUSED sets its own: only
 * `setup` takes --allow-downgrade; elsewhere the way on is `git pull`.)
 */
const TAKEOVER_FLAGS: Readonly<Record<string, string>> = {
  DNS_RECORD_CONFLICT: "--force-dns",
  DNS_UNREADABLE: "--force-dns",
  CAA_BLOCKS_ISSUANCE: "--force-dns",
  DURABLE_OBJECT_REMOVED: "--allow-delete-durable-object-data",
  WORKFLOW_REMOVED: "--allow-delete-workflows",
  EMAIL_ROUTING_DISABLED: "--enable-email-routing",
  CONFIRMATION_REQUIRED: "--yes",
};

/** What a problem says to do next (see the top of this file). */
interface NextStep {
  /** A remedy that isn't a command. */
  fix?: string;
  /** The command to run next. */
  rerun?: string;
  /** Said dim after `rerun` ("once it's done", "in a terminal"). */
  rerunNote?: string;
}

/** An expected failure, with a stable code for scripts and a message for people. */
export class EveryAppError extends Error {
  static fromInstallation(error: unknown): unknown {
    return error instanceof InstallationError ? new EveryAppError(error.code, error.message, error.options) : error;
  }
  readonly code: string;
  readonly retryable: boolean;
  readonly fix?: string;
  /** The command to run next; this same one when `retryable`, unless set. */
  readonly rerun?: string;
  readonly rerunNote?: string;
  /** `rerun` takes something over: show it and ask before running it. */
  readonly authorize: boolean;
  /** What else the error event carries for a script (`data`). */
  readonly data?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: NextStep & {
      retryable?: boolean;
      authorize?: boolean;
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "EveryAppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.fix = options.fix;
    const takeover = TAKEOVER_FLAGS[code];
    this.rerun =
      options.rerun ??
      (takeover ? thisCommand([takeover]) : this.retryable ? thisCommand() : undefined);
    this.rerunNote = options.rerunNote;
    this.authorize = options.authorize ?? takeover !== undefined;
    this.data = options.data;
  }
}

/** Something only a person can do before the command can go on. */
export class ActionRequiredError extends Error {
  readonly action: RequiredAction;
  readonly url?: string;
  /**
   * The command to run once it is done: this same one, unless set; null
   * when there is no one command (`data.choices` lists one per choice).
   */
  readonly rerun: string | null;
  readonly rerunNote?: string;
  /** What else the event carries for a script (`data`), e.g. the choices. */
  readonly data?: Record<string, unknown>;

  constructor(
    action: RequiredAction,
    message: string,
    url?: string,
    options: Omit<NextStep, "fix" | "rerun"> & {
      rerun?: string | null;
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "ActionRequiredError";
    this.action = action;
    this.url = url;
    this.rerun = options.rerun === undefined ? thisCommand() : options.rerun;
    this.rerunNote = options.rerunNote;
    this.data = options.data;
  }
}

/** The restore point a run saved before it migrated a database (lib/migrations/remote.ts). */
export interface Rollback {
  /** `everyapp db restore`, as a person runs it. */
  restoreCommand: string;
  /** cf's own `d1 time-travel restore` with the bookmark, for scripts (--json). */
  rollbackCommand: string;
}

/**
 * The person declined a prompt, or pressed Ctrl-C at one: nothing went
 * wrong, so it's said dim, with no next step, though the run exits 1 for
 * scripts. `message` says what was left as it was ("Cancelled. Nothing
 * deleted.").
 */
export class CancelledError extends EveryAppError {
  constructor(message = "Cancelled. Nothing changed.") {
    super(ReportCode.Cancelled, message);
    this.name = "CancelledError";
  }
}

const rollbacks = new WeakMap<object, Rollback>();

/**
 * A failure after a migration changed a database: its report says how to
 * put the database back to the restore point saved before. Returns
 * `error`, to rethrow.
 */
export function afterMigration(
  error: unknown,
  rollback: Rollback | null,
): unknown {
  if (rollback && typeof error === "object" && error !== null) {
    if (!rollbacks.has(error)) rollbacks.set(error, rollback);
  }
  return error;
}

/** The restore point `afterMigration` attached to `error`, if any. */
export function rollbackFor(error: unknown): Rollback | undefined {
  return typeof error === "object" && error !== null
    ? rollbacks.get(error)
    : undefined;
}

/** What went wrong, from anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
