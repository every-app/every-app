import { ManifestError } from "@every-app/perimeter/manifest";
import { CfError, CfOutputError, CfTimeoutError } from "@/lib/cf/errors";
import {
  ActionRequiredError,
  EveryAppError,
  rollbackFor,
} from "@/lib/errors";
import { thisCommand } from "./command";
import type { EventSink } from "./events";

/** Where an account subscribes to Workers Paid, whichever account it is. */
const WORKERS_PLANS_URL =
  "https://dash.cloudflare.com/?to=/:account/workers/plans";

/**
 * Report a failed command as its last event: `action_required` for
 * something a person has to do, otherwise `error` with a stable code. Each
 * ends with the command to run next (`data.rerun`); an error whose rerun
 * takes something over says so (`data.authorize`), and one raised after a
 * migration repeats the command that rolls the database back.
 */
export function reportFailure(
  out: EventSink,
  error: unknown,
  step?: string,
): void {
  const rollback = rollbackFor(error);
  const withRollback = (message: string) =>
    rollback
      ? `${message}\nThe database stays migrated. To roll it back: ${rollback.restoreCommand}`
      : message;
  const rollbackData = rollback ? { rollbackCommand: rollback.rollbackCommand } : {};
  if (error instanceof ActionRequiredError) {
    out.emit({
      type: "action_required",
      action: error.action,
      message: withRollback(error.message),
      ...(step ? { step } : {}),
      data: {
        ...error.data,
        ...(error.url ? { url: error.url } : {}),
        rerun: error.rerun ?? thisCommand(),
        ...rollbackData,
      },
    });
    return;
  }
  if (error instanceof CfError && error.kind === "free_plan") {
    out.emit({
      type: "action_required",
      action: "upgrade_workers_paid",
      message: withRollback(
        `Cloudflare refused, for the Free plan: ${error.message}\nEvery App needs Workers Paid ($5 a month, then usage). Subscribe, then run this command again.`,
      ),
      ...(step ? { step } : {}),
      data: { url: WORKERS_PLANS_URL, rerun: thisCommand(), ...rollbackData },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof EveryAppError
      ? error.code
      : error instanceof CfError
        ? `CF_${error.kind.toUpperCase()}`
        : error instanceof CfTimeoutError
          ? "CF_TIMEOUT"
          : error instanceof CfOutputError
            ? "CF_OUTPUT"
            : error instanceof ManifestError
              ? "INVALID_MANIFEST"
              : "UNEXPECTED";
  const authorize = error instanceof EveryAppError && error.authorize;
  out.emit({
    type: "error",
    code,
    message: withRollback(message),
    retryable:
      error instanceof EveryAppError
        ? error.retryable
        : error instanceof CfTimeoutError,
    ...(step ? { step } : {}),
    data: {
      ...(error instanceof EveryAppError ? error.data : {}),
      rerun:
        (error instanceof EveryAppError ? error.rerun : undefined) ??
        thisCommand(),
      ...(authorize ? { authorize: true } : {}),
      ...rollbackData,
    },
  });
}
