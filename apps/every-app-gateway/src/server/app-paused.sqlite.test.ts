/**
 * "Paused" on the launcher's list against a migrated SQLite database: an
 * app the viewer's organization has at its monthly cap this month, by its
 * own cap or the workspace default, never one that is unlimited; a shared
 * app is paused for the organization whose count reached its cap, not for
 * another; a past month's count pauses nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  // Hosted: a shared app is listed for every organization.
  env: { GATEWAY_DEPLOYMENT_MODE: "hosted" } as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({ env: hoisted.env }));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(hoisted.testDb) };
});

import { UsageRepository } from "@/server/repositories/UsageRepository";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppCapService } from "@/server/services/AppCapService";
import { registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

describe("paused apps on the launcher (SQLite)", () => {
  let db: TestDb;
  let platform: string;
  let acme: string;
  let globex: string;
  let acmeOwner: string;
  let globexOwner: string;
  let chef: string;
  let todo: string;
  let openseo: string;

  beforeEach(async () => {
    db = await createTestDb();
    hoisted.testDb.current = db;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    platform = await seedOrganization(db, "every-app");
    await seedMember(db, { organizationId: platform, role: "owner" });
    acme = await seedOrganization(db, "acme");
    acmeOwner = await seedMember(db, { organizationId: acme, role: "owner" });
    globex = await seedOrganization(db, "globex");
    globexOwner = await seedMember(db, {
      organizationId: globex,
      role: "owner",
    });
    chef = (await registerApp(db, { organizationId: acme, appSlug: "chef" }))
      .app.id;
    todo = (await registerApp(db, { organizationId: acme, appSlug: "todo" }))
      .app.id;
    // Registration grants the organization's own apps to its members.
    openseo = (
      await registerApp(db, {
        organizationId: platform,
        appSlug: "openseo",
        scope: "shared",
        isInstallOrganization: true,
      })
    ).app.id;
  });

  const ctx = (orgId: string, userId: string) => ({
    orgId,
    userId,
    role: "owner" as const,
  });

  async function pausedFor(orgId: string, userId: string) {
    const { apps } = await AppAccessService.getAppsForUser(ctx(orgId, userId));
    return Object.fromEntries(apps.map((app) => [app.appId, app.paused]));
  }

  async function spend(
    orgId: string,
    appRowId: string,
    calls: number,
    at?: Date,
  ) {
    for (let i = 0; i < calls; i += 1) {
      await UsageRepository.record({
        organizationId: orgId,
        appRowId,
        userId: "",
        kind: "ai",
        target: "openai",
        calls: 1,
        status: 200,
        ...(at ? { at } : {}),
      });
    }
  }

  it("marks an app at its own cap, one at the default, and never an unlimited one", async () => {
    await expect(pausedFor(acme, acmeOwner)).resolves.toEqual({
      chef: false,
      todo: false,
      openseo: false,
    });
    await spend(acme, chef, 2);
    await spend(acme, todo, 2);
    await spend(acme, openseo, 2);
    // Nothing set: nothing pauses, whatever was spent.
    await expect(pausedFor(acme, acmeOwner)).resolves.toEqual({
      chef: false,
      todo: false,
      openseo: false,
    });

    const admin = ctx(acme, acmeOwner);
    await AppCapService.setDefaultMonthlyCap(admin, { cap: 2 });
    await AppCapService.setMonthlyCap(admin, { appRowId: chef, cap: 3 });
    await AppCapService.setMonthlyCap(admin, {
      appRowId: openseo,
      cap: null,
      unlimited: true,
    });
    await expect(pausedFor(acme, acmeOwner)).resolves.toEqual({
      chef: false,
      todo: true,
      openseo: false,
    });

    await spend(acme, chef, 1);
    await AppCapService.setMonthlyCap(admin, { appRowId: openseo, cap: null });
    await expect(pausedFor(acme, acmeOwner)).resolves.toEqual({
      chef: true,
      todo: true,
      openseo: true,
    });
  });

  it("pauses a shared app for the organization at its cap only, and not for a past month", async () => {
    await AppCapService.setMonthlyCap(ctx(acme, acmeOwner), {
      appRowId: openseo,
      cap: 1,
    });
    await spend(acme, openseo, 1);
    await spend(globex, openseo, 5);
    await expect(pausedFor(acme, acmeOwner)).resolves.toMatchObject({
      openseo: true,
    });
    await expect(pausedFor(globex, globexOwner)).resolves.toEqual({
      openseo: false,
    });

    // Last month's count against this month's cap pauses nothing.
    await AppCapService.setMonthlyCap(ctx(globex, globexOwner), {
      appRowId: openseo,
      cap: 1,
    });
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 15);
    await AppCapService.setMonthlyCap(ctx(acme, acmeOwner), {
      appRowId: todo,
      cap: 1,
    });
    await spend(acme, todo, 3, lastMonth);
    await expect(pausedFor(acme, acmeOwner)).resolves.toMatchObject({
      todo: false,
    });
    await expect(pausedFor(globex, globexOwner)).resolves.toEqual({
      openseo: true,
    });
  });
});
