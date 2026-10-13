import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com" },
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import { apps, userAccessTokens, userAppAccess } from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";
import { AppService } from "@/server/services/AppService";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

function registerTodo(organizationId: string) {
  return AppRegistrationService.register({
    organizationId,
    appSlug: "todo",
    name: "Todo",
    description: "Todos",
    workerName: "every-todo",
    manifest: { id: "todo" },
  });
}

describe("app registration lockdown (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let globex: string;
  let acmeOwner: string;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    acme = await seedOrganization(db, "acme");
    globex = await seedOrganization(db, "globex");
    acmeOwner = await seedMember(db, { organizationId: acme, role: "owner" });
    await seedMember(db, { organizationId: globex, role: "owner" });
  });

  it("deletes an app as a tombstone that keeps its id reserved", async () => {
    const registered = await registerTodo(acme);
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
    const registry = new DrizzleAppRegistry(db as never);
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

    // Another organization cannot take the deleted app's id over.
    await expect(registerTodo(globex)).rejects.toMatchObject({
      status: 409,
      code: "WORKER_NAME_TAKEN",
    });

    // Its own organization can redeploy it.
    await expect(registerTodo(acme)).resolves.toMatchObject({
      existingApp: true,
      hostname: "todo-acme.gateway.example.com",
    });
    await expect(
      registry.findByHostname("todo-acme.gateway.example.com"),
    ).resolves.toMatchObject({ appId: "todo", status: "active" });
  });

  it("rejects a foreign Worker name and the gateway's own Worker", async () => {
    await expect(
      AppRegistrationService.register({
        organizationId: acme,
        appSlug: "todo",
        name: "Todo",
        description: "Todos",
        workerName: "billing-api",
        manifest: { id: "todo" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_WORKER_NAME" });

    await expect(
      AppRegistrationService.register({
        organizationId: acme,
        appSlug: "app-gateway",
        name: "Gateway",
        description: "x",
        workerName: "every-app-gateway",
        manifest: { id: "app-gateway" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_WORKER_NAME" });
    expect(await db.select().from(apps)).toEqual([]);
  });
});
