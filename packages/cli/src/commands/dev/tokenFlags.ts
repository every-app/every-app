/**
 * `everyapp dev token`'s flag values, apart from the command so the router
 * loads them without the SDK's signing code (token.ts).
 */
export const DEV_TOKEN_ROLES = ["owner", "admin", "member"] as const;
export type DevTokenRole = (typeof DEV_TOKEN_ROLES)[number];

/** One hour: long enough for a script session, short enough to forget. */
export const DEFAULT_DEV_TOKEN_TTL_SECONDS = 60 * 60;
/** A day at most: a dev token is for the run in front of you. */
const MAX_DEV_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const APP_ID = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** `--ttl`: seconds, or a number with s, m or h (90s, 15m, 1h); at most a day. */
export function parseTtl(input: string): number {
  const match = /^(\d+)([smh]?)$/.exec(input.trim());
  if (!match) throw new Error("expected seconds, or a number with s, m or h (90s, 15m, 1h)");
  const seconds = Number(match[1]) * UNITS[match[2] || "s"]!;
  if (seconds < 1 || seconds > MAX_DEV_TOKEN_TTL_SECONDS) {
    throw new Error(`expected between 1s and 24h`);
  }
  return seconds;
}

/** `--user`: an email address. */
export function parseEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("expected an email address");
  return email;
}

/** `--app`: an app id, kebab-case like everyapp.config.ts's `id`. */
export function parseAppId(input: string): string {
  if (!APP_ID.test(input)) throw new Error("expected an app id (kebab-case, like everyapp.config.ts's id)");
  return input;
}
