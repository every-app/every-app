/**
 * Errors the deploy pipelines raise on purpose. Commands report them as
 * events (lib/output/report.ts): an `EveryAppError` is an `error` with a
 * stable code, an `ActionRequiredError` is `action_required` (exit 2: do the
 * action, then re-run the same command to resume).
 */
import type { RequiredAction } from "@/lib/output/events";

/** An expected failure, with a stable code for scripts and a message for people. */
export class EveryAppError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "EveryAppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** Something only a person can do before the command can go on. */
export class ActionRequiredError extends Error {
  readonly action: RequiredAction;
  readonly url?: string;

  constructor(action: RequiredAction, message: string, url?: string) {
    super(message);
    this.name = "ActionRequiredError";
    this.action = action;
    this.url = url;
  }
}
