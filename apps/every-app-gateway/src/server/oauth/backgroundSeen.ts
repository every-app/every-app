/**
 * The perimeter's half of the background idle lapse
 * (docs/design/2026-11-birds-decisions/888-background-oauth.md): when a
 * member opens an app, their background grants for it stay alive. Kept
 * apart from ./background.ts so the perimeter loads the repository alone.
 */
import { waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { BackgroundGrantRepository } from "@/server/repositories/BackgroundGrantRepository";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A grant lapses after this many days in which the member never opened the app. */
export const BACKGROUND_IDLE_DAYS = 90;

/** Per isolate: the (member, app) pairs touched today, so a request costs no write. */
const seenToday = new Map<string, string>();
const SEEN_CACHE_MAX = 2000;

/**
 * The member opened the app: keep their grants for it alive. At most one
 * write a day per (member, app) per isolate, and the row only when its
 * `last_seen_at` is a day old. Never throws; runs after the response.
 */
export function noteMemberSeen(userId: string, appRowId: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${userId}\u0000${appRowId}`;
  if (seenToday.get(key) === day) return;
  if (seenToday.size >= SEEN_CACHE_MAX) seenToday.clear();
  seenToday.set(key, day);
  const task = BackgroundGrantRepository.touchSeen({
    userId,
    appRowId,
    staleMs: DAY_MS,
  }).catch((error: unknown) => {
    seenToday.delete(key);
    logEvent(
      "oauth.background_seen_failed",
      { error: error instanceof Error ? error.name : "unknown" },
      "warn",
    );
  });
  try {
    waitUntil(task);
  } catch {
    // Outside a request (tests): the task runs on its own.
  }
}
