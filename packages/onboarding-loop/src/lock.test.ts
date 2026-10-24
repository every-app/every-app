import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireAccountLock,
  liveLocks,
  LOCK_STALE_MS,
  LockHeldError,
  readLastTeardownAt,
  recordTeardown,
  TEARDOWN_GAP_MS,
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
