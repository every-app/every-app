// EVERYAPP_DESKTOP_DEV_FRESH=1 (dev builds only): start Every App Dev on a brand-new, throwaway profile, so first
// run can be tested again: onboarding shows, no settings, no sign-in. It lives in the temp dir as
// everyapp-dev-fresh-*, is deleted on quit, and leftovers from a run that crashed are swept at the next
// fresh start. The normal Every App Dev profile is never read or written. Logs stay in ~/Library/Logs
// so a verification run can still read them. No Electron import (tested).

import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FRESH_PREFIX = "everyapp-dev-fresh-";

/** A new throwaway profile dir when asked for in a dev build, else undefined. Sweeps stale ones
 * (older than `staleMs`) first. */
export function freshProfileDir(env: NodeJS.ProcessEnv, devBuild: boolean, base = tmpdir(), now = Date.now(), staleMs = 60 * 60_000): string | undefined {
  if (!devBuild || env.EVERYAPP_DESKTOP_DEV_FRESH !== "1") return undefined;
  try {
    for (const name of readdirSync(base)) {
      if (!name.startsWith(FRESH_PREFIX)) continue;
      const dir = join(base, name);
      try {
        if (now - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true });
      } catch {
        // Someone else's or gone: leave it.
      }
    }
  } catch {
    // No temp dir listing: nothing to sweep.
  }
  return mkdtempSync(join(base, FRESH_PREFIX));
}

/** Deletes a throwaway profile (only ever one made by freshProfileDir). */
export function removeFreshProfile(dir: string | undefined): void {
  if (!dir || !dir.split(/[\\/]/).pop()?.startsWith(FRESH_PREFIX)) return;
  rmSync(dir, { recursive: true, force: true });
}
