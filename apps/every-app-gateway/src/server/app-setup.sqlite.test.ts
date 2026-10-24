/**
 * "Needs setup" on the app lists, against a migrated SQLite database: an
 * app registered and deployed the way the CLI does it, its manifest's
 * providers, capabilities and secrets read back through the lists the
 * launcher (`getMyApps`, `/api/me/apps`) and Admin → Apps use, and
 * evaluated against this Worker's env and the secret names the CLI
 * recorded on the row.
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
// The evaluator itself, wrapped so one test can make it fail.
vi.mock("@/server/app-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/app-setup")>();
  return { ...actual, appSetupFor: vi.fn(actual.appSetupFor) };
});

import { eq } from "drizzle-orm";
import { apps } from "@/db/schema";
import { appSetupFor, resetAppSetupCacheForTests } from "@/server/app-setup";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppService } from "@/server/services/AppService";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const SEO = {
  id: "seo",
  providers: ["openrouter"],
  capabilities: { dataforseo: { access: "read", why: "Keyword data." } },
  secrets: [{ name: "MAIN_SECRET", why: "Signs report links." }],
};
// How an operator runs everyapp while publishing is paused (app-setup.ts keeps the same string).
const SETUP_CLI = "pnpm everyapp";
const SET_DATAFORSEO = `${SETUP_CLI} secret set DATAFORSEO_API_KEY`;

describe("app setup on the app lists (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let globex: string;
  let acmeOwner: string;
  let globexOwner: string;
  const ctx = (orgId: string, userId: string) => ({
    orgId,
    userId,
    role: "owner" as const,
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetAppSetupCacheForTests();
    for (const name of Object.keys(hoisted.env)) {
      if (name !== "GATEWAY_DEPLOYMENT_MODE") delete hoisted.env[name];
    }
    hoisted.env.OPENROUTER_API_KEY = "sk-or";
    db = await createTestDb();
    hoisted.testDb.current = db;
    acme = await seedOrganization(db, "acme");
    acmeOwner = await seedMember(db, { organizationId: acme, role: "owner" });
    globex = await seedOrganization(db, "globex");
    globexOwner = await seedMember(db, {
      organizationId: globex,
      role: "owner",
    });
  });

  async function myApp(orgId: string, userId: string, appId: string) {
    const { apps: listed } = await AppAccessService.getAppsForUser(
      ctx(orgId, userId),
    );
    const app = listed.find((each) => each.appId === appId);
    if (!app) throw new Error(`${appId} not listed for ${userId}`);
    return app;
  }

  async function adminApp(orgId: string, userId: string, appId: string) {
    const { apps: listed } = await AppService.getAllWithAccessCounts(
      ctx(orgId, userId),
    );
    const app = listed.find((each) => each.appId === appId);
    if (!app) throw new Error(`${appId} not in ${orgId}'s catalog`);
    return app;
  }

  it("says what the app still needs and the one command that opens it, from the Gateway's env and the recorded names", async () => {
    const { app } = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "seo",
      manifest: SEO,
      deployerUserId: acmeOwner,
    });

    // The Gateway has OpenRouter but no DataForSEO key; the app's own
    // secret names were never recorded, which never blocks.
    const unset = await myApp(acme, acmeOwner, "seo");
    expect(unset.setup).toMatchObject({ ready: false });
    expect(unset.setup!.unmet.map((setting) => setting.label)).toEqual([
      "DataForSEO",
    ]);
    expect(unset.setup!.unmet[0]).toMatchObject({
      names: ["DATAFORSEO_API_KEY"],
      why: "Keyword data.",
      docs: "https://app.dataforseo.com/api-access",
    });
    expect(unset.setup!.command).toEqual({ command: SET_DATAFORSEO });
    // The registry columns the evaluation read stay server-side.
    for (const column of ["manifest", "secretNames", "tier", "versionId"]) {
      expect(unset).not.toHaveProperty(column);
    }

    // The CLI recorded the Worker's secrets: none. Now the app's own
    // secret is unmet too, and the command sets it from anywhere.
    await db.update(apps).set({ secretNames: "[]" }).where(eq(apps.id, app.id));
    const recorded = await myApp(acme, acmeOwner, "seo");
    expect(recorded.setup!.unmet.map((setting) => setting.label)).toEqual([
      "DataForSEO",
      "MAIN_SECRET",
    ]);
    expect(recorded.setup!.command).toEqual({
      command: `${SET_DATAFORSEO} MAIN_SECRET --app seo`,
    });

    // Both set (the env is read fresh by a new isolate; here, a cleared
    // cache): ready, nothing to run.
    hoisted.env.DATAFORSEO_API_KEY = "login:password";
    await db
      .update(apps)
      .set({ secretNames: '["MAIN_SECRET"]' })
      .where(eq(apps.id, app.id));
    resetAppSetupCacheForTests();
    const ready = await myApp(acme, acmeOwner, "seo");
    expect(ready.setup).toMatchObject({ ready: true, command: null });
    expect(
      ready.setup!.settings.map((setting) => [setting.label, setting.set]),
    ).toEqual([
      ["OpenRouter", true],
      ["DataForSEO", true],
      ["MAIN_SECRET", true],
    ]);
  });

  it("carries it on the admin catalog too, with the command only for an organization that can run it", async () => {
    // Acme is the install organization: its shared app is listed for
    // Globex, whose admins can't set the platform's settings.
    await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "seo",
      manifest: SEO,
      scope: "shared",
      deployerUserId: acmeOwner,
    });

    const own = await adminApp(acme, acmeOwner, "seo");
    expect(own).toMatchObject({ readOnly: false });
    expect(own.setup).toMatchObject({
      ready: false,
      command: { command: SET_DATAFORSEO },
    });
    expect(own).not.toHaveProperty("versionId");

    const theirs = await adminApp(globex, globexOwner, "seo");
    expect(theirs).toMatchObject({ readOnly: true });
    expect(theirs.setup).toMatchObject({ ready: false, command: null });
    expect(theirs.setup!.unmet.map((setting) => setting.label)).toEqual([
      "DataForSEO",
    ]);

    const launcher = await myApp(globex, globexOwner, "seo");
    expect(launcher.setup).toMatchObject({ ready: false, command: null });
  });

  it("is null for an app with nothing to set", async () => {
    await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "todo",
      manifest: { id: "todo" },
      deployerUserId: acmeOwner,
    });
    expect((await myApp(acme, acmeOwner, "todo")).setup).toBeNull();
    expect((await adminApp(acme, acmeOwner, "todo")).setup).toBeNull();
  });

  it("keeps the list when one app's evaluation fails", async () => {
    await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "seo",
      manifest: SEO,
      deployerUserId: acmeOwner,
    });
    await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "todo",
      manifest: { id: "todo" },
      deployerUserId: acmeOwner,
    });
    // The list's order isn't fixed, so the failure picks its app by id.
    const actual =
      await vi.importActual<typeof import("@/server/app-setup")>(
        "@/server/app-setup",
      );
    vi.mocked(appSetupFor).mockImplementation(async (input, deps) => {
      if (input.appId === "seo") throw new Error("boom");
      return actual.appSetupFor(input, deps);
    });

    const { apps: listed } = await AppAccessService.getAppsForUser(
      ctx(acme, acmeOwner),
    );
    expect(listed.map((app) => app.appId).sort()).toEqual(["seo", "todo"]);
    expect(listed.every((app) => app.setup === null)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"evt":"app.setup_unavailable","appId":"seo"'),
    );

    // The next list evaluates again.
    vi.mocked(appSetupFor).mockImplementation(actual.appSetupFor);
    const { apps: again } = await AppAccessService.getAppsForUser(
      ctx(acme, acmeOwner),
    );
    expect(again.find((app) => app.appId === "seo")?.setup).toMatchObject({
      ready: false,
    });
  });
});
