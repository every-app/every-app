import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireAccountLock,
  knownLocks,
  liveLocks,
  rememberDeadRun,
  LOCK_STALE_MS,
  LockHeldError,
  readLastTeardownAt,
  recordTeardown,
  TEARDOWN_GAP_MS,
  affectsDns,
  teardownGapRemainingMs,
} from "./lock";

const ID = "0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "loop-lock-")),
    "locks",
  );
  dirs.push(path.dirname(dir));
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("lock", () => {
  it("takes the account's lock with O_EXCL and refuses a second taker with the holder", () => {
    const dir = tempDir();
    const now = Date.parse("2026-10-25T10:00:00Z");
    const lock = acquireAccountLock(dir, ID, "run-a", { now, host: "mac" });
    expect(fs.existsSync(lock.file)).toBe(true);
    expect((fs.statSync(lock.file).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(fs.readFileSync(lock.file, "utf8"))).toMatchObject({
      runId: "run-a",
      host: "mac",
      pid: process.pid,
    });
    try {
      acquireAccountLock(dir, ID, "run-b", { now: now + 1000 });
      throw new Error("took a held lock");
    } catch (error) {
      expect(error).toBeInstanceOf(LockHeldError);
      expect((error as LockHeldError).holder.runId).toBe("run-a");
    }
    lock.release();
    expect(fs.existsSync(lock.file)).toBe(false);
    expect(acquireAccountLock(dir, ID, "run-b", { now }).info.runId).toBe(
      "run-b",
    );
  });

  it("takes over a lock older than 3 hours, or an unreadable one", () => {
    const dir = tempDir();
    const now = Date.parse("2026-10-25T10:00:00Z");
    acquireAccountLock(dir, ID, "dead", { now: now - LOCK_STALE_MS - 1 });
    const lock = acquireAccountLock(dir, ID, "fresh", { now });
    expect(lock.info.runId).toBe("fresh");
    fs.writeFileSync(lock.file, "not json");
    expect(acquireAccountLock(dir, ID, "fresher", { now }).info.runId).toBe(
      "fresher",
    );
  });

  it("takes over a young lock whose process on this host is gone (a crashed driver), never another host's", () => {
    const dir = tempDir();
    const now = Date.parse("2026-10-25T10:00:00Z");
    const dead = acquireAccountLock(dir, ID, "crashed", { now: now - 1000 });
    // A pid no process has: `kill -0` says ESRCH.
    fs.writeFileSync(
      dead.file,
      JSON.stringify({ ...dead.info, pid: 2 ** 22 - 1 }),
    );
    const next = acquireAccountLock(dir, ID, "next", { now });
    expect(next.info.runId).toBe("next");
    next.release();
    const elsewhere = acquireAccountLock(dir, ID, "remote", {
      now: now - 1000,
      host: "another-mac",
    });
    fs.writeFileSync(
      elsewhere.file,
      JSON.stringify({ ...elsewhere.info, pid: 2 ** 22 - 1 }),
    );
    expect(() => acquireAccountLock(dir, ID, "mine", { now })).toThrow(
      /remote/,
    );
    expect(liveLocks(dir, now).map((l) => l.runId)).toEqual(["remote"]);
  });

  it("knows a live lock from a dead one, and remembers the dead runs a takeover or gc removed", () => {
    const dir = tempDir();
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(knownLocks(dir, now)).toEqual({ live: [], dead: [] });
    const crashed = acquireAccountLock(dir, ID, "crashed", { now: now - 1000 });
    fs.writeFileSync(
      crashed.file,
      JSON.stringify({ ...crashed.info, pid: 2 ** 22 - 1 }),
    );
    // A dead lock file still in the dir.
    expect(knownLocks(dir, now)).toEqual({ live: [], dead: ["crashed"] });
    // Taken over: the file is the new run's, the dead holder stays known through the state file.
    const next = acquireAccountLock(dir, ID, "next", { now });
    expect(knownLocks(dir, now)).toEqual({ live: ["next"], dead: ["crashed"] });
    // The state file keeps lastTeardownAt and the dead list side by side.
    recordTeardown(dir, ID, "2026-10-25T10:01:00.000Z");
    rememberDeadRun(dir, ID, "swept-by-gc");
    rememberDeadRun(dir, ID, "swept-by-gc");
    expect(readLastTeardownAt(dir, ID)).toBe("2026-10-25T10:01:00.000Z");
    expect(knownLocks(dir, now)).toEqual({
      live: ["next"],
      dead: ["crashed", "swept-by-gc"],
    });
    expect(
      (fs.statSync(path.join(dir, `${ID}.state.json`)).mode & 0o777).toString(
        8,
      ),
    ).toBe("600");
    next.release();
    // A lock older than 3 hours is dead too, whoever's host it is.
    const old = acquireAccountLock(dir, "f".repeat(32), "old", {
      now: now - LOCK_STALE_MS - 1,
      host: "another-mac",
    });
    expect(knownLocks(dir, now).dead).toEqual([
      "old",
      "crashed",
      "swept-by-gc",
    ]);
    old.release();
  });

  it("release removes only its own lock", () => {
    const dir = tempDir();
    const now = Date.parse("2026-10-25T10:00:00Z");
    const stale = acquireAccountLock(dir, ID, "stale", {
      now: now - LOCK_STALE_MS - 1,
    });
    const fresh = acquireAccountLock(dir, ID, "fresh", { now });
    stale.release();
    expect(fs.existsSync(fresh.file)).toBe(true);
    fresh.release();
    expect(fs.existsSync(fresh.file)).toBe(false);
  });

  it("records the last teardown and computes the 30-minute gap", () => {
    const dir = tempDir();
    expect(readLastTeardownAt(dir, ID)).toBeNull();
    expect(teardownGapRemainingMs(null)).toBe(0);
    const at = "2026-10-25T10:00:00.000Z";
    recordTeardown(dir, ID, at);
    expect(readLastTeardownAt(dir, ID)).toBe(at);
    const then = Date.parse(at);
    expect(teardownGapRemainingMs(at, then + 10 * 60 * 1000)).toBe(
      20 * 60 * 1000,
    );
    expect(teardownGapRemainingMs(at, then + TEARDOWN_GAP_MS)).toBe(0);
    expect(teardownGapRemainingMs("garbage", then)).toBe(0);
  });
});

describe("affectsDns", () => {
  it("is true for anything with a name in DNS, false for the kinds that touch none", () => {
    expect(affectsDns(['Worker "every-app-gateway"'])).toBe(true);
    expect(affectsDns(["certificate pack abc for apps.example.com"])).toBe(
      true,
    );
    expect(affectsDns(["DNS record A apps.example.com"])).toBe(true);
    expect(affectsDns(["Email Routing change: rule deleted"])).toBe(true);
    expect(
      affectsDns([
        'KV namespace "every-loop-run-2026"',
        'D1 database "every-app-gateway"',
        'R2 bucket "every-x"',
        'Hyperdrive config "every-x--DB"',
        'Workflow "every-x--w"',
        'Access application "Every App gateway"',
      ]),
    ).toBe(false);
    expect(affectsDns([])).toBe(false);
  });
});
