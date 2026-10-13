import { CfError, CfOutputError, CfTimeoutError } from "@/lib/cf/errors";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import type { EventSink } from "./events";

/**
 * Report a failed command as its last event: `action_required` for
 * something a person has to do, otherwise `error` with a stable code.
 */
export function reportFailure(
  out: EventSink,
  error: unknown,
  step?: string,
): void {
  if (error instanceof ActionRequiredError) {
    out.emit({
      type: "action_required",
      action: error.action,
      message: error.message,
      ...(step ? { step } : {}),
      ...(error.url ? { data: { url: error.url } } : {}),
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
            : "UNEXPECTED";
  out.emit({
    type: "error",
    code,
    message,
    retryable:
      error instanceof EveryAppError
        ? error.retryable
        : error instanceof CfTimeoutError,
    ...(step ? { step } : {}),
  });
}
