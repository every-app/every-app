/**
 * Setting an organization's dollar caps against a migrated SQLite database:
 * an app's own cap, "no cap" for an app under a default, or neither (the
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
    OrgAppSettingsRepository.getEffectiveMonthlyCap(orgId, appRowId);
  const sources = () => ({
    effectiveMonthlyCap: OrgAppSettingsRepository.getEffectiveMonthlyCap,
    monthlyCostMicros: UsageRepository.monthlyCostMicros,
  });
  /** One call that cost `micros`, counted against chef this month. */
  const spend = (micros: number) =>
    UsageRepository.record({
      organizationId: acme,
      appRowId: chef,
      userId: "",
      kind: "ai",
      target: "openrouter",
      calls: 1,
      costMicros: micros,
      status: 200,
    });

  it("sets, changes and clears the cap on the organization's own app", async () => {
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: 12.5,
      }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCostCapMicros: 12_500_000,
      capUnlimited: false,
      effectiveMonthlyCostCapMicros: 12_500_000,
      costCapSource: "app",
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 12_500_000,
      source: "app",
    });
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: chef,
        monthlyCostCapMicros: 12_500_000,
        unlimited: false,
        updatedBy: acmeAdmin,
      }),
    ]);

    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 1_000_000,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 1_000_000_000_000,
      source: "app",
    });

    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: null,
      }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCostCapMicros: null,
      capUnlimited: false,
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
      AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 20 }),
    ).resolves.toEqual({ defaultMonthlyCostCapMicros: 20_000_000 });

    expect(await db.select().from(orgSettings)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        defaultMonthlyCostCapMicros: 20_000_000,
        updatedBy: acmeAdmin,
      }),
    ]);
    await expect(
      OrgSettingsRepository.getDefaultMonthlyCap(acme),
    ).resolves.toBe(20_000_000);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 20_000_000,
      source: "default",
    });
    await expect(effective(acme, openseo)).resolves.toEqual({
      cap: 20_000_000,
      source: "default",
    });
    // Another organization's apps are not bound by acme's default.
    await expect(effective(globex, openseo)).resolves.toEqual({
      cap: null,
      source: null,
    });

    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 40 });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 40_000_000,
      source: "default",
    });

    await expect(
      AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: null }),
    ).resolves.toEqual({ defaultMonthlyCostCapMicros: null });
    expect(await db.select().from(orgSettings)).toEqual([]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: null,
      source: null,
    });
  });

  it("keeps an app's own cap, none, or the default: the three states under a default", async () => {
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 20 });
    // Its own cap wins.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 5,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 5_000_000,
      source: "app",
    });
    // No cap at all, whatever the default.
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: null,
        unlimited: true,
      }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCostCapMicros: null,
      capUnlimited: true,
      effectiveMonthlyCostCapMicros: null,
      costCapSource: null,
    });
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({
        appRowId: chef,
        monthlyCostCapMicros: null,
        unlimited: true,
      }),
    ]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: null,
      source: null,
    });
    // Back to the default: the row goes.
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: null,
      }),
    ).resolves.toEqual({
      appRowId: chef,
      monthlyCostCapMicros: null,
      capUnlimited: false,
      effectiveMonthlyCostCapMicros: 20_000_000,
      costCapSource: "default",
    });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 20_000_000,
      source: "default",
    });
    // And a cap set over unlimited clears the flag in the same write.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      unlimited: true,
    });
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 7,
    });
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({
        monthlyCostCapMicros: 7_000_000,
        unlimited: false,
      }),
    ]);
  });

  it("refuses a cap and unlimited together, and a call that names neither", async () => {
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: 10,
        unlimited: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
  });

  it("lets a cap win on a row that says both", async () => {
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 20 });
    // A row no gateway writer makes (the CLI's raw SQL could): capped.
    await db.insert(orgAppSettings).values({
      organizationId: acme,
      appRowId: chef,
      monthlyCostCapMicros: 5_000_000,
      unlimited: true,
      updatedAt: new Date(),
      updatedBy: null,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 5_000_000,
      source: "app",
    });
  });

  it("caps a shared app per organization, on the platform organization's row", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      costUsd: 20,
    });
    await expect(effective(acme, openseo)).resolves.toEqual({
      cap: 20_000_000,
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
        costUsd: 10,
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await db.update(apps).set({ status: "deleted" }).where(eq(apps.id, chef));
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: 10,
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: "app-nowhere",
        costUsd: 10,
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
  });

  it("refuses a cap or default out of range or finer than a cent, and takes the ends of the range", async () => {
    for (const costUsd of [0, -5, 0.001, 12.345, 1_000_000.01, Number.NaN]) {
      await expect(
        AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, costUsd }),
        String(costUsd),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    expect(await db.select().from(orgSettings)).toEqual([]);
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 0.01,
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), {
      costUsd: 1_000_000,
    });
    await expect(effective(acme, chef)).resolves.toEqual({
      cap: 10_000,
      source: "app",
    });
    await expect(effective(acme, openseo)).resolves.toEqual({
      cap: 1_000_000_000_000,
      source: "default",
    });
  });

  it("binds at once in this isolate: the cached cap is forgotten when it is set", async () => {
    // No cap: cached as such for the next seconds.
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toEqual({
      exceeded: false,
    });
    await spend(1_000_000);
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 1,
    });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toMatchObject(
      {
        exceeded: true,
        standing: { cap: 1_000_000, used: 1_000_000, source: "app" },
      },
    );
    // And forgotten again when cleared.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: null,
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
    await spend(1_000_000);
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 1 });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toMatchObject(
      {
        exceeded: true,
        standing: { cap: 1_000_000, used: 1_000_000, source: "default" },
      },
    );
    await expect(checkMonthlyCap(sources(), acme, openseo)).resolves.toEqual({
      exceeded: false,
      month: new Date().toISOString().slice(0, 7),
      standing: { cap: 1_000_000, used: 0, source: "default" },
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: null });
    await expect(checkMonthlyCap(sources(), acme, chef)).resolves.toEqual({
      exceeded: false,
    });
  });

  it("goes with the app when it is deleted, so its tombstone holds no cap", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 7,
    });
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      costUsd: 20,
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
      AppCapService.setMonthlyCap(asAcmeAdmin(), {
        appRowId: chef,
        costUsd: null,
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });

  it("goes with a shared app for every organization that capped it", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      costUsd: 20,
    });
    const globexOwner = (
      await db.select().from(members).where(eq(members.organizationId, globex))
    )[0]!.userId;
    await AppCapService.setMonthlyCap(
      { orgId: globex, userId: globexOwner, role: "owner" },
      { appRowId: openseo, costUsd: 5 },
    );
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      costUsd: 7,
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
      costUsd: 7,
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 100 });
    await db.delete(apps).where(eq(apps.id, chef));
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    await db.delete(organizations).where(eq(organizations.id, acme));
    expect(await db.select().from(orgSettings)).toEqual([]);
  });

  it("keeps the other columns of org_settings: the default beside the AI default, the row gone only when empty", async () => {
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: 20 });
    await OrgSettingsRepository.setAiSettings({
      organizationId: acme,
      aiDefault: "openrouter",
      aiModels: null,
      updatedBy: acmeAdmin,
    });
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: null });
    expect(await db.select().from(orgSettings)).toEqual([
      expect.objectContaining({
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
    // The cap default alone keeps the row.
    expect(await db.select().from(orgSettings)).toHaveLength(1);
    await AppCapService.setDefaultMonthlyCap(asAcmeAdmin(), { costUsd: null });
    expect(await db.select().from(orgSettings)).toEqual([]);
  });
});
