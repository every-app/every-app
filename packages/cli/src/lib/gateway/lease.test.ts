import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1, type SqliteD1 } from "@/test/sqliteD1";
import { acquireLease, confirmLeaseBreak, readLease } from "./lease";

let db: SqliteD1;
let clock: number;
const now = () => clock;
const sleep = async (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  db = createSqliteD1();
  clock = 1_000_000;
});

const take = (purpose: string, options: { waitMs?: number; breakLease?: boolean } = {}) =>
  acquireLease({
    db,
    id: "gateway",
    purpose,
    now,
    sleep,
    heartbeatMs: 0,
    waitMs: options.waitMs ?? 0,
    breakLease: options.breakLease ? async () => true : undefined,
  });

describe("deploy lease", () => {
  it("lets one of two deploys hold it, and says who has it", async () => {
    const first = await take("gateway.upgrade");
    const onWait = vi.fn();

    await expect(
      acquireLease({
        db,
        id: "gateway",
        purpose: "gateway.reconcile",
        now,
        sleep,
        heartbeatMs: 0,
        waitMs: 10_000,
        onWait,
      }),
    ).rejects.toMatchObject({ code: "LEASE_HELD", retryable: true });
    expect(onWait).toHaveBeenCalledWith(
      expect.objectContaining({
        holder: first.holder,
        purpose: "gateway.upgrade",
      }),
    );
    // Different leases don't block each other.
    await expect(
      acquireLease({ db, id: "app:every-acme-todo", purpose: "app.deploy", now, sleep, heartbeatMs: 0 }),
    ).resolves.toMatchObject({ id: "app:every-acme-todo" });
  });

  it("is free again once its holder releases it", async () => {
    const first = await take("gateway.upgrade");
    await first.release();
    await expect(take("gateway.reconcile")).resolves.toBeTruthy();
  });

  it("is taken over once it expires, and the old holder's release is a no-op", async () => {
    const crashed = await take("gateway.upgrade");
    clock += 10 * 60_000 + 1;
    const next = await take("gateway.reconcile");

    await crashed.release();
    await expect(readLease(db, "gateway")).resolves.toMatchObject({
      holder: next.holder,
      purpose: "gateway.reconcile",
    });
  });

  it("waits for a holder that finishes", async () => {
    const first = await take("gateway.upgrade");
    let waits = 0;
    const second = acquireLease({
      db,
      id: "gateway",
      purpose: "app.reconcile",
      now,
      heartbeatMs: 0,
      waitMs: 60_000,
      sleep: async (ms) => {
        clock += ms;
        if ((waits += 1) === 2) await first.release();
      },
    });
    await expect(second).resolves.toMatchObject({ id: "gateway" });
    expect(waits).toBe(2);
  });

  it("breaks a live lease on request", async () => {
    await take("gateway.upgrade");
    const taken = await take("gateway.upgrade", { breakLease: true });
    await expect(readLease(db, "gateway")).resolves.toMatchObject({
      holder: taken.holder,
    });
  });

  it("breaks a live lease only for the holder it was confirmed for", async () => {
    const live = await take("gateway.upgrade");
    const asked = vi.fn(async () => false);

    await expect(
      acquireLease({ db, id: "gateway", purpose: "gateway.reconcile", now, sleep, heartbeatMs: 0, breakLease: asked }),
    ).rejects.toMatchObject({ code: "LEASE_HELD" });
    expect(asked).toHaveBeenCalledWith(
      expect.objectContaining({ holder: live.holder, purpose: "gateway.upgrade" }),
    );
    await expect(readLease(db, "gateway")).resolves.toMatchObject({ holder: live.holder });

    // An expired lease is simply taken: nobody is asked.
    clock += 10 * 60_000 + 1;
    const never = vi.fn(async () => false);
    await expect(
      acquireLease({ db, id: "gateway", purpose: "gateway.reconcile", now, sleep, heartbeatMs: 0, breakLease: never }),
    ).resolves.toBeTruthy();
    expect(never).not.toHaveBeenCalled();
  });

  it("needs --yes to break a lease unattended", async () => {
    const current = { holder: "laptop:42:abcd", purpose: "gateway.upgrade", acquiredAt: 0, expiresAt: 1 };
    expect(confirmLeaseBreak({ breakLease: false, interactive: false })).toBeUndefined();
    await expect(
      confirmLeaseBreak({ breakLease: true, interactive: false })!(current),
    ).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      message: expect.stringContaining("laptop:42:abcd"),
    });
    await expect(
      confirmLeaseBreak({ breakLease: true, yes: true, interactive: false })!(current),
    ).resolves.toBe(true);
  });

  it("says when a heartbeat fails, or finds the lease taken", async () => {
    vi.useFakeTimers();
    try {
      const problems: string[] = [];
      let failing = false;
      const flaky = {
        run: (statements: Parameters<typeof db.run>[0]) =>
          failing ? Promise.reject(new Error("network down")) : db.run(statements),
      };
      await acquireLease({
        db: flaky,
        id: "gateway",
        purpose: "gateway.upgrade",
        now,
        sleep,
        heartbeatMs: 60_000,
        onHeartbeatProblem: (message) => problems.push(message),
      });

      failing = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(problems.at(-1)).toMatch(/Couldn't renew the gateway deploy lease \(network down\)/);

      failing = false;
      db.sqlite.exec("DELETE FROM _everyapp_deploy_lease");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(problems.at(-1)).toMatch(/was taken over/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews itself while its holder works", async () => {
    vi.useFakeTimers();
    try {
      const lease = await acquireLease({
        db,
        id: "gateway",
        purpose: "gateway.upgrade",
        now,
        sleep,
        heartbeatMs: 60_000,
      });
      const before = (await readLease(db, "gateway"))!.expiresAt;
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await readLease(db, "gateway"))!.expiresAt).toBe(
        before + 60_000,
      );
      await lease.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
