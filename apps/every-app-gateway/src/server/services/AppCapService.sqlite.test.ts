/**
 * Setting an organization's caps against a migrated SQLite database: an
 * app's own cap, "no cap" for an app under a default, or neither (the
 * default applies); the default itself; the row invariant a reader keeps;
 * its own app, a shared app (per organization), never another
 * organization's; the rows go with the app, deleted (its tombstone) or
 * gone, and with the organization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: "https://gateway.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  },
  waitUntil: () => undefined,
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import {
  apps,
  members,
  organizations,
  orgAppSettings,
  orgSettings,
} from "@/db/schema";
import { checkMonthlyCap, clearAppCapCache } from "@/server/app-cap";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OrgAppSettingsRepository } from "@/server/repositories/OrgAppSettingsRepository";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import { AppCapService } from "@/server/services/AppCapService";
import { registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

describe("AppCapService (SQLite)", () => {
  let db: TestDb;
  let platform: string;
  let acme: string;
  let globex: string;
  let acmeAdmin: string;
  let chef: string;
  let openseo: string;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCapCache();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    platform = await seedOrganization(db, "every-app");
    await seedMember(db, { organizationId: platform, role: "owner" });
    acme = await seedOrganization(db, "acme");
    acmeAdmin = await seedMember(db, { organizationId: acme, role: "admin" });
    globex = await seedOrganization(db, "globex");
    await seedMember(db, { organizationId: globex, role: "owner" });
    chef = (await registerApp(db, { organizationId: acme, appSlug: "chef" }))
      .app.id;
    openseo = (
      await registerApp(db, {
        organizationId: platform,
        appSlug: "openseo",
        scope: "shared",
      })
    ).app.id;
  });

  const asAcmeAdmin = () => ({
    orgId: acme,
    userId: acmeAdmin,
    role: "admin" as const,
  });
  const effective = (orgId: string, appRowId: string) =>
    OrgAppSettingsRepository.getEffectiveMonthlyCaps(orgId, appRowId).then(
      (caps) => caps.calls,
    );
  const sources = () => ({
    effectiveMonthlyCaps: OrgAppSettingsRepository.getEffectiveMonthlyCaps,
    monthlyUsage: UsageRepository.monthlyUsage,
  });

  it("sets, changes and clears the cap on the organization's own app", async () => {
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: 500 }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCallCap: 500,
      capUnlimited: false,
      effectiveMonthlyCallCap: 500,
      capSource: "app",
      monthlyCostCapMicros: null,
      effectiveMonthlyCostCapMicros: null,
      costCapSource: null,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 500,
      source: "app",
    });
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: chef,
        monthlyCallCap: 500,
        unlimited: false,
        updatedBy: acmeAdmin,
      }),
    ]);

    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 1_000_000_000,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 1_000_000_000,
      source: "app",
    });

    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: null }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCallCap: null,
      capUnlimited: false,
      effectiveMonthlyCallCap: null,
      capSource: null,
      monthlyCostCapMicros: null,
      effectiveMonthlyCostCapMicros: null,
      costCapSource: null,
    });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: null,
      source: null,
    });
  });

  it("sets and clears the default, which binds every app without a row", async () => {
    await expect(
      AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 1_000 }),
    ).resolves.toEqual({
      defaultMonthlyCallCap: 1_000,
      defaultMonthlyCostCapMicros: null,
    });

    expect(await db.select().from(orgSettings)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        defaultMonthlyCallCap: 1_000,
        updatedBy: acmeAdmin,
      }),
    ]);
    await expect(
      OrgSettingsRepository.getDefaultMonthlyCaps(acme),
    ).resolves.toEqual({ cap: 1_000, costCapMicros: null });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 1_000,
      source: "default",
    });
    await expect(effective(acme, openseo)).resolves.toEqual({
      cap: 1_000,
      source: "default",
    });
    // Another organization's apps are not bound by acme's default.
    await expect(effective(globex, openseo)).resolves.toEqual({
      cap: null,
      source: null,
    });

    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 2_000 });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 2_000,
      source: "default",
    });

    await expect(
      AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: null }),
    ).resolves.toEqual({
      defaultMonthlyCallCap: null,
      defaultMonthlyCostCapMicros: null,
    });
    expect(await db.select().from(orgSettings)).toEqual([]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: null,
      source: null,
    });
  });

  it("keeps an app's own cap, none, or the default: the three states under a default", async () => {
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 1_000 });
    // Its own cap wins.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 50,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 50,
      source: "app",
    });
    // No cap at all, whatever the default.
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        cap: null,
        unlimited: true,
      }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCallCap: null,
      capUnlimited: true,
      effectiveMonthlyCallCap: null,
      capSource: null,
      monthlyCostCapMicros: null,
      effectiveMonthlyCostCapMicros: null,
      costCapSource: null,
    });
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({
        appRowId: chef,
        monthlyCallCap: null,
        unlimited: true,
      }),
    ]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: null,
      source: null,
    });
    // Back to the default: the row goes.
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: null }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCallCap: null,
      capUnlimited: false,
      effectiveMonthlyCallCap: 1_000,
      capSource: "default",
      monthlyCostCapMicros: null,
      effectiveMonthlyCostCapMicros: null,
      costCapSource: null,
    });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 1_000,
      source: "default",
    });
    // And a cap set over unlimited clears the flag in the same write.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: null,
      unlimited: true,
    });
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 70,
    });
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({ monthlyCallCap: 70, unlimited: false }),
    ]);
  });

  it("refuses a cap and unlimited together", async () => {
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        cap: 10,
        unlimited: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
  });

  it("lets a cap win on a row that says both, and lets a row that says neither fall through to the default", async () => {
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 1_000 });
    // A row no gateway writer makes (the CLI's raw SQL could): capped.
    await db.insert(orgAppSettings).values({
      organizationId: acme,
      appRowId: chef,
      monthlyCallCap: 5,
      unlimited: true,
      updatedAt: new Date(),
      updatedBy: null,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 5,
      source: "app",
    });
    // A row from before `unlimited` existed, cleared the old way: the default.
    await db
      .update(orgAppSettings)
      .set({ monthlyCallCap: null, unlimited: false })
      .where(eq(orgAppSettings.appRowId, chef));
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 1_000,
      source: "default",
    });
  });

  it("caps a shared app per organization, on the platform organization's row", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      cap: 20,
    });
    await expect(effective(acme, openseo)).resolves.toEqual({
      cap: 20,
      source: "app",
    });
    // Neither the platform organization nor another one is bound by it.
    await expect(effective(platform, openseo)).resolves.toEqual({
      cap: null,
      source: null,
    });
    await expect(effective(globex, openseo)).resolves.toEqual({
      cap: null,
      source: null,
    });
  });

  it("refuses another organization's app, a deleted app and an unknown row", async () => {
    const globexApp = (
      await registerApp(db, { organizationId: globex, appSlug: "payroll" })
    ).app.id;
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: globexApp,
        cap: 10,
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await db.update(apps).set({ status: "deleted" }).where(eq(apps.id, chef));
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: 10 }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: "app-nowhere",
        cap: 10,
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
  });

  it("refuses a cap or default outside 1 to a billion, or not a whole number", async () => {
    for (const cap of [0, -5, 2.5, 1_000_000_001, Number.NaN]) {
      await expect(
        AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    expect(await db.select().from(orgSettings)).toEqual([]);
  });

  it("binds at once in this isolate: the cached cap is forgotten when it is set", async () => {
    // No cap: cached as such for the next seconds.
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toEqual({
      exceeded: false,
    });
    await UsageRepository.record({
      organizationId: acme,
      appRowId: chef,
      userId: "",
      kind: "ai",
      target: "openai",
      calls: 1,
      status: 200,
    });
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 1,
    });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toMatchObject(
      {
        exceeded: true,
        calls: 1,
        reached: { kind: "calls", cap: 1, used: 1, source: "app" },
      },
    );
    // And forgotten again when cleared.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: null,
    });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toEqual({
      exceeded: false,
    });
  });

  it("binds a default at once too, for every app this isolate cached", async () => {
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toEqual({
      exceeded: false,
    });
    await expect(checkMonthlyCap(sources(), acme, openseo)).resolves.toEqual({
      exceeded: false,
    });
    await UsageRepository.record({
      organizationId: acme,
      appRowId: chef,
      userId: "",
      kind: "ai",
      target: "openai",
      calls: 1,
      status: 200,
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 1 });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toMatchObject(
      {
        exceeded: true,
        calls: 1,
        reached: { kind: "calls", cap: 1, used: 1, source: "default" },
      },
    );
    await expect(checkMonthlyCap(sources(), acme, openseo)).resolves.toEqual({
      exceeded: false,
      month: new Date().toISOString().slice(0, 7),
      calls: 0,
      costMicros: 0,
      caps: [{ kind: "calls", cap: 1, used: 0, source: "default" }],
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: null });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toEqual({
      exceeded: false,
    });
  });

  it("goes with the app when it is deleted, so its tombstone holds no cap", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 7,
    });
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      cap: 20,
    });
    const [row] = await db.select().from(apps).where(eq(apps.id, chef));
    await AppRepository.tombstone(row!);
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({ organizationId: acme, appRowId: openseo }),
    ]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: null,
      source: null,
    });
    // Nothing to clear on it any more, and nothing binds a redeploy.
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: null }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("goes with a shared app for every organization that capped it", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      cap: 20,
    });
    const globexOwner = (
      await db.select().from(members).where(eq(members.organizationId, globex))
    )[0]!.userId;
    await AppCapService.setMonthlyCap(
      { orgId: globex, userId: globexOwner, role: "owner" },
      { appRowId: openseo, cap: 5 },
    );
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 7,
    });
    const [row] = await db.select().from(apps).where(eq(apps.id, openseo));
    await AppRepository.tombstone(row!);
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({ organizationId: acme, appRowId: chef }),
    ]);
  });

  it("goes with the app row, and the default with the organization", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 7,
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 100 });
    await db.delete(apps).where(eq(apps.id, chef));
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    await db.delete(organizations).where(eq(organizations.id, acme));
    expect(await db.select().from(orgSettings)).toEqual([]);
  });

  describe("the dollar cap", () => {
    const caps = (orgId: string, appRowId: string) =>
      OrgAppSettingsRepository.getEffectiveMonthlyCaps(orgId, appRowId);

    it("sets an app's dollar cap beside its call cap, each kept when the other is set", async () => {
      await AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        cap: 500,
      });
      await expect(
        AppCapService.setMonthlyCap(asAcmeAdmin(), {
          appRowId: chef,
          costUsd: 12.5,
        }),
      ).resolves.toEqual({
        appRowId: chef,
        monthlyCallCap: 500,
        monthlyCostCapMicros: 12_500_000,
        capUnlimited: false,
        effectiveMonthlyCallCap: 500,
        capSource: "app",
        effectiveMonthlyCostCapMicros: 12_500_000,
        costCapSource: "app",
      });
      await AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        cap: null,
      });
      await expect(caps(acme, chef)).resolves.toEqual({
        calls: { cap: null, source: null },
        cost: { cap: 12_500_000, source: "app" },
      });
      // Both cleared: the row goes.
      await AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: null,
      });
      expect(await db.select().from(orgAppSettings)).toEqual([]);
    });

    it("refuses a dollar cap out of range or finer than a cent, with unlimited, and a call that names nothing", async () => {
      for (const costUsd of [0, 0.001, 12.345, 1_000_000.01, Number.NaN]) {
        await expect(
          AppCapService.setMonthlyCap(asAcmeAdmin(), {
            appRowId: chef,
            costUsd,
          }),
          String(costUsd),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(
          AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
      await expect(
        AppCapService.setMonthlyCap(asAcmeAdmin(), {
          appRowId: chef,
          costUsd: 5,
          unlimited: true,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), {}),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      // The ends of the range are taken.
      await AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: 0.01,
      });
      await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), {
        costUsd: 1_000_000,
      });
      await expect(caps(acme, chef)).resolves.toMatchObject({
        cost: { cap: 10_000, source: "app" },
      });
      await expect(caps(acme, openseo)).resolves.toMatchObject({
        cost: { cap: 1_000_000_000_000, source: "default" },
      });
    });

    it("ends unlimited with a dollar cap of the app's own, the call cap then following the default", async () => {
      await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), {
        cap: 1_000,
        costUsd: 20,
      });
      await AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        unlimited: true,
      });
      await expect(caps(acme, chef)).resolves.toEqual({
        calls: { cap: null, source: null },
        cost: { cap: null, source: null },
      });
      await AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: 50,
      });
      await expect(caps(acme, chef)).resolves.toEqual({
        calls: { cap: 1_000, source: "default" },
        cost: { cap: 50_000_000, source: "app" },
      });
    });

    it("keeps the other columns of org_settings: a dollar default beside the call default and the AI default, the row gone only when empty", async () => {
      await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { cap: 100 });
      await expect(
        AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 20 }),
      ).resolves.toEqual({
        defaultMonthlyCallCap: 100,
        defaultMonthlyCostCapMicros: 20_000_000,
      });
      await OrgSettingsRepository.setAiSettings({
        organizationId: acme,
        aiDefault: "openrouter",
        aiModels: null,
        updatedBy: acmeAdmin,
      });
      await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), {
        cap: null,
        costUsd: null,
      });
      expect(await db.select().from(orgSettings)).toEqual([
        expect.objectContaining({
          defaultMonthlyCallCap: null,
          defaultMonthlyCostCapMicros: null,
          aiDefault: "openrouter",
        }),
      ]);
      await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 5 });
      await OrgSettingsRepository.setAiSettings({
        organizationId: acme,
        aiDefault: null,
        aiModels: null,
        updatedBy: acmeAdmin,
      });
      // The dollar default alone keeps the row.
      expect(await db.select().from(orgSettings)).toHaveLength(1);
      await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), {
        costUsd: null,
      });
      expect(await db.select().from(orgSettings)).toEqual([]);
    });
  });
});
