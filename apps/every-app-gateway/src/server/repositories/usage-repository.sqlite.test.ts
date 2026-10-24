/**
 * The usage counters against a migrated SQLite database: each call adds
 * its deltas to the day's and the month's row, days and months are UTC,
 * the summary comes out three ways, and the hourly maintenance deletes
 * rows past their retention.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});
// The maintenance module loads the OAuth provider, a Workers-only import.
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));

import {
  apps,
  mcpToolCalls,
  orgAppSettings,
  usageDaily,
  usageMonthly,
} from "@/db/schema";
import { runMcpMaintenance } from "@/server/mcp-auth/maintenance";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import type { UsageEvent } from "@/server/usage-event";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const AT = new Date("2026-10-23T12:00:00.000Z");

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    organizationId: "org-acme",
    appRowId: "app-chef",
    userId: "user-1",
    kind: "ai",
    target: "openai",
    calls: 1,
    status: 200,
    at: AT,
    ...overrides,
  };
}

describe("UsageRepository (SQLite)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
  });

  it("adds what a body reported later to the call already counted, never another call or failure", async () => {
    // The call, the moment the provider answered: a 500, no tokens yet.
    await UsageRepository.record(event({ status: 500 }));
    // Its tail, read later: tokens only. The failure was already counted.
    await UsageRepository.record(
      event({ calls: 0, status: 500, inputTokens: 40, outputTokens: 2 }),
    );
    // A cost read off a capability body, likewise.
    await UsageRepository.record(
      event({
        calls: 0,
        kind: "capability",
        target: "dataforseo",
        costMicros: 1_250,
      }),
    );

    const daily = await db.select().from(usageDaily);
    expect(daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "openai",
          calls: 1,
          failures: 1,
          inputTokens: 40,
          outputTokens: 2,
        }),
        // No call was counted for this capability; its cost is still kept.
        expect.objectContaining({
          target: "dataforseo",
          calls: 0,
          failures: 0,
          costMicros: 1_250,
        }),
      ]),
    );
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({
        calls: 1,
        failures: 1,
        inputTokens: 40,
        outputTokens: 2,
        costMicros: 1_250,
      }),
    ]);
  });

  it("writes nothing for an addition with nothing to add", async () => {
    // A stream read to the end that reported no usage, or a body with no cost.
    await UsageRepository.record(event({ calls: 0 }));
    await UsageRepository.record(
      event({ calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 }),
    );
    expect(await db.select().from(usageDaily)).toEqual([]);
    expect(await db.select().from(usageMonthly)).toEqual([]);
  });

  it("adds each call's deltas to the day's row and the month's row", async () => {
    await UsageRepository.record(
      event({ inputTokens: 100, outputTokens: 20, costMicros: 0 }),
    );
    await UsageRepository.record(
      event({ inputTokens: 50, outputTokens: 5, status: 500 }),
    );
    // Another user on the same app: its own daily row, the same monthly row.
    await UsageRepository.record(
      event({
        userId: "",
        kind: "capability",
        target: "dataforseo",
        costMicros: 2_500,
      }),
    );

    const daily = await db.select().from(usageDaily);
    expect(daily).toHaveLength(2);
    expect(daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user-1",
          kind: "ai",
          target: "openai",
          day: "2026-10-23",
          calls: 2,
          failures: 1,
          inputTokens: 150,
          outputTokens: 25,
          costMicros: 0,
          updatedAt: AT,
        }),
        expect.objectContaining({
          userId: "",
          kind: "capability",
          target: "dataforseo",
          day: "2026-10-23",
          calls: 1,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 2_500,
        }),
      ]),
    );
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({
        organizationId: "org-acme",
        appRowId: "app-chef",
        month: "2026-10",
        calls: 3,
        failures: 1,
        inputTokens: 150,
        outputTokens: 25,
        costMicros: 2_500,
      }),
    ]);
  });

  it("keeps organizations and apps apart", async () => {
    await UsageRepository.record(event());
    await UsageRepository.record(event({ organizationId: "org-beta" }));
    await UsageRepository.record(event({ appRowId: "app-todo" }));
    const monthly = await db.select().from(usageMonthly);
    expect(
      monthly.map((row) => [row.organizationId, row.appRowId, row.calls]),
    ).toEqual(
      expect.arrayContaining([
        ["org-acme", "app-chef", 1],
        ["org-beta", "app-chef", 1],
        ["org-acme", "app-todo", 1],
      ]),
    );
    expect(monthly).toHaveLength(3);
  });

  it("files a call under its UTC day and month", async () => {
    await UsageRepository.record(
      event({ at: new Date("2026-10-31T23:59:59.999Z") }),
    );
    await UsageRepository.record(
      event({ at: new Date("2026-11-01T00:00:00.000Z") }),
    );
    const daily = await db.select().from(usageDaily);
    expect(daily.map((row) => [row.day, row.calls]).sort()).toEqual([
      ["2026-10-31", 1],
      ["2026-11-01", 1],
    ]);
    const monthly = await db.select().from(usageMonthly);
    expect(monthly.map((row) => [row.month, row.calls]).sort()).toEqual([
      ["2026-10", 1],
      ["2026-11", 1],
    ]);
  });

  it("never stores a negative or fractional count", async () => {
    await UsageRepository.record(
      event({ inputTokens: -5, outputTokens: 2.6, costMicros: Number.NaN }),
    );
    const [row] = await db.select().from(usageDaily);
    expect(row).toMatchObject({
      inputTokens: 0,
      outputTokens: 3,
      costMicros: 0,
    });
  });

  describe("summarize", () => {
    let acme: string;
    let owner: string;

    beforeEach(async () => {
      acme = await seedOrganization(db, "acme");
      owner = await seedMember(db, {
        organizationId: acme,
        role: "owner",
        email: "owner@acme.example",
      });
      await db.insert(apps).values({
        id: "app-chef",
        organizationId: acme,
        appSlug: "chef",
        name: "Chef",
        description: "",
      });
    });

    it("sums the month per app, per member and per target, with tool calls from the audit trail", async () => {
      const base = { organizationId: acme, at: AT };
      await UsageRepository.record(
        event({ ...base, userId: owner, inputTokens: 10, outputTokens: 2 }),
      );
      await UsageRepository.record(
        event({ ...base, userId: owner, status: 429, inputTokens: 0 }),
      );
      await UsageRepository.record(
        event({
          ...base,
          userId: "",
          kind: "capability",
          target: "dataforseo",
          costMicros: 1_200,
        }),
      );
      // An app whose row is gone still shows, by id.
      await UsageRepository.record(
        event({ ...base, appRowId: "app-gone", userId: "user-gone" }),
      );
      // Last month's call is not this month's.
      await UsageRepository.record(
        event({ ...base, userId: owner, at: new Date("2026-09-30T23:00:00Z") }),
      );
      const toolCall = (id: string, decision: string, createdAt = AT) => ({
        id,
        createdAt,
        organizationId: acme,
        userId: owner,
        credentialKind: "pat",
        credentialId: "pat_1",
        surface: "gateway",
        appRowId: "app-chef",
        appSlug: "chef",
        toolName: "chef_list",
        decision,
        outcome: decision === "allowed" ? "ok" : "refused",
      });
      await db
        .insert(mcpToolCalls)
        .values([
          toolCall("call-1", "allowed"),
          toolCall("call-2", "allowed"),
          toolCall("call-3", "blocked"),
          toolCall("call-4", "allowed", new Date("2026-11-01T00:00:00Z")),
        ]);

      const summary = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      expect(summary.month).toBe("2026-10");
      expect(summary.byApp).toEqual([
        {
          appRowId: "app-chef",
          name: "Chef",
          appSlug: "chef",
          calls: 3,
          failures: 1,
          inputTokens: 10,
          outputTokens: 2,
          costMicros: 1_200,
          toolCalls: 2,
          monthlyCallCap: null,
          callable: true,
        },
        {
          appRowId: "app-gone",
          name: null,
          appSlug: null,
          calls: 1,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          toolCalls: 0,
          monthlyCallCap: null,
          callable: false,
        },
      ]);
      expect(summary.byMember).toEqual([
        {
          userId: owner,
          name: expect.any(String),
          email: "owner@acme.example",
          calls: 2,
          failures: 1,
          inputTokens: 10,
          outputTokens: 2,
          costMicros: 0,
          toolCalls: 2,
        },
        expect.objectContaining({
          userId: "",
          name: null,
          email: null,
          calls: 1,
          costMicros: 1_200,
          toolCalls: 0,
        }),
        expect.objectContaining({ userId: "user-gone", calls: 1 }),
      ]);
      expect(summary.byTarget).toEqual([
        expect.objectContaining({ kind: "ai", target: "openai", calls: 3 }),
        expect.objectContaining({
          kind: "capability",
          target: "dataforseo",
          calls: 1,
          costMicros: 1_200,
        }),
      ]);
    });

    it("shows a person who has left the organization by id, never by the profile they keep elsewhere", async () => {
      // A member of another organization (in hosted mode, everyone keeps a
      // personal one) who used to be a member here: their row stays, their
      // name and email do not come along.
      const other = await seedOrganization(db, "other");
      const former = await seedMember(db, {
        organizationId: other,
        email: "former@personal.example",
      });
      await UsageRepository.record(
        event({ organizationId: acme, userId: former, at: AT }),
      );
      await db.insert(mcpToolCalls).values({
        id: "call-former",
        createdAt: AT,
        organizationId: acme,
        userId: former,
        credentialKind: "pat",
        credentialId: "pat_2",
        surface: "gateway",
        appRowId: "app-chef",
        appSlug: "chef",
        toolName: "chef_list",
        decision: "allowed",
        outcome: "ok",
      });
      // A current member shows by name, as before.
      await UsageRepository.record(
        event({ organizationId: acme, userId: owner, at: AT }),
      );

      const summary = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      expect(summary.byMember).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: former,
            name: null,
            email: null,
            calls: 1,
            toolCalls: 1,
          }),
          expect.objectContaining({
            userId: owner,
            email: "owner@acme.example",
            calls: 1,
          }),
        ]),
      );
      expect(summary.byMember).toHaveLength(2);
      // Their own organization's admins still see them by name.
      await UsageRepository.record(
        event({ organizationId: other, userId: former, at: AT }),
      );
      const theirs = await UsageRepository.summarize({
        organizationId: other,
        month: "2026-10",
      });
      expect(theirs.byMember).toEqual([
        expect.objectContaining({
          userId: former,
          email: "former@personal.example",
        }),
      ]);
    });

    it("shows an app agents used this month even before it called a provider", async () => {
      await db.insert(mcpToolCalls).values({
        id: "call-1",
        createdAt: AT,
        organizationId: acme,
        userId: owner,
        credentialKind: "session",
        credentialId: "session",
        surface: "app",
        appRowId: "app-chef",
        appSlug: "chef",
        toolName: "chef_list",
        decision: "allowed",
        outcome: "ok",
      });
      const summary = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      expect(summary.byApp).toEqual([
        expect.objectContaining({
          appRowId: "app-chef",
          calls: 0,
          toolCalls: 1,
        }),
      ]);
      expect(summary.byMember).toEqual([
        expect.objectContaining({ userId: owner, calls: 0, toolCalls: 1 }),
      ]);
      expect(summary.byTarget).toEqual([]);
    });

    it("carries each app's monthly cap, and lists a capped app that made no call", async () => {
      const other = await seedOrganization(db, "other");
      await db.insert(apps).values({
        id: "app-quiet",
        organizationId: acme,
        appSlug: "quiet",
        name: "Quiet",
        description: "",
      });
      await db.insert(orgAppSettings).values([
        {
          organizationId: acme,
          appRowId: "app-chef",
          monthlyCallCap: 5_000,
          updatedAt: AT,
          updatedBy: owner,
        },
        {
          organizationId: acme,
          appRowId: "app-quiet",
          monthlyCallCap: 10,
          updatedAt: AT,
          updatedBy: owner,
        },
        // Another organization's cap on the same app row is not this one's.
        {
          organizationId: other,
          appRowId: "app-chef",
          monthlyCallCap: 1,
          updatedAt: AT,
          updatedBy: null,
        },
      ]);
      await UsageRepository.record(event({ organizationId: acme, at: AT }));
      const summary = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      expect(summary.byApp).toEqual([
        expect.objectContaining({
          appRowId: "app-chef",
          calls: 1,
          monthlyCallCap: 5_000,
        }),
        {
          appRowId: "app-quiet",
          name: "Quiet",
          appSlug: "quiet",
          calls: 0,
          failures: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          toolCalls: 0,
          monthlyCallCap: 10,
          callable: true,
        },
      ]);
      // Caps are not the month's: a past month shows the same cap.
      const past = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-09",
      });
      expect(
        past.byApp.map((row) => [row.appRowId, row.monthlyCallCap]),
      ).toEqual([
        ["app-chef", 5_000],
        ["app-quiet", 10],
      ]);
    });

    it("lists every app the organization can call, with zeros before it spends", async () => {
      const platform = await seedOrganization(db, "every-app");
      const other = await seedOrganization(db, "other");
      await db.insert(apps).values([
        // The organization's own apps, one not deployed yet.
        {
          id: "app-quiet",
          organizationId: acme,
          appSlug: "quiet",
          name: "Quiet",
          description: "",
          status: "pending",
        },
        // A shared app, the platform organization's row.
        {
          id: "app-openseo",
          organizationId: platform,
          appSlug: "openseo",
          name: "OpenSEO",
          description: "",
          scope: "shared",
        },
        // Another organization's own app: not this organization's to see.
        {
          id: "app-theirs",
          organizationId: other,
          appSlug: "theirs",
          name: "Theirs",
          description: "",
        },
      ]);
      await db.insert(orgAppSettings).values({
        organizationId: acme,
        appRowId: "app-openseo",
        monthlyCallCap: 300,
        updatedAt: AT,
        updatedBy: owner,
      });
      await UsageRepository.record(event({ organizationId: acme, at: AT }));
      const summary = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      // The app that spent first, then the rest by name.
      expect(
        summary.byApp.map((row) => [
          row.appRowId,
          row.calls,
          row.monthlyCallCap,
          row.callable,
        ]),
      ).toEqual([
        ["app-chef", 1, null, true],
        ["app-openseo", 0, 300, true],
        ["app-quiet", 0, null, true],
      ]);
      // Nothing of the other tables: the zero rows are not usage.
      expect(summary.byMember).toHaveLength(1);
      expect(summary.byTarget).toHaveLength(1);
      // The same apps in a month nothing was counted.
      const past = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-09",
      });
      expect(past.byApp.map((row) => [row.appRowId, row.calls])).toEqual([
        ["app-chef", 0],
        ["app-openseo", 0],
        ["app-quiet", 0],
      ]);
      expect(past.byMember).toEqual([]);
    });

    it("drops a deleted app from the list, and never shows a cap on one", async () => {
      await db.insert(apps).values({
        id: "app-old",
        organizationId: acme,
        appSlug: "old",
        name: "Old",
        description: "",
        status: "deleted",
      });
      // A stale row (the delete paths remove it; the view never trusts that).
      await db.insert(orgAppSettings).values({
        organizationId: acme,
        appRowId: "app-old",
        monthlyCallCap: 100,
        updatedAt: AT,
        updatedBy: owner,
      });
      const quiet = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      expect(quiet.byApp.map((row) => row.appRowId)).toEqual(["app-chef"]);

      // In a month it spent, it shows as not callable, with no cap to clear.
      await UsageRepository.record(
        event({ organizationId: acme, appRowId: "app-old", at: AT }),
      );
      const spent = await UsageRepository.summarize({
        organizationId: acme,
        month: "2026-10",
      });
      expect(spent.byApp).toEqual([
        expect.objectContaining({
          appRowId: "app-old",
          name: "Old",
          calls: 1,
          monthlyCallCap: null,
          callable: false,
        }),
        expect.objectContaining({ appRowId: "app-chef", callable: true }),
      ]);
    });

    it("reads the month's calls for a cap from the one monthly row", async () => {
      await UsageRepository.record(event({ organizationId: acme, at: AT }));
      await UsageRepository.record(
        event({ organizationId: acme, at: AT, userId: "", status: 500 }),
      );
      await UsageRepository.record(
        event({
          organizationId: acme,
          at: new Date("2026-09-30T23:59:59.000Z"),
        }),
      );
      await expect(
        UsageRepository.monthlyCalls(acme, "app-chef", "2026-10"),
      ).resolves.toBe(2);
      await expect(
        UsageRepository.monthlyCalls(acme, "app-chef", "2026-09"),
      ).resolves.toBe(1);
      await expect(
        UsageRepository.monthlyCalls(acme, "app-chef", "2026-08"),
      ).resolves.toBe(0);
      await expect(
        UsageRepository.monthlyCalls("org-other", "app-chef", "2026-10"),
      ).resolves.toBe(0);
    });

    it("is empty for another organization and refuses a malformed month", async () => {
      await UsageRepository.record(event({ organizationId: acme, at: AT }));
      const other = await UsageRepository.summarize({
        organizationId: "org-other",
        month: "2026-10",
      });
      expect(other).toEqual({
        month: "2026-10",
        byApp: [],
        byMember: [],
        byTarget: [],
      });
      await expect(
        UsageRepository.summarize({ organizationId: acme, month: "2026-13" }),
      ).rejects.toThrow("not a month");
    });
  });

  describe("retention", () => {
    it("deletes daily rows past 13 months and monthly rows past 25", async () => {
      const now = new Date("2026-10-23T03:00:00Z");
      const at = (iso: string) => new Date(iso);
      await UsageRepository.record(event({ at: at("2025-08-31T23:59:59Z") }));
      await UsageRepository.record(event({ at: at("2025-09-01T00:00:00Z") }));
      await UsageRepository.record(event({ at: at("2024-08-31T23:59:59Z") }));
      await UsageRepository.record(event({ at: at("2024-09-01T00:00:00Z") }));
      await UsageRepository.record(event({ at: now }));

      expect(await UsageRepository.deleteOlderThan(now)).toEqual({
        daily: 3,
        monthly: 1,
        done: true,
      });
      expect(
        (await db.select({ day: usageDaily.day }).from(usageDaily)).map(
          (row) => row.day,
        ),
      ).toEqual(["2025-09-01", "2026-10-23"]);
      expect(
        (await db.select({ month: usageMonthly.month }).from(usageMonthly)).map(
          (row) => row.month,
        ),
      ).toEqual(["2024-09", "2025-08", "2025-09", "2026-10"]);
      expect(await UsageRepository.deleteOlderThan(now)).toEqual({
        daily: 0,
        monthly: 0,
        done: true,
      });
    });

    it("deletes in batches of a thousand rows and picks up where it stopped", async () => {
      const now = new Date("2026-10-23T03:00:00Z");
      // A month's worth of daily rows past the retention, and one live row.
      const expired = Array.from({ length: 2_100 }, (_, index) => ({
        organizationId: `org-${index % 70}`,
        appRowId: `app-${index % 3}`,
        userId: `user-${index}`,
        kind: "ai",
        target: "openai",
        day: `2025-08-${String(1 + (index % 28)).padStart(2, "0")}`,
        calls: 1,
        updatedAt: now,
      }));
      for (let start = 0; start < expired.length; start += 100) {
        await db.insert(usageDaily).values(expired.slice(start, start + 100));
      }
      await UsageRepository.record(event({ at: now }));
      await UsageRepository.record(
        event({ at: new Date("2024-08-15T00:00:00Z") }),
      );

      // One statement per table: a thousand daily rows, the one monthly row.
      expect(await UsageRepository.deleteOlderThan(now, 1)).toEqual({
        daily: 1_000,
        monthly: 1,
        done: false,
      });
      expect(await db.select().from(usageDaily)).toHaveLength(1_102);
      // The next run finishes the job.
      expect(await UsageRepository.deleteOlderThan(now)).toEqual({
        daily: 1_101,
        monthly: 0,
        done: true,
      });
      expect(
        (await db.select({ day: usageDaily.day }).from(usageDaily)).map(
          (row) => row.day,
        ),
      ).toEqual(["2026-10-23"]);
    });

    it("runs in the hourly maintenance, with its counts in the summary line", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const now = new Date("2026-10-23T03:00:00Z");
      await UsageRepository.record(
        event({ at: new Date("2024-01-15T00:00:00Z") }),
      );
      await UsageRepository.record(event({ at: now }));
      await runMcpMaintenance({} as Cloudflare.Env, now);
      const line = log.mock.calls
        .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
        .find((entry) => entry["evt"] === "mcp.maintenance");
      expect(line).toMatchObject({
        usage_daily_deleted: 1,
        usage_monthly_deleted: 1,
      });
      expect(await db.select().from(usageDaily)).toHaveLength(1);
      expect(await db.select().from(usageMonthly)).toHaveLength(1);
    });
  });
});
