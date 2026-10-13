/**
 * Structured JSON log lines with a never-log list.
 *
 * Workers Logs keeps every console line and shows it to anyone with
 * observability access on the account, so credentials must never reach it.
 * Whatever a caller passes, values under credential-shaped keys are replaced
 * at any depth: the `cookie`, `authorization` and `set-cookie` headers, and
 * any key that names a token, secret, password or code.
 */

export const REDACTED = "[redacted]";

const NEVER_LOG_KEYS = new Set(["cookie", "authorization", "set-cookie"]);
const NEVER_LOG_KEY_PATTERN = /token|secret|password|code/i;
// Log fields are flat metadata; anything nested deeper is cut off rather than
// walked, so a cyclic or huge value can't stall the request.
const MAX_DEPTH = 4;

export function isNeverLogKey(key: string): boolean {
  return (
    NEVER_LOG_KEYS.has(key.toLowerCase()) || NEVER_LOG_KEY_PATTERN.test(key)
  );
}

/** Copy of `value` with every never-log key's value replaced by REDACTED. */
export function redactLogFields(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH
      ? "[truncated]"
      : value.map((item) => redactLogFields(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, field]) => [
      key,
      isNeverLogKey(key) ? REDACTED : redactLogFields(field, depth + 1),
    ]),
  );
}

type LogLevel = "log" | "warn" | "error";

/** Write one `{"evt": event, ...fields}` JSON line, redacted. */
export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
  level: LogLevel = "log",
): void {
  console[level](
    JSON.stringify({
      evt: event,
      ...(redactLogFields(fields) as Record<string, unknown>),
    }),
  );
}
