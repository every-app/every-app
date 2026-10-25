/**
 * Setting an organization's monthly cap on an app, against a migrated
 * SQLite database: its own app, a shared app (per organization), never
 * another organization's; clearing deletes the row; the row goes with the
 * app, deleted (its tombstone) or gone.
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
import { apps, members, orgAppSettings } from "@/db/schema";
import { checkMonthlyCap, clearAppCapCache } from "@/server/app-cap";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OrgAppSettingsRepository } from "@/server/repositories/OrgAppSettingsRepository";
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

  it("sets, changes and clears the cap on the organization's own app", async () => {
    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: 500 }),
    ).resolves.toEqual({ appRowId: chef, monthlyCallCap: 500 });
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(acme, chef),
    ).resolves.toBe(500);
    expect(await db.select().from(orgAppSettings)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: chef,
        monthlyCallCap: 500,
        updatedBy: acmeAdmin,
      }),
    ]);

    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 1_000_000_000,
    });
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(acme, chef),
    ).resolves.toBe(1_000_000_000);

    await expect(
      AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap: null }),
    ).resolves.toEqual({ appRowId: chef, monthlyCallCap: null });
    expect(await db.select().from(orgAppSettings)).toEqual([]);
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(acme, chef),
    ).resolves.toBeNull();
  });

  it("caps a shared app per organization, on the platform organization's row", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: openseo,
      cap: 20,
    });
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(acme, openseo),
    ).resolves.toBe(20);
    // Neither the platform organization nor another one is bound by it.
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(platform, openseo),
    ).resolves.toBeNull();
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(globex, openseo),
    ).resolves.toBeNull();
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

  it("refuses a cap outside 1 to a billion, or not a whole number", async () => {
    for (const cap of [0, -5, 2.5, 1_000_000_001, Number.NaN]) {
      await expect(
        AppCapService.setMonthlyCap(asAcmeAdmin(), { appRowId: chef, cap }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await db.select().from(orgAppSettings)).toEqual([]);
  });

  it("binds at once in this isolate: the cached cap is forgotten when it is set", async () => {
    const sources = {
      monthlyCallCap: OrgAppSettingsRepository.getMonthlyCap,
      monthlyCalls: UsageRepository.monthlyCalls,
    };
    // No cap: cached as such for the next seconds.
    await expect(checkMonthlyCap(sources, acme, chef)).resolves.toEqual({
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
    await expect(checkMonthlyCap(sources, acme, chef)).resolves.toMatchObject({
      exceeded: true,
      cap: 1,
      calls: 1,
    });
    // And forgotten again when cleared.
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: null,
    });
    await expect(checkMonthlyCap(sources, acme, chef)).resolves.toEqual({
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
    await expect(
      OrgAppSettingsRepository.getMonthlyCap(acme, chef),
    ).resolves.toBeNull();
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

  it("goes with the app row", async () => {
    await AppCapService.setMonthlyCap(asAcmeAdmin(), {
      appRowId: chef,
      cap: 7,
    });
    await db.delete(apps).where(eq(apps.id, chef));
    expect(await db.select().from(orgAppSettings)).toEqual([]);
  });
});
