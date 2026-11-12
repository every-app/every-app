/**
 * A renamed app on the gateway's side (docs/design/2026-11-app-rename.md),
 * against a migrated SQLite database: the CLI writes the rename (the app's
 * row takes the new id and hostname; the old ones become an
 * `app_previous_ids` row), and the gateway serves the previous hostname as
 * the same app, keeps a native client's resource on it, and stops once the
 * id is retired or the app deleted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: () => undefined }));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(hoisted.testDb) };
});

import { eq } from "drizzle-orm";
import { appPreviousIds, apps } from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import {
  currentAppResources,
  resetAppResourcesForTests,
} from "@/server/mcp-auth/resources";
import { registerDispatchApp } from "@/server/deploy/registry";
import { AppRepository } from "@/server/repositories/AppRepository";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import { markAppDeployed, registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const OLD = "talk.apps.example.com";
const NEW = "scribe.apps.example.com";

describe("a renamed app (SQLite)", () => {
  let db: TestDb;
  let rowId: string;
  let organizationId: string;

  /** The CLI's rename writes (lib/gateway/rename.ts writeRename). */
  async function rename(): Promise<void> {
    const now = new Date(1_000);
    await db.batch([
      db
        .update(apps)
        .set({ appSlug: "scribe", hostname: NEW, updatedAt: now })
        .where(eq(apps.id, rowId)),
      db.insert(appPreviousIds).values({
        organizationId,
        appSlug: "talk",
        appRowId: rowId,
        hostname: OLD,
        renamedAt: now,
      }),
    ]);
  }

  beforeEach(async () => {
    db = await createTestDb();
    hoisted.testDb.current = db;
    resetAppResourcesForTests();
    organizationId = await seedOrganization(db, "acme");
    await seedMember(db, { organizationId, role: "owner" });
    const plan = await registerApp(db, {
      organizationId,
      appSlug: "talk",
      manifest: { id: "talk", resources: { d1: ["DB"], r2: ["UPDATES"] } },
    });
    rowId = plan.app.id;
    await markAppDeployed(db, rowId, {
      versionId: "v1",
      manifest: { id: "talk", resources: { d1: ["DB"], r2: ["UPDATES"] } },
    });
    await db.update(apps).set({ status: "active" }).where(eq(apps.id, rowId));
    await rename();
  });

  it("serves the previous hostname as the same app: in full, then redirecting once moved", async () => {
    const registry = new DrizzleAppRegistry(db as never);
    const served = await registry.findByHostname(OLD);
    expect(served).toMatchObject({
      appId: "scribe",
      hostname: OLD,
      workerName: "every-acme-talk",
      rowId,
    });
    expect(served?.movedTo).toBeUndefined();
    await expect(registry.findByHostname(NEW)).resolves.toMatchObject({
      appId: "scribe",
      hostname: NEW,
    });

    await db
      .update(appPreviousIds)
      .set({ movedAt: new Date(2_000) })
      .where(eq(appPreviousIds.appRowId, rowId));
    await expect(registry.findByHostname(OLD)).resolves.toMatchObject({
      hostname: OLD,
      movedTo: NEW,
    });

    await db
      .update(appPreviousIds)
      .set({ retiredAt: new Date(3_000) })
      .where(eq(appPreviousIds.appRowId, rowId));
    await expect(registry.findByHostname(OLD)).resolves.toBeNull();
  });

  it("knows the app by its previous id, for a Worker uploaded before the rename", async () => {
    const registry = new DrizzleAppRegistry(db as never);
    await expect(
      registry.findByOrgApp(organizationId, "talk"),
    ).resolves.toBeNull();
    await expect(
      registry.findByOrgPreviousApp(organizationId, "talk"),
    ).resolves.toMatchObject({
      appId: "scribe",
      workerName: "every-acme-talk",
    });
    await expect(
      registry.findByOrgPreviousApp("org-other", "talk"),
    ).resolves.toBeNull();
  });

  it("keeps the previous hostname an OAuth resource while it is served", async () => {
    expect(await currentAppResources("https:")).toEqual([
      `https://${NEW}`,
      `https://${OLD}`,
    ]);
    // A native grant made on the old host still refreshes there.
    expect(
      await McpConnectionRepository.findAppResources(rowId, "https:"),
    ).toEqual([`https://${NEW}`, `https://${OLD}`]);
    await expect(
      McpConnectionRepository.findActiveAppByHostname(OLD),
    ).resolves.toMatchObject({ rowId, appSlug: "scribe", hostname: OLD });

    await db
      .update(appPreviousIds)
      .set({ retiredAt: new Date(3_000) })
      .where(eq(appPreviousIds.appRowId, rowId));
    resetAppResourcesForTests();
    expect(await currentAppResources("https:")).toEqual([`https://${NEW}`]);
    expect(
      await McpConnectionRepository.findAppResources(rowId, "https:"),
    ).toEqual([`https://${NEW}`]);
    await expect(
      McpConnectionRepository.findActiveAppByHostname(OLD),
    ).resolves.toBeNull();
  });

  it("stops serving it when the app is deleted, and keeps the id reserved", async () => {
    await AppRepository.tombstone({
      id: rowId,
      organizationId,
      status: "active",
    });
    const [previous] = await db
      .select()
      .from(appPreviousIds)
      .where(eq(appPreviousIds.appRowId, rowId));
    expect(previous?.retiredAt).not.toBeNull();
    await expect(
      new DrizzleAppRegistry(db as never).findByHostname(OLD),
    ).resolves.toBeNull();
  });

  it("installs a release whose previousIds name nothing here as a new app, and refuses one that would rename", async () => {
    const install = (id: string, previousIds: string[]) =>
      registerDispatchApp({
        serviceBinding: true,
        organizationId,
        appSlug: id,
        name: id,
        description: id,
        manifest: { id, previousIds },
        configuredThirdPartyDomain: null,
        appBaseDomain: "apps.example.com",
        thirdPartyDomain: null,
      });

    // This Gateway never had "chat": the list is history, the app is new.
    const plan = await install("notes", ["chat"]);
    expect(plan.app).toMatchObject({
      appSlug: "notes",
      hostname: "notes.apps.example.com",
    });
    expect(plan.app.id).not.toBe(rowId);

    // An app here is, or was, the listed id: a rename, which only the CLI does.
    await expect(install("memo", ["scribe"])).rejects.toMatchObject({
      code: "RENAME_UNSUPPORTED",
    });
    await expect(install("memo", ["chat", "talk"])).rejects.toMatchObject({
      code: "RENAME_UNSUPPORTED",
    });
  });
});
