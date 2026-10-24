/**
 * One run per account at a time (design 4.2 step 1, must-fix 6): an O_EXCL
 * lock file `locks/<accountId>.json` holding pid, runId, startedAt and host,
 * stale after 3 hours; and the account's `lastTeardownAt`, so the next run
 * waits out Cloudflare's 30-minute SOA negative TTL before it reinstalls at
 * the same hostnames.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LockInfo {
  pid: number;
  runId: string;
  startedAt: string;
  host: string;
}

/** A lock older than this belongs to a run that died without releasing it. */
export const LOCK_STALE_MS = 3 * 60 * 60 * 1000;

/** Cloudflare's SOA minimum: how long a resolver may remember "no such name". */
export const TEARDOWN_GAP_MS = 30 * 60 * 1000;

export class LockHeldError extends Error {
  constructor(
    readonly file: string,
    readonly holder: LockInfo,
  ) {
    super(
      `Account locked by run ${holder.runId} (pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}): ${file}`,
    );
    this.name = "LockHeldError";
  }
}

interface AccountLock {
  file: string;
  info: LockInfo;
  release(): void;
}

interface LockOptions {
  now?: number;
  staleAfterMs?: number;
  host?: string;
}

const lockFile = (locksDir: string, accountId: string): string =>
  path.join(locksDir, `${accountId}.json`);

function readLock(file: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/** The holder's process is gone (same host only; another host's pid cannot be checked). */
function holderDead(holder: LockInfo, host: string): boolean {
  if (holder.host !== host || !Number.isInteger(holder.pid)) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** A lock is live when it is younger than the stale age and, on this host, its process still runs. */
export function lockIsLive(
  holder: LockInfo | null,
  now: number,
  options: LockOptions = {},
): holder is LockInfo {
  if (!holder) return false;
  const age = now - Date.parse(holder.startedAt);
  if (Number.isNaN(age) || age > (options.staleAfterMs ?? LOCK_STALE_MS))
    return false;
  return !holderDead(holder, options.host ?? os.hostname());
}

/** The runs that hold a live lock on any account: their containers belong to them. */
export function liveLocks(
  locksDir: string,
  now: number = Date.now(),
  options: LockOptions = {},
): LockInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(locksDir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!name.endsWith(".json") || name.endsWith(".state.json")) return [];
    const holder = readLock(path.join(locksDir, name));
    return lockIsLive(holder, now, options) ? [holder] : [];
  });
}

/**
 * Takes the account's lock with O_EXCL. A stale lock (older than 3 hours,
 * unreadable, or held by a process on this host that no longer exists) is
 * removed and taken over once; a live one throws LockHeldError, with the
 * holder.
 */
export function acquireAccountLock(
  locksDir: string,
  accountId: string,
  runId: string,
  options: LockOptions = {},
): AccountLock {
  const now = options.now ?? Date.now();
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const file = lockFile(locksDir, accountId);
  const info: LockInfo = {
    pid: process.pid,
    runId,
    startedAt: new Date(now).toISOString(),
    host: options.host ?? os.hostname(),
  };
  const take = (): boolean => {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!take()) {
    const holder = readLock(file);
    if (lockIsLive(holder, now, options)) throw new LockHeldError(file, holder);
    fs.rmSync(file, { force: true });
    if (!take()) throw new LockHeldError(file, readLock(file) ?? info);
  }
  return {
    file,
    info,
    release: () => {
      // Only our own lock: a stale takeover by someone else must not be removed.
      if (readLock(file)?.runId === runId) fs.rmSync(file, { force: true });
    },
  };
}

interface AccountState {
  lastTeardownAt: string | null;
}

const stateFile = (locksDir: string, accountId: string): string =>
  path.join(locksDir, `${accountId}.state.json`);

/** When the account was last wiped, or null when never recorded. */
export function readLastTeardownAt(
  locksDir: string,
  accountId: string,
): string | null {
  try {
    const state = JSON.parse(
      fs.readFileSync(stateFile(locksDir, accountId), "utf8"),
    ) as AccountState;
    return state.lastTeardownAt ?? null;
  } catch {
    return null;
  }
}

export function recordTeardown(
  locksDir: string,
  accountId: string,
  at: string,
): void {
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const state: AccountState = { lastTeardownAt: at };
  fs.writeFileSync(
    stateFile(locksDir, accountId),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Milliseconds still to wait before the account may be reinstalled; 0 when the gap has passed or nothing is recorded. */
export function teardownGapRemainingMs(
  lastTeardownAt: string | null,
  now: number = Date.now(),
  gapMs: number = TEARDOWN_GAP_MS,
): number {
  if (!lastTeardownAt) return 0;
  const elapsed = now - Date.parse(lastTeardownAt);
  if (Number.isNaN(elapsed)) return 0;
  return Math.max(0, gapMs - elapsed);
}
