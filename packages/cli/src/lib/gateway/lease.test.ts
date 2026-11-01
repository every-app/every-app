import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { FakeCf } from "@/lib/cf/fakeCf";
import type { CfRunner } from "@/lib/cf/runner";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { createSqliteD1, sqliteD1Script, type SqliteD1 } from "@/test/sqliteD1";
import {
  acquireLease,
  describeLeaseHolder,
  LeasePurpose,
  readLease,
  readLiveLeases,
} from "./lease";

const TTL = 3 * 60_000;
const MACHINE = os.hostname().split(".")[0];

let db: SqliteD1;
let clock: number;
let events: any[];
let out: EventSink;
const now = () => clock;
const sleep = async (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  db = createSqliteD1();
  clock = 1_000_000;
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
});

const take = (purpose: LeasePurpose, app?: string) =>
  acquireLease({
    db,
    id: "gateway",
    purpose,
    ...(app ? { app } : {}),
    out,
    step: "gateway.lease",
    now,
    sleep,
    heartbeatMs: 0,
    waitMs: 0,
  });

const warnings = () =>
  events.filter((event) => event.type === "warning").map((event) => event.message as string);

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
  it("lets one of two deploys hold it, and says who has it while the other waits", async () => {
    const first = await take(LeasePurpose.GatewayUpgrade);

    await expect(
      acquireLease({
        db,
        id: "gateway",
        purpose: LeasePurpose.GatewayReconcile,
        out,
        step: "gateway.lease",
        now,
        sleep,
        heartbeatMs: 0,
        waitMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: "LEASE_HELD", retryable: true });
    expect(events[0]).toMatchObject({
      type: "progress",
      step: "gateway.lease",
      message: `Waiting for a Gateway upgrade to finish (${MACHINE}, started 0s ago)`,
      data: { holder: { holder: first.holder, purpose: "gateway.upgrade" } },
    });
    // Different leases don't block each other.
    await expect(
      acquireLease({
        db,
        id: "app:every-acme-todo",
        purpose: LeasePurpose.AppDeploy,
        app: "todo",
        out,
        step: "app.lease",
        now,
        sleep,
        heartbeatMs: 0,
      }),
    ).resolves.toMatchObject({ id: "app:every-acme-todo" });
  });

  it("is free again once its holder releases it", async () => {
    const first = await take(LeasePurpose.GatewayUpgrade);
    await first.release();
    await expect(take(LeasePurpose.GatewayReconcile)).resolves.toBeTruthy();
  });

  it("is taken over 3 minutes after its last renewal, and the old holder's release is a no-op", async () => {
    const crashed = await take(LeasePurpose.GatewayUpgrade);
    clock += TTL - 1;
    await expect(take(LeasePurpose.GatewayReconcile)).rejects.toMatchObject({ code: "LEASE_HELD" });
    clock += 2;
    const next = await take(LeasePurpose.GatewayReconcile);

    await crashed.release();
    await expect(readLease(db, "gateway")).resolves.toMatchObject({
      holder: next.holder,
      purpose: "gateway.reconcile",
    });
  });

  it("waits out a holder that died, by default, and says the wait is over", async () => {
    const dead = await take(LeasePurpose.GatewayUpgrade);
    // No waitMs: the default outlasts the TTL plus a heartbeat.
    const next = await acquireLease({
      db,
      id: "gateway",
      purpose: LeasePurpose.GatewayReconcile,
      out,
      step: "gateway.lease",
      now,
      sleep,
      heartbeatMs: 0,
    });
    expect(events[0]).toMatchObject({ type: "progress", data: { holder: { holder: dead.holder } } });
    expect(events.at(-1)).toMatchObject({
      type: "step",
      step: "gateway.lease",
      status: "ok",
      data: { waitedFor: "Gateway upgrade" },
    });
    expect(next.holder).not.toBe(dead.holder);
  });

  it("waits for a holder that finishes", async () => {
    const first = await take(LeasePurpose.GatewayUpgrade);
    let waits = 0;
    const second = acquireLease({
      db,
      id: "gateway",
      purpose: LeasePurpose.GatewayReconcile,
      out,
      step: "gateway.lease",
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

  it("says what the holder does, who runs it on which machine, and since when", async () => {
    await acquireLease({
      db,
      id: "app:every-acme-todo",
      purpose: LeasePurpose.AppDeploy,
      app: "todo",
      out,
      step: "app.lease",
      now,
      sleep,
      heartbeatMs: 0,
    });
    clock += 60_000;

    const held = await acquireLease({
      db,
      id: "app:every-acme-todo",
      purpose: LeasePurpose.AppSecrets,
      app: "todo",
      out,
      step: "app.lease",
      now,
      sleep,
      heartbeatMs: 0,
      waitMs: 0,
    }).catch((error: Error) => error);
    expect(held).toMatchObject({
      code: "LEASE_HELD",
      retryable: true,
      rerunNote: "once it's done (pnpm everyapp status shows it)",
    });
    expect((held as Error).message).toBe(
      `A deploy of todo is still running after 0s\nIt's from ${MACHINE}. If it stopped without cleaning up, it's released within 2m.`,
    );
    const lease = (await readLease(db, "app:every-acme-todo"))!;
    expect(describeLeaseHolder({ ...lease, deployer: "ben@example.com" }, clock)).toBe(
      `a deploy of todo from ben@example.com on ${MACHINE}, started 1m ago`,
    );
  });

  it("reads a row an older everyapp wrote, and adds the new columns to its table in place", async () => {
    db.sqlite.exec(`CREATE TABLE _everyapp_deploy_lease (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, purpose TEXT NOT NULL,
      acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    db.sqlite
      .prepare("INSERT INTO _everyapp_deploy_lease VALUES (?, ?, ?, ?, ?)")
      .run("gateway", "Bens-MacBook-Pro.local:48211:9f3a1c2e", "gateway.upgrade", clock, clock + TTL);

    const lease = (await readLease(db, "gateway"))!;
    expect(lease).toMatchObject({ app: null, deployer: null, machine: "Bens-MacBook-Pro" });
    expect(describeLeaseHolder(lease, clock + 120_000)).toBe(
      "a Gateway upgrade from Bens-MacBook-Pro, started 2m ago",
    );
    expect(db.all("PRAGMA table_info(_everyapp_deploy_lease)").map((column) => column["name"])).toEqual([
      "id",
      "holder",
      "purpose",
      "acquired_at",
      "expires_at",
      "app",
      "deployer",
      "machine",
    ]);
  });

  it("lists the deploys running now, not those that died", async () => {
    // A deploy of another app that died.
    const app = (id: string, name: string) =>
      acquireLease({
        db,
        id,
        purpose: LeasePurpose.AppDeploy,
        app: name,
        out,
        step: "app.lease",
        now,
        sleep,
        heartbeatMs: 0,
      });
    await app("app:every-acme-notes", "notes");
    clock += TTL + 1;
    const gateway = await take(LeasePurpose.GatewayUpgrade);
    clock += 1;
    const todo = await app("app:every-acme-todo", "todo");

    await expect(readLiveLeases(db, clock)).resolves.toEqual([
      {
        id: "gateway",
        holder: gateway.holder,
        purpose: "gateway.upgrade",
        acquiredAt: clock - 1,
        expiresAt: clock - 1 + TTL,
        app: null,
        deployer: null,
        machine: MACHINE,
      },
      {
        id: "app:every-acme-todo",
        holder: todo.holder,
        purpose: "app.deploy",
        acquiredAt: clock,
        expiresAt: clock + TTL,
        app: "todo",
        deployer: null,
        machine: MACHINE,
      },
    ]);
  });

  it("renews itself while its holder works", async () => {
    vi.useFakeTimers();
    try {
      const lease = await acquireLease({
        db,
        id: "gateway",
        purpose: LeasePurpose.GatewayUpgrade,
        out,
        step: "gateway.lease",
        now,
        sleep,
        heartbeatMs: 30_000,
      });
      const before = (await readLease(db, "gateway"))!.expiresAt;
      clock += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await readLease(db, "gateway"))!.expiresAt).toBe(before + 30_000);
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
      const lease = await take(LeasePurpose.GatewayUpgrade);
      clock += 60_000;
      await lease.check();
      expect((await readLease(db, "gateway"))!.expiresAt).toBe(clock + TTL);
    });

    it("stops once another deploy took the lease", async () => {
      const lease = await take(LeasePurpose.GatewayUpgrade);
      clock += TTL + 1;
      const other = await take(LeasePurpose.GatewayReconcile);

      await expect(lease.check()).rejects.toMatchObject({
        code: "LEASE_LOST",
        retryable: true,
        message: expect.stringContaining("Stopped: this run lost its hold on the Gateway"),
      });
      // The other deploy's lease is left alone.
      await lease.release();
      await expect(readLease(db, "gateway")).resolves.toMatchObject({ holder: other.holder });
    });

    it("goes on through a short outage, warning, and stops once renewals failed for half the TTL", async () => {
      const { state, db: unreliable } = flaky();
      const lease = await acquireLease({
        db: unreliable,
        id: "app:every-acme-todo",
        purpose: LeasePurpose.AppEmail,
        app: "todo",
        out,
        step: "app.lease",
        now,
        sleep,
        heartbeatMs: 0,
      });

      state.failing = true;
      clock += TTL / 2;
      await expect(lease.check()).resolves.toBeUndefined();
      expect(warnings()).toEqual([
        "Can't reach Cloudflare to keep hold of todo (2m so far)\nnetwork down. Another run can take over in 2m if this continues.",
      ]);

      clock += 1;
      await expect(lease.check()).rejects.toMatchObject({ code: "LEASE_LOST" });
      // It stays lost, even once D1 answers again.
      state.failing = false;
      await expect(lease.check()).rejects.toMatchObject({ code: "LEASE_LOST" });
    });

    it("hears from the heartbeat that the lease is lost, once", async () => {
      vi.useFakeTimers();
      try {
        const lease = await acquireLease({
          db,
          id: "gateway",
          purpose: LeasePurpose.GatewayUpgrade,
          out,
          step: "gateway.lease",
          now,
          sleep,
          heartbeatMs: 30_000,
        });

        db.sqlite.exec("DELETE FROM _everyapp_deploy_lease");
        await vi.advanceTimersByTimeAsync(90_000);
        expect(warnings()).toEqual([expect.stringMatching(/^This run lost its hold on the Gateway\n/)]);
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
        purpose: LeasePurpose.GatewayUpgrade,
        out,
        step: "gateway.lease",
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
      purpose: LeasePurpose.GatewayUpgrade,
      out,
      step: "gateway.lease",
      now,
      sleep,
      heartbeatMs: 0,
    });
    // The table (created, then its columns read), then the lease taken.
    expect(limits).toEqual([undefined, undefined]);

    await lease.check();
    expect(limits).toEqual([undefined, undefined, 20_000]);
  });
});
