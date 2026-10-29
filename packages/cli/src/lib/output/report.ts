import { CfError, CfOutputError, CfTimeoutError, isCfError } from "@/lib/cf/errors";
import {
  ActionRequiredError,
  EveryAppError,
  ReportCode,
  rollbackFor,
} from "@/lib/errors";
import { ManifestError } from "@every-app/perimeter/manifest";
import { thisCommand } from "./command";
import type { EventSink, RequiredAction } from "./events";

/** Where an account subscribes to Workers Paid, whichever account it is. */
const WORKERS_PLANS_URL =
  "https://dash.cloudflare.com/?to=/:account/workers/plans";

/** The login's own profile, where its email address gets verified. */
const CLOUDFLARE_PROFILE_URL = "https://dash.cloudflare.com/profile";

/** Node's codes for a request the network failed under. */
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Report a failed command as its last event: `action_required` for
 * something a person has to do, otherwise `error` with a stable code. Each
 * says what to do next its own way (lib/errors.ts): `data.fix`, and
 * `data.rerun` (with `data.rerunNote`) where a command helps; an error
 * whose rerun takes something over says so (`data.authorize`), and one
 * raised after a migration repeats the command that rolls the database
 * back. An error everyapp didn't raise on purpose is a bug: it says so,
 * carries its stack (`data.stack`, shown with --verbose), and suggests
 * --verbose to see it.
 */
export function reportFailure(out: EventSink, error: unknown, step?: string): void {
  const rollback = rollbackFor(error);
  error = EveryAppError.fromInstallation(error);
  // Each event says how to roll back a database this run migrated, if one was.
  const withRollback = (message: string) =>
    rollback ? `${message}\nThe database stays migrated. To roll it back: ${rollback.restoreCommand}` : message;
  const rollbackData = rollback ? { rollbackCommand: rollback.rollbackCommand } : {};
  const at = step ? { step } : {};
  const requireAction = (
    action: RequiredAction,
    message: string,
    data: Record<string, unknown>,
  ) =>
    out.emit({
      type: "action_required",
      action,
      message: withRollback(message),
      ...at,
      data: { ...data, ...rollbackData },
    });
  const fail = (
    code: string,
    message: string,
    retryable: boolean,
    data: Record<string, unknown>,
  ) =>
    out.emit({
      type: "error",
      code,
      message: withRollback(message),
      retryable,
      ...at,
      data: { ...data, ...rollbackData },
    });

  if (error instanceof ActionRequiredError) {
    requireAction(error.action, error.message, {
      ...error.data,
      ...(error.url ? { url: error.url } : {}),
      ...(error.rerun ? { rerun: error.rerun } : {}),
      ...(error.rerunNote ? { rerunNote: error.rerunNote } : {}),
    });
    return;
  }
  if (isCfError(error, "free_plan")) {
    requireAction(
      "upgrade_workers_paid",
      `Cloudflare refused, for the Free plan: ${error.message}\nEveryApp needs Workers Paid ($5 a month, then usage). Subscribe, then run this command again.`,
      { url: WORKERS_PLANS_URL, rerun: thisCommand() },
    );
    return;
  }
  if (error instanceof EveryAppError) {
    fail(error.code, error.message, error.retryable, {
      ...error.data,
      ...(error.fix ? { fix: error.fix } : {}),
      ...(error.rerun ? { rerun: error.rerun } : {}),
      ...(error.rerunNote ? { rerunNote: error.rerunNote } : {}),
      ...(error.authorize ? { authorize: true } : {}),
    });
    return;
  }
  const known = knownFailure(error);
  if (known) {
    fail(known.code, known.message, known.retryable, {
      ...known.data,
      ...(known.retryable ? { rerun: thisCommand() } : {}),
    });
    return;
  }
  const thrown = error instanceof Error ? error : new Error(String(error));
  fail(
    ReportCode.Unexpected,
    `everyapp hit an unexpected error\n${thrown.name}: ${thrown.message}\nThis is a bug in everyapp, not something you did.`,
    false,
    {
      ...(thrown.stack ? { stack: thrown.stack } : {}),
      ...(out.verbose
        ? {}
        : { rerun: thisCommand(["--verbose"]), rerunNote: "for a stack trace to report" }),
    },
  );
}

/**
 * A failure that isn't everyapp's own but isn't a bug either: cf's, the
 * network's, a manifest's. Where Cloudflare's words leave no way on, ours
 * say it: an account whose email isn't verified yet (API code 10034) can't
 * create anything until it is, and then the same command runs.
 */
function knownFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  data?: Record<string, unknown>;
} | null {
  if (!(error instanceof Error)) return null;
  if (isCfError(error, "email_unverified")) {
    return {
      code: "CF_EMAIL_UNVERIFIED",
      message:
        "Verify your Cloudflare account's email address first\nCloudflare refuses to create anything until the address on the account is verified. Open the message Cloudflare sent you, then run this command again.",
      retryable: true,
      data: { url: CLOUDFLARE_PROFILE_URL, cloudflare: error.message },
    };
  }
  if (error instanceof CfError) {
    return {
      code: `CF_${error.kind.toUpperCase()}`,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof CfTimeoutError) {
    return { code: "CF_TIMEOUT", message: error.message, retryable: true };
  }
  if (error instanceof CfOutputError) {
    return { code: "CF_OUTPUT", message: error.message, retryable: false };
  }
  if (error instanceof ManifestError) {
    return { code: "INVALID_MANIFEST", message: error.message, retryable: false };
  }
  const code = systemCode(error) ?? systemCode(error.cause);
  if (code && NETWORK_CODES.has(code)) {
    return {
      code: ReportCode.Network,
      message: `The network failed (${code})\n${error.message}`,
      retryable: true,
    };
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    return { code: ReportCode.Network, message: "The network failed\nfetch failed", retryable: true };
  }
  if (code)
    return {
      code: ReportCode.System,
      message: error.message,
      retryable: false,
    };
  return null;
}

/** Node's code for a system error (`ENOENT`, `ECONNRESET`), if `value` is one. */
function systemCode(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof value === "object" && typeof code === "string" && /^[A-Z_]+$/.test(code)
    ? code
    : undefined;
}
