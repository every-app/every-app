/**
 * An app's life in the gateway's registry, against a migrated SQLite
 * database: the CLI's writes (registration, upload, delete) as
 * `src/test/registry.ts` makes them with the perimeter's rules, and what the
 * gateway does with the rows: route them, activate them, list them, delete
 * them from the admin UI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://apps.example.com" },
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import { UnroutableAppError } from "@every-app/perimeter";
import { apps, userAccessTokens, userAppAccess } from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { activateApp } from "@/server/app-activation";
import { AppService } from "@/server/services/AppService";
import { markAppDeployed, registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const TODO_MANIFEST = { id: "todo", resources: { d1: ["DB"], kv: ["KV"] } };
const HOST = "todo.apps.example.com";
// What a gateway version that binds the app has, in self-host.
const BOUND = {
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  "APP__every-acme-todo": { fetch: async () => new Response("ok") },
};

describe("app lifecycle (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let globex: string;
  let acmeOwner: string;
  let registry: DrizzleAppRegistry;
  const ownerCtx = () => ({
    orgId: acme,
    userId: acmeOwner,
    role: "owner" as const,
  });
  const lookup = () => registry.findByHostname(HOST);

  function register(
    organizationId: string,
    appSlug = "todo",
    manifest: unknown = appSlug === "todo" ? TODO_MANIFEST : { id: appSlug },
  ) {
    return registerApp(db, {
      organizationId,
      appSlug,
      name: "Todo",
      description: "Todos",
      manifest,
      deployerUserId: acmeOwner,
    });
  }

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    db = await createTestDb();
    testDb.current = db;
    acme = await seedOrganization(db, "acme");
    globex = await seedOrganization(db, "globex");
    acmeOwner = await seedMember(db, { organizationId: acme, role: "owner" });
    await seedMember(db, { organizationId: globex, role: "owner" });
    registry = new DrizzleAppRegistry(db as never);
  });

  it("walks a new app from pending through binding to active", async () => {
    const registered = await register(acme);
    expect(registered).toMatchObject({
      kind: "new",
      app: {
        status: "pending",
        workerName: "every-acme-todo",
        hostname: HOST,
      },
    });
    // Registered but not uploaded: routed as "deploying", never activated,
    // whatever this isolate's bindings say.
    const pending = (await lookup())!;
    expect(pending).toMatchObject({
      status: "pending",
      rowId: registered.app.id,
    });
    await expect(activateApp(BOUND, pending)).resolves.toBe(false);

    const deployedManifest = {
      ...TODO_MANIFEST,
      public: [{ path: "/health" }],
    };
    await markAppDeployed(db, registered.app.id, {
      versionId: "version-1",
      manifest: deployedManifest,
      actor: "ben@example.com",
    });
    const [row] = await db.select().from(apps);
    expect(row).toMatchObject({
      status: "binding",
      versionId: "version-1",
      deployedByActor: "ben@example.com",
      manifest: JSON.stringify(deployedManifest),
    });
    expect(row?.deployedAt).toBeInstanceOf(Date);

    const uploaded = (await lookup())!;
    expect(uploaded).toMatchObject({
      status: "binding",
      versionId: "version-1",
    });
    // An isolate still on the gateway version from before the bind.
    await expect(
      activateApp({ GATEWAY_DEPLOYMENT_MODE: "self_hosted" }, uploaded),
    ).resolves.toBe(false);
    await expect(activateApp(BOUND, uploaded)).resolves.toBe(true);
    await expect(lookup()).resolves.toMatchObject({
      status: "active",
      workerName: "every-acme-todo",
    });
    // Another isolate that read the row as binding agrees.
    await expect(activateApp(BOUND, uploaded)).resolves.toBe(true);

    // Switched off meanwhile: never switched back on.
    await db.update(apps).set({ status: "disabled" });
    await expect(activateApp(BOUND, uploaded)).resolves.toBe(false);
    await expect(lookup()).resolves.toMatchObject({ status: "disabled" });
  });

  it("registers an organization's own app, and never routes a row with a tier or scope it doesn't know", async () => {
    const { app } = await register(acme);
    await expect(lookup()).resolves.toMatchObject({
      tier: "service_binding",
      scope: "org",
    });

    // A hand-edited row: unroutable (a 503 at the perimeter), never read
    // as some other tier or scope.
    for (const odd of [{ tier: "dispatch_v2" }, { scope: "public" }]) {
      await db
        .update(apps)
        .set({ tier: "service_binding", scope: "org", ...odd })
        .where(eq(apps.id, app.id));
      await expect(lookup()).rejects.toBeInstanceOf(UnroutableAppError);
    }
  });

  it("redeploys an active app without unbinding it, and its policy changes with the code", async () => {
    const { app } = await register(acme);
    await markAppDeployed(db, app.id, {
      versionId: "version-1",
      manifest: TODO_MANIFEST,
    });
    await activateApp(BOUND, (await lookup())!);

    const newManifest = { ...TODO_MANIFEST, public: [{ path: "/health" }] };
    await expect(register(acme, "todo", newManifest)).resolves.toMatchObject({
      kind: "existing",
      app: { status: "active" },
      previousManifest: TODO_MANIFEST,
      versionId: "version-1",
    });
    // The new public route waits for the new code.
    expect((await lookup())?.manifest.public).toBeUndefined();

    await markAppDeployed(db, app.id, {
      versionId: "version-2",
      manifest: newManifest,
    });
    await expect(lookup()).resolves.toMatchObject({
      status: "active",
      versionId: "version-2",
      manifest: { public: [{ path: "/health" }] },
    });
  });

  it("lists who deployed an app in the admin catalog", async () => {
    const { app } = await register(acme);
    await markAppDeployed(db, app.id, {
      versionId: "version-1",
      manifest: TODO_MANIFEST,
      actor: "api-token:0123456789abcdef",
    });

    const { apps: listed } =
      await AppService.getAllWithAccessCounts(ownerCtx());
    expect(listed).toEqual([
      expect.objectContaining({
        appId: "todo",
        deployedByActor: "api-token:0123456789abcdef",
        accessCount: 1,
      }),
    ]);
  });

  it("refuses a second organization's app whose host the first's holds, deleted or not", async () => {
    // `todo-globex` of the install's organization takes the host globex's
    // `todo` would get, and its tombstone keeps it.
    const { app } = await register(acme, "todo-globex");
    await expect(register(globex)).rejects.toMatchObject({
      status: 409,
      code: "HOSTNAME_TAKEN",
    });
    await AppService.delete(ownerCtx(), app.id);
    await expect(register(globex)).rejects.toMatchObject({
      code: "HOSTNAME_TAKEN",
    });
  });

  it("deletes an app as a tombstone that keeps its names reserved", async () => {
    const registered = await register(acme);
    await db.insert(userAccessTokens).values({
      id: "pat-1",
      userId: acmeOwner,
      organizationId: acme,
      appRowId: registered.app.id,
      name: "agent",
      tokenHash: "hash",
      tokenPrefix: "epat_abcd",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await AppService.delete(ownerCtx(), registered.app.id);

    const [row] = await db.select().from(apps);
    expect(row).toMatchObject({ status: "deleted", isDefault: false });
    expect(await db.select().from(userAppAccess)).toEqual([]);
    const [pat] = await db
      .select()
      .from(userAccessTokens)
      .where(eq(userAccessTokens.id, "pat-1"));
    expect(pat?.revokedAt).toBeInstanceOf(Date);

    // No longer routed or listed.
    await expect(lookup()).resolves.toBeNull();
    await expect(
      AppService.getAllWithAccessCounts(ownerCtx()),
    ).resolves.toEqual({ apps: [] });

    // Its own organization can redeploy it, under the same names, from
    // scratch: pending until the new upload.
    await expect(register(acme)).resolves.toMatchObject({
      kind: "revived",
      app: { status: "pending", workerName: "every-acme-todo", hostname: HOST },
    });
  });
});
