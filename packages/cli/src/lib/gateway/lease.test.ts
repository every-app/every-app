import { beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import type { CfRunner } from "@/lib/cf/runner";
import { createSqliteD1, sqliteD1Script, type SqliteD1 } from "@/test/sqliteD1";
import { acquireLease, readLease, readLiveLeases } from "./lease";

const TTL = 3 * 60_000;

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

const take = (purpose: string) =>
  acquireLease({
    db,
    id: "gateway",
    purpose,
    now,
    sleep,
    heartbeatMs: 0,
    waitMs: 0,
  });

/** The SQLite database behind a switch that makes every request fail. */
function flaky() {
  const state = { failing: false };
  return {
    state,
    db: {
      run: (statements: Parameters<typeof db.run>[0]) =>
        state.failing ? Promise.reject(new Error("network down")) : db.run(statements),
    },
  };
}

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

  it("is taken over 3 minutes after its last renewal, and the old holder's release is a no-op", async () => {
    const crashed = await take("gateway.upgrade");
    clock += TTL - 1;
    await expect(take("gateway.reconcile")).rejects.toMatchObject({ code: "LEASE_HELD" });
    clock += 2;
    const next = await take("gateway.reconcile");

    await crashed.release();
    await expect(readLease(db, "gateway")).resolves.toMatchObject({
      holder: next.holder,
      purpose: "gateway.reconcile",
    });
  });

  it("waits out a holder that died, by default", async () => {
    const dead = await take("gateway.upgrade");
    const onWait = vi.fn();
    // No waitMs: the default outlasts the TTL plus a heartbeat.
    const next = await acquireLease({
      db,
      id: "gateway",
      purpose: "gateway.reconcile",
      now,
      sleep,
      heartbeatMs: 0,
      onWait,
    });
    expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ holder: dead.holder }));
    expect(next.holder).not.toBe(dead.holder);
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

  it("says who holds it, since when, and where to see it", async () => {
    const live = await take("gateway.upgrade");
    const since = new Date(clock).toISOString();
    const until = new Date(clock + TTL).toISOString();

    const held = await take("gateway.reconcile").catch((error: Error) => error);
    expect(held).toMatchObject({ code: "LEASE_HELD", retryable: true });
    expect((held as Error).message).toBe(
      `Another deploy is running: ${live.holder} has held the gateway deploy lease (gateway.upgrade) since ${since}; \`everyapp gateway status\` shows it while that deploy runs. If it died, the lease expires by ${until} and the next run takes it.`,
    );
  });

  it("lists the deploys running now, not those that died", async () => {
    // A deploy of another app that died.
    await acquireLease({ db, id: "app:every-acme-notes", purpose: "app.deploy", now, sleep, heartbeatMs: 0 });
    clock += TTL + 1;
    const gateway = await take("gateway.upgrade");
    clock += 1;
    const app = await acquireLease({ db, id: "app:every-acme-todo", purpose: "app.deploy", now, sleep, heartbeatMs: 0 });

    await expect(readLiveLeases(db, clock)).resolves.toEqual([
      { id: "gateway", holder: gateway.holder, purpose: "gateway.upgrade", acquiredAt: clock - 1, expiresAt: clock - 1 + TTL },
      { id: "app:every-acme-todo", holder: app.holder, purpose: "app.deploy", acquiredAt: clock, expiresAt: clock + TTL },
    ]);
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
        heartbeatMs: 30_000,
      });
      const before = (await readLease(db, "gateway"))!.expiresAt;
      clock += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await readLease(db, "gateway"))!.expiresAt).toBe(
        before + 30_000,
      );
      // A deploy that runs far longer than the TTL keeps it.
      for (let beat = 0; beat < 20; beat += 1) {
        clock += 30_000;
        await vi.advanceTimersByTimeAsync(30_000);
      }
      await expect(lease.check()).resolves.toBeUndefined();
      await lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("before a step that can't be undone", () => {
    it("goes on while it holds the lease, and renews it", async () => {
      const lease = await take("gateway.upgrade");
      clock += 60_000;
      await lease.check();
      expect((await readLease(db, "gateway"))!.expiresAt).toBe(clock + TTL);
    });

    it("stops once another deploy took the lease", async () => {
      const lease = await take("gateway.upgrade");
      clock += TTL + 1;
      const other = await take("gateway.reconcile");

      await expect(lease.check()).rejects.toMatchObject({
        code: "LEASE_LOST",
        retryable: true,
        message: expect.stringContaining("no longer this deploy's"),
      });
      // The other deploy's lease is left alone.
      await lease.release();
      await expect(readLease(db, "gateway")).resolves.toMatchObject({ holder: other.holder });
    });

    it("goes on through a short outage, and stops once renewals failed for half the TTL", async () => {
      const { state, db: unreliable } = flaky();
      const problems: string[] = [];
      const lease = await acquireLease({
        db: unreliable,
        id: "gateway",
        purpose: "gateway.upgrade",
        now,
        sleep,
        heartbeatMs: 0,
        onHeartbeatProblem: (message) => problems.push(message),
      });

      state.failing = true;
      clock += TTL / 2;
      await expect(lease.check()).resolves.toBeUndefined();
      expect(problems.at(-1)).toMatch(/Couldn't renew the gateway deploy lease \(network down\); it expires at/);

      clock += 1;
      await expect(lease.check()).rejects.toMatchObject({
        code: "LEASE_LOST",
        message: expect.stringMatching(/Couldn't renew the gateway deploy lease for 90 s \(network down\)/),
      });
      // It stays lost, even once D1 answers again.
      state.failing = false;
      await expect(lease.check()).rejects.toMatchObject({ code: "LEASE_LOST" });
    });

    it("hears from the heartbeat that the lease is lost, once", async () => {
      vi.useFakeTimers();
      try {
        const problems: string[] = [];
        const lease = await acquireLease({
          db,
          id: "gateway",
          purpose: "gateway.upgrade",
          now,
          sleep,
          heartbeatMs: 30_000,
          onHeartbeatProblem: (message) => problems.push(message),
        });

        db.sqlite.exec("DELETE FROM _everyapp_deploy_lease");
        await vi.advanceTimersByTimeAsync(90_000);
        expect(problems).toEqual([expect.stringMatching(/no longer this deploy's/)]);
        await expect(lease.check()).rejects.toMatchObject({ code: "LEASE_LOST" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("never runs two renewals at once", async () => {
    vi.useFakeTimers();
    try {
      let renewals = 0;
      let running = 0;
      let most = 0;
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const slow = {
        run: async (statements: Parameters<typeof db.run>[0]) => {
          if (!statements[0]!.sql.startsWith("UPDATE")) return db.run(statements);
          renewals += 1;
          running += 1;
          most = Math.max(most, running);
          await answered;
          running -= 1;
          return db.run(statements);
        },
      };
      const lease = await acquireLease({
        db: slow,
        id: "gateway",
        purpose: "gateway.upgrade",
        now,
        sleep,
        heartbeatMs: 30_000,
      });

      // The first heartbeat hangs; the next two, and a check, wait for it.
      await vi.advanceTimersByTimeAsync(90_000);
      const checked = lease.check();
      await vi.advanceTimersByTimeAsync(0);
      expect(renewals).toBe(1);
      answer();
      await checked;
      // The check renewed once more, after the one that hung.
      expect(renewals).toBe(2);
      expect(most).toBe(1);
      await lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each renewal 20 seconds, not the runner's two minutes", async () => {
    const fake = new FakeCf().on(["d1", "query"], sqliteD1Script({ "gateway-db": db }));
    const limits: Array<number | undefined> = [];
    const cf: CfRunner = {
      run: (call) => {
        limits.push(call.timeoutMs);
        return fake.run(call);
      },
      start: (call) => fake.start(call),
    };
    const lease = await acquireLease({
      db: cfD1Database(cf, "gateway-db"),
      id: "gateway",
      purpose: "gateway.upgrade",
      now,
      sleep,
      heartbeatMs: 0,
    });
    expect(limits).toEqual([undefined]);

    await lease.check();
    expect(limits).toEqual([undefined, 20_000]);
  });
});
