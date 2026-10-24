/**
 * One run per account at a time (design 4.2 step 1, must-fix 6): an O_EXCL
 * lock file `locks/<accountId>.json` holding pid, runId, startedAt and host,
 * stale after 3 hours; the account's `lastTeardownAt`, so the next run
 * waits out Cloudflare's 30-minute SOA negative TTL before it reinstalls at
 * the same hostnames; and the runs whose lock on the account died here
 * (`deadRunIds`), so the wipe knows their in-account marker is a dead
 * driver's and not a run on another machine.
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

const isLockFile = (name: string): boolean =>
  name.endsWith(".json") && !name.endsWith(".state.json");

/** Every lock file in the dir, live or not. */
function readLocks(locksDir: string): LockInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(locksDir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!isLockFile(name)) return [];
    const holder = readLock(path.join(locksDir, name));
    return holder && typeof holder.runId === "string" ? [holder] : [];
  });
}

/** The runs that hold a live lock on any account: their containers belong to them. */
export function liveLocks(
  locksDir: string,
  now: number = Date.now(),
  options: LockOptions = {},
): LockInfo[] {
  return readLocks(locksDir).filter((holder) =>
    lockIsLive(holder, now, options),
  );
}

/** What this machine knows about the runs whose marker a wipe may find. */
export interface KnownLocks {
  /** Holding a live lock: a driver still running, its marker and containers in use. */
  live: string[];
  /**
   * Their lock died here: a stale file still in the dir, or one a later run
   * took over (acquireAccountLock) or gc swept. A SIGKILLed driver's marker
   * is theirs, stale whatever its age. A run on another machine, or under
   * another EVERYAPP_LOOP_HOME, is in neither list.
   */
  dead: string[];
}

export function knownLocks(
  locksDir: string,
  now: number = Date.now(),
  options: LockOptions = {},
): KnownLocks {
  const live: string[] = [];
  const dead: string[] = [];
  for (const holder of readLocks(locksDir))
    (lockIsLive(holder, now, options) ? live : dead).push(holder.runId);
  let names: string[] = [];
  try {
    names = fs.readdirSync(locksDir);
  } catch {
    // No dir: nothing known.
  }
  for (const name of names) {
    if (!name.endsWith(".state.json")) continue;
    for (const runId of readState(
      locksDir,
      name.slice(0, -".state.json".length),
    ).deadRunIds)
      if (!dead.includes(runId)) dead.push(runId);
  }
  return { live, dead };
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
    const deadRunId = holder?.runId ?? null;
    if (lockIsLive(holder, now, options)) throw new LockHeldError(file, holder);
    fs.rmSync(file, { force: true });
    // The dead holder is remembered: its marker in the account is a dead driver's, not another machine's.
    if (deadRunId) rememberDeadRun(locksDir, accountId, deadRunId);
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
  /** The runs whose lock on this account was found dead and removed, newest last. */
  deadRunIds: string[];
}

/** Dead runs remembered per account; older ones have long lost their marker to a wipe. */
const DEAD_RUNS_KEPT = 20;

const stateFile = (locksDir: string, accountId: string): string =>
  path.join(locksDir, `${accountId}.state.json`);

function readState(locksDir: string, accountId: string): AccountState {
  try {
    const state = JSON.parse(
      fs.readFileSync(stateFile(locksDir, accountId), "utf8"),
    ) as Partial<AccountState>;
    return {
      lastTeardownAt: state.lastTeardownAt ?? null,
      deadRunIds: Array.isArray(state.deadRunIds)
        ? state.deadRunIds.filter((id) => typeof id === "string")
        : [],
    };
  } catch {
    return { lastTeardownAt: null, deadRunIds: [] };
  }
}

function writeState(
  locksDir: string,
  accountId: string,
  state: AccountState,
): void {
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    stateFile(locksDir, accountId),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** When the account was last wiped, or null when never recorded. */
export function readLastTeardownAt(
  locksDir: string,
  accountId: string,
): string | null {
  return readState(locksDir, accountId).lastTeardownAt;
}

/** A dead lock was removed (a takeover, gc): its run goes in the account's dead list for knownLocks. */
export function rememberDeadRun(
  locksDir: string,
  accountId: string,
  runId: string,
): void {
  const state = readState(locksDir, accountId);
  if (state.deadRunIds.includes(runId)) return;
  state.deadRunIds = [...state.deadRunIds, runId].slice(-DEAD_RUNS_KEPT);
  writeState(locksDir, accountId, state);
}

/**
 * Whether a wipe could have left negative DNS caches behind: it removed a
 * Worker (its Custom Domains with it), a certificate pack, a DNS record or
 * an Email Routing change. KV, D1, R2, Hyperdrive, Workflows and Access
 * items touch no name, so a wipe of those alone (the loop's own run marker,
 * say) needs no 30-minute gap.
 */
const DNS_NEUTRAL =
  /^(KV namespace|D1 database|R2 bucket|Hyperdrive config|Workflow|Access )/;
export function affectsDns(removed: readonly string[]): boolean {
  return removed.some((item) => !DNS_NEUTRAL.test(item));
}

export function recordTeardown(
  locksDir: string,
  accountId: string,
  at: string,
): void {
  writeState(locksDir, accountId, {
    ...readState(locksDir, accountId),
    lastTeardownAt: at,
  });
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
