import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const workerEnv = vi.hoisted(() => ({
  GATEWAY_URL: "https://gateway.example.com",
  APP_BASE_DOMAIN: undefined as string | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq, sql } from "drizzle-orm";
import {
  apps,
  organizationKeys,
  organizations,
  userAccessTokens,
  userAppAccess,
} from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";
import { AppService } from "@/server/services/AppService";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const TODO_MANIFEST = { id: "todo", resources: { d1: ["DB"], kv: ["KV"] } };

function register(
  organizationId: string,
  appSlug = "todo",
  extra: { workerName?: string; manifest?: unknown } = {},
) {
  return AppRegistrationService.register({
    organizationId,
    appSlug,
    name: "Todo",
    description: "Todos",
    manifest: appSlug === "todo" ? TODO_MANIFEST : { id: appSlug },
    ...extra,
  });
}

const reachable = async () => true;
const unreachable = async () => false;

describe("app deploy lifecycle (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let globex: string;
  let acmeOwner: string;
  let registry: DrizzleAppRegistry;

  beforeEach(async () => {
    workerEnv.GATEWAY_URL = "https://gateway.example.com";
    workerEnv.APP_BASE_DOMAIN = undefined;
    db = await createTestDb();
    testDb.current = db;
    acme = await seedOrganization(db, "acme");
    globex = await seedOrganization(db, "globex");
    acmeOwner = await seedMember(db, { organizationId: acme, role: "owner" });
    await seedMember(db, { organizationId: globex, role: "owner" });
    registry = new DrizzleAppRegistry(db as never);
  });

  it("keeps an app the pre-0027 gateway code registers mid-upgrade a legacy app", async () => {
    // An upgrade migrates before its code goes live, and the gateway that is
    // still serving writes rows without legacy_names.
    await db.run(sql`INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, manifest, status)
      VALUES ('row-1', ${acme}, 'notes', 'Notes', 'Notes', 'notes-acme.gateway.example.com', 'every-notes', 'service_binding', '{"id":"notes"}', 'active')`);

    const [row] = await db
      .select({ legacyNames: apps.legacyNames })
      .from(apps)
      .where(eq(apps.id, "row-1"));
    expect(row).toEqual({ legacyNames: true });
    // The new gateway redeploys it under its own name.
    await expect(
      register(acme, "notes", { manifest: { id: "notes" } }),
    ).resolves.toMatchObject({
      workerName: "every-notes",
      legacyNames: true,
      existingApp: true,
    });
  });

  it("writes org-scoped names for a new app explicitly", async () => {
    await register(acme);
    const [row] = await db
      .select({ legacyNames: apps.legacyNames })
      .from(apps)
      .where(eq(apps.appSlug, "todo"));
    expect(row).toEqual({ legacyNames: false });
  });

  it("walks a new app from pending through binding to active", async () => {
    const registered = await register(acme);
    expect(registered).toMatchObject({
      status: "pending",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
      resources: {
        d1: { DB: "every-acme-todo" },
        kv: { KV: "every-acme-todo" },
      },
      existingApp: false,
    });
    // Registered but not uploaded: routed as "deploying", never bound.
    await expect(
      registry.findByHostname("todo-acme.gateway.example.com"),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      AppRegistrationService.activate({
        organizationId: acme,
        appSlug: "todo",
        probe: reachable,
      }),
    ).rejects.toMatchObject({ status: 409, code: "NOT_DEPLOYED" });

    const deployedManifest = {
      ...TODO_MANIFEST,
      public: [{ path: "/health" }],
    };
    await expect(
      AppRegistrationService.markDeployed({
        organizationId: acme,
        appSlug: "todo",
        versionId: "version-1",
        manifest: deployedManifest,
      }),
    ).resolves.toEqual({
      status: "binding",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
    });
    const [row] = await db.select().from(apps);
    expect(row).toMatchObject({
      status: "binding",
      versionId: "version-1",
      manifest: JSON.stringify(deployedManifest),
    });
    expect(row?.deployedAt).toBeInstanceOf(Date);

    // The gateway version with its binding isn't serving yet.
    await expect(
      AppRegistrationService.activate({
        organizationId: acme,
        appSlug: "todo",
        probe: unreachable,
      }),
    ).rejects.toMatchObject({ status: 409, code: "BINDING_NOT_READY" });

    await expect(
      AppRegistrationService.activate({
        organizationId: acme,
        appSlug: "todo",
        probe: reachable,
      }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      registry.findByHostname("todo-acme.gateway.example.com"),
    ).resolves.toMatchObject({
      status: "active",
      workerName: "every-acme-todo",
    });
  });

  it("redeploys an active app without unbinding it, and its policy changes with the code", async () => {
    await register(acme);
    await AppRegistrationService.markDeployed({
      organizationId: acme,
      appSlug: "todo",
      versionId: "version-1",
      manifest: TODO_MANIFEST,
    });
    await AppRegistrationService.activate({
      organizationId: acme,
      appSlug: "todo",
      probe: reachable,
    });

    const newManifest = { ...TODO_MANIFEST, public: [{ path: "/health" }] };
    const redeploy = await register(acme, "todo", { manifest: newManifest });
    expect(redeploy).toMatchObject({
      status: "active",
      existingApp: true,
      previousManifest: TODO_MANIFEST,
    });
    // The new public route waits for the new code.
    const live = await registry.findByHostname("todo-acme.gateway.example.com");
    expect(live?.manifest.public).toBeUndefined();

    await expect(
      AppRegistrationService.markDeployed({
        organizationId: acme,
        appSlug: "todo",
        versionId: "version-2",
        manifest: newManifest,
      }),
    ).resolves.toMatchObject({ status: "active" });
    const updated = await registry.findByHostname(
      "todo-acme.gateway.example.com",
    );
    expect(updated?.manifest.public).toEqual([{ path: "/health" }]);
  });

  describe("with per-app Custom Domains (APP_BASE_DOMAIN)", () => {
    beforeEach(() => {
      workerEnv.GATEWAY_URL = "https://apps.example.com";
      workerEnv.APP_BASE_DOMAIN = "apps.example.com";
    });

    it("puts the install's own organization's apps one label below the base domain, others with their org key", async () => {
      // acme is the oldest organization with an owner (the setup claim's).
      await expect(register(acme)).resolves.toMatchObject({
        workerName: "every-acme-todo",
        hostname: "todo.apps.example.com",
      });
      await expect(register(globex)).resolves.toMatchObject({
        workerName: "every-globex-todo",
        hostname: "todo-globex.apps.example.com",
      });
      await expect(
        registry.findByHostname("todo.apps.example.com"),
      ).resolves.toMatchObject({ organizationId: acme, status: "pending" });
    });

    it("keeps hostnames assigned before, whatever the base domain says now", async () => {
      workerEnv.APP_BASE_DOMAIN = undefined;
      workerEnv.GATEWAY_URL = "https://gateway.example.com";
      await register(acme);

      workerEnv.APP_BASE_DOMAIN = "gateway.example.com";
      await expect(register(acme)).resolves.toMatchObject({
        hostname: "todo-acme.gateway.example.com",
        existingApp: true,
      });
      await expect(
        register(acme, "notes", { manifest: { id: "notes" } }),
      ).resolves.toMatchObject({ hostname: "notes.gateway.example.com" });
    });

    it("refuses a second organization's app whose host is the first's", async () => {
      // `todo-globex` of the install's organization takes the host globex's
      // `todo` would get.
      await register(acme, "todo-globex", {
        manifest: { id: "todo-globex" },
      });
      await expect(register(globex)).rejects.toMatchObject({
        status: 409,
        code: "HOSTNAME_TAKEN",
      });
    });

    it("refuses an app id too long for a DNS label", async () => {
      const appSlug = `a${"b".repeat(63)}`;
      await expect(
        register(acme, appSlug, { manifest: { id: appSlug } }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it("names Workers per organization, so two organizations can deploy the same app", async () => {
    const acmeTodo = await register(acme);
    const globexTodo = await register(globex);

    expect(acmeTodo.workerName).toBe("every-acme-todo");
    expect(globexTodo.workerName).toBe("every-globex-todo");
    expect(globexTodo.hostname).toBe("todo-globex.gateway.example.com");
    expect(
      (await db.select().from(organizationKeys))
        .map((row) => row.orgKey)
        .sort(),
    ).toEqual(["acme", "globex"]);
  });

  it("gives an organization a key once, numbered when another holds it, and keeps it after a rename", async () => {
    const acmeCo = await seedOrganization(db, "acme-co");
    const acmeco = await seedOrganization(db, "acmeco");

    expect((await register(acmeCo)).workerName).toBe("every-acmeco-todo");
    expect((await register(acmeco)).workerName).toBe("every-acmeco2-todo");

    await db
      .update(organizations)
      .set({ slug: "renamed" })
      .where(eq(organizations.id, acmeCo));
    expect((await register(acmeCo, "chef")).workerName).toBe(
      "every-acmeco-chef",
    );
  });

  it("keeps apps registered before org-scoped names on their every-<appId> names", async () => {
    await db.insert(apps).values({
      id: "legacy-row",
      organizationId: acme,
      appSlug: "todo",
      name: "Todo",
      description: "Todos",
      hostname: "todo-acme.gateway.example.com",
      workerName: "every-todo",
      manifest: JSON.stringify({ id: "todo" }),
      status: "active",
      legacyNames: true,
    });

    // An older CLI deriving the name itself still matches.
    await expect(
      register(acme, "todo", { workerName: "every-todo" }),
    ).resolves.toMatchObject({
      status: "active",
      workerName: "every-todo",
      legacyNames: true,
      resources: { d1: { DB: "every-todo" } },
    });
    // A new app in the same org gets an org-scoped name.
    expect((await register(acme, "chef")).workerName).toBe("every-acme-chef");
  });

  it("refuses names an older CLI derived for new apps, and the gateway's own", async () => {
    await expect(
      register(acme, "todo", { workerName: "every-todo" }),
    ).rejects.toMatchObject({ code: "WORKER_NAME_MISMATCH" });

    const app = await seedOrganization(db, "app");
    await expect(register(app, "gateway")).rejects.toMatchObject({
      code: "INVALID_WORKER_NAME",
    });
    await expect(register(app, "gateway-deploy")).rejects.toMatchObject({
      code: "INVALID_WORKER_NAME",
    });
    expect(await db.select().from(apps)).toEqual([]);
  });

  it("deletes an app as a tombstone that keeps its names reserved", async () => {
    const registered = await register(acme);
    await db.insert(userAccessTokens).values({
      id: "pat-1",
      userId: acmeOwner,
      organizationId: acme,
      appRowId: registered.appId,
      name: "agent",
      tokenHash: "hash",
      tokenPrefix: "epat_abcd",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await AppService.delete(
      { orgId: acme, userId: acmeOwner, role: "owner" },
      registered.appId,
    );

    const [row] = await db.select().from(apps);
    expect(row).toMatchObject({ status: "deleted", isDefault: false });
    expect(await db.select().from(userAppAccess)).toEqual([]);
    const [pat] = await db
      .select()
      .from(userAccessTokens)
      .where(eq(userAccessTokens.id, "pat-1"));
    expect(pat?.revokedAt).toBeInstanceOf(Date);

    // No longer routed or listed.
    await expect(
      registry.findByHostname("todo-acme.gateway.example.com"),
    ).resolves.toBeNull();
    await expect(
      AppService.getAllWithAccessCounts({
        orgId: acme,
        userId: acmeOwner,
        role: "owner",
      }),
    ).resolves.toEqual({ apps: [] });

    // Its own organization can redeploy it, under the same names, from
    // scratch: pending until the new upload is bound.
    await expect(register(acme)).resolves.toMatchObject({
      status: "pending",
      existingApp: true,
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
    });
  });

  it("deletes through the deploy API, and answers again for a resumed purge", async () => {
    await register(acme);

    const deleted = await AppRegistrationService.delete({
      organizationId: acme,
      appSlug: "todo",
    });
    expect(deleted).toEqual({
      status: "deleted",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
      legacyNames: false,
      resources: {
        d1: { DB: "every-acme-todo" },
        kv: { KV: "every-acme-todo" },
      },
    });
    await expect(
      AppRegistrationService.delete({ organizationId: acme, appSlug: "todo" }),
    ).resolves.toEqual(deleted);

    await expect(
      AppRegistrationService.markDeployed({
        organizationId: acme,
        appSlug: "todo",
        versionId: "v",
        manifest: TODO_MANIFEST,
      }),
    ).rejects.toMatchObject({ status: 404, code: "APP_NOT_FOUND" });
    await expect(
      AppRegistrationService.delete({
        organizationId: globex,
        appSlug: "todo",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("describes a live app's Worker and resources to its own organization only", async () => {
    await register(acme);

    await expect(
      AppRegistrationService.describe({
        organizationId: acme,
        appSlug: "todo",
      }),
    ).resolves.toEqual({
      status: "pending",
      workerName: "every-acme-todo",
      hostname: "todo-acme.gateway.example.com",
      legacyNames: false,
      resources: {
        d1: { DB: "every-acme-todo" },
        kv: { KV: "every-acme-todo" },
      },
    });
    await expect(
      AppRegistrationService.describe({
        organizationId: globex,
        appSlug: "todo",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the everyapp id for the gateway's own MCP tools", async () => {
    await expect(
      AppRegistrationService.register({
        organizationId: acme,
        appSlug: "everyapp",
        name: "Every App",
        description: "x",
        workerName: "every-everyapp",
        manifest: { id: "everyapp" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "RESERVED_APP_ID" });
    expect(await db.select().from(apps)).toEqual([]);
  });
});
