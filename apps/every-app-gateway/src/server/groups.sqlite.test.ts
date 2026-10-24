/**
 * Groups with app grants against a migrated SQLite database: the one
 * access rule (a direct grant or a group's) at every site that decides or
 * shows access, membership removal, and what a group refuses.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuv";

const background = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: "https://gateway.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    DB: {},
  },
  waitUntil: (task: Promise<unknown>) => background.push(task),
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => testDb.current }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));
vi.mock("@/server/mcp-auth/config", () => ({ getMcpAuth: () => null }));

import { and, eq } from "drizzle-orm";
import { InMemoryAppRegistry, type RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import {
  apps,
  groupAppAccess,
  groupMembers,
  groups,
  members,
  userAccessTokens,
} from "@/db/schema";
import { createProdAuthenticator } from "@/perimeter/betterAuthAuthenticator";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { GroupRepository } from "@/server/repositories/GroupRepository";
import { AdminService } from "@/server/services/AdminService";
import { AppAccessService } from "@/server/services/AppAccessService";
import { GroupService } from "@/server/services/GroupService";
import { hashUserPat } from "@/server/user-pat-hash";
import { registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

type Role = "owner" | "admin" | "member";
const PAT = "epat_member-personal-access-token";
const LIST = "http://every-app-gateway.internal/api/integrations/members/list";

let publicKeyPem: string;

beforeAll(() => {
  publicKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
});

describe("groups with app grants (SQLite)", () => {
  let db: TestDb;
  let org: string;
  let owner: string;
  let admin: string;
  let member: string;
  let todo: RegisteredApp & { rowId: string };
  let crmRowId: string;
  let logged: ReturnType<typeof vi.spyOn>;
  const ctx = (userId: string, role: Role = "owner") => ({
    orgId: org,
    userId,
    role,
  });
  const asOwner = () => ctx(owner, "owner");

  async function deploy(appSlug: string, organizationId = org) {
    const { app } = await registerApp(db, {
      organizationId,
      appSlug,
      name: appSlug,
      description: appSlug,
      manifest: { id: appSlug },
      deployerUserId: null,
    });
    await db.update(apps).set({ status: "active" }).where(eq(apps.id, app.id));
    return {
      rowId: app.id,
      appId: app.appSlug,
      hostname: app.hostname!,
      workerName: app.workerName!,
      tier: "service_binding" as const,
      scope: "org" as const,
      organizationId,
      status: "active" as const,
      manifest: validateManifest({
        id: appSlug,
        capabilities: { members: { access: "read", why: "Reports" } },
      }),
    };
  }

  /** The app ids the launcher shows a user, with how each is granted. */
  async function launcher(userId: string) {
    const { apps } = await AppAccessService.getAppsForUser(
      ctx(userId, "member"),
    );
    return apps.map((app) => ({
      appId: app.appId,
      via: app.via?.name ?? null,
    }));
  }

  /** The perimeter's answer for a member's personal access token. */
  async function perimeterOpens(app: RegisteredApp): Promise<boolean> {
    clearOrgContextCacheForTests();
    const authenticator = createProdAuthenticator();
    const session = await authenticator.authenticate(
      new Request(`https://${app.hostname}/`, {
        headers: { authorization: `Bearer ${PAT}` },
      }),
    );
    if (!session) throw new Error("the token did not authenticate");
    return (await authenticator.hasAppAccess(session, app)) !== false;
  }

  /** The emails the members capability lists for an app. */
  async function capabilityLists(app: RegisteredApp): Promise<string[]> {
    clearAppCallerCacheForTests();
    const response = await handleAppGatewayRequest({
      request: new Request(LIST),
      props: {
        organizationId: org,
        appId: app.appId,
        workerName: app.workerName,
      },
      env: {
        GATEWAY_DEPLOYMENT_MODE: "self_hosted",
        GATEWAY_URL: "https://gateway.example.com",
        JWT_PUBLIC_KEY: publicKeyPem,
      },
      registry: new InMemoryAppRegistry([app]),
      organizations: { isAttributable: async () => true },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { members: { email: string }[] };
    return body.members.map((m) => m.email).sort();
  }

  /** The app slugs whose MCP catalog a user's connection serves. */
  async function mcpCatalogs(userId: string): Promise<string[]> {
    const catalogs = await AppToolRepository.findVisibleCatalogs({
      organizationId: org,
      userId,
      sharedApps: false,
    });
    return catalogs.map((catalog) => catalog.appSlug).sort();
  }

  async function accessCount(appRowId: string): Promise<number> {
    const rows = await AppRepository.findAllWithAccessCounts(org);
    return rows.find((row) => row.id === appRowId)!.accessCount;
  }

  /** The `group.*` events the service logged, in order. */
  function groupEvents(): Record<string, unknown>[] {
    return logged.mock.calls.flatMap(([line]) => {
      if (typeof line !== "string" || !line.startsWith("{")) return [];
      const event = JSON.parse(line) as Record<string, unknown>;
      return String(event.evt).startsWith("group.") ? [event] : [];
    });
  }

  async function groupRows(groupId: string) {
    return {
      members: (
        await db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, groupId))
      ).map((row) => row.userId),
      apps: (
        await db
          .select({ appRowId: groupAppAccess.appRowId })
          .from(groupAppAccess)
          .where(eq(groupAppAccess.groupId, groupId))
      ).map((row) => row.appRowId),
    };
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearOrgContextCacheForTests();
    clearAppCallerCacheForTests();
    logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    org = await seedOrganization(db, "acme");
    owner = await seedMember(db, {
      organizationId: org,
      role: "owner",
      email: "owner@acme.test",
    });
    admin = await seedMember(db, {
      organizationId: org,
      role: "admin",
      email: "admin@acme.test",
    });
    member = await seedMember(db, {
      organizationId: org,
      email: "member@acme.test",
    });
    todo = await deploy("todo");
    crmRowId = (await deploy("crm")).rowId;
    // The owner alone opens both apps to begin with.
    for (const rowId of [todo.rowId, crmRowId]) {
      await AppAccessService.updateAccessForApp(asOwner(), rowId, [owner]);
    }
    await AppToolRepository.replace({
      appRowId: todo.rowId,
      organizationId: org,
      versionId: "v1",
      status: "ok",
      catalogHash: "hash-1",
      instructions: null,
      sdkVersion: "0.3.0",
      warnings: [],
      lastError: null,
      tools: [
        {
          name: "list_todos",
          description: "List todos.",
          risk: "read",
          inputSchema: { type: "object" },
        },
      ],
    });
    await db.insert(userAccessTokens).values({
      id: "pat-1",
      userId: member,
      organizationId: org,
      name: "agent",
      tokenHash: await hashUserPat(PAT, SECRET),
      tokenPrefix: "epat_memb",
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("the access rule at every site", () => {
    it("opens an app to a group's members everywhere a grant is checked or shown", async () => {
      // Before: the member has nothing.
      expect(await perimeterOpens(todo)).toBe(false);
      expect(await launcher(member)).toEqual([]);
      expect(await capabilityLists(todo)).toEqual(["owner@acme.test"]);
      expect(await mcpCatalogs(member)).toEqual([]);
      expect(await accessCount(todo.rowId)).toBe(1);

      const { id: sales } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
        description: "The sales team",
      });
      await GroupService.setGroupMembers(asOwner(), sales, [member, owner]);
      await GroupService.setGroupApps(asOwner(), sales, [todo.rowId]);

      // The perimeter (the member's personal access token on the app host).
      expect(await perimeterOpens(todo)).toBe(true);
      // The launcher, saying which group opened it; the owner's direct
      // grant stays direct.
      expect(await launcher(member)).toEqual([{ appId: "todo", via: "Sales" }]);
      expect(await launcher(owner)).toEqual([
        { appId: "crm", via: null },
        { appId: "todo", via: null },
      ]);
      // The members capability, through the AppGateway entrypoint.
      expect(await capabilityLists(todo)).toEqual([
        "member@acme.test",
        "owner@acme.test",
      ]);
      // The MCP catalogs a connection serves.
      expect(await mcpCatalogs(member)).toEqual(["todo"]);
      expect(await mcpCatalogs(admin)).toEqual([]);
      // The access count: distinct people, the owner counted once.
      expect(await accessCount(todo.rowId)).toBe(2);
      expect(await accessCount(crmRowId)).toBe(1);
      // The admin modal: a group grant is shown, never a checked box.
      const { users } = await AppAccessService.getAccessStateForApp(
        asOwner(),
        todo.rowId,
      );
      expect(users.find((u) => u.id === member)).toMatchObject({
        hasAccess: false,
        viaGroups: ["Sales"],
      });
      expect(users.find((u) => u.id === owner)).toMatchObject({
        hasAccess: true,
        viaGroups: ["Sales"],
      });
      expect(users.find((u) => u.id === admin)).toMatchObject({
        hasAccess: false,
        viaGroups: [],
      });
    });

    it("counts an app with only a group grant as claimed", async () => {
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Ops",
      });
      // Nobody holds crm directly any more.
      await AppAccessService.updateAccessForApp(
        ctx(admin, "admin"),
        crmRowId,
        [],
      );
      expect(await AppRepository.findAllWithoutAccess(org)).toEqual([
        { id: crmRowId },
      ]);
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      await GroupService.setGroupApps(asOwner(), id, [crmRowId]);
      expect(await AppRepository.findAllWithoutAccess(org)).toEqual([]);
    });

    it("saving the direct list never touches what a group grants", async () => {
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      await GroupService.setGroupApps(asOwner(), id, [todo.rowId]);

      // The admin saves the direct list without the member: nothing to
      // revoke, and the member keeps the app through the group.
      const result = await AppAccessService.updateAccessForApp(
        ctx(admin, "admin"),
        todo.rowId,
        [owner, admin],
      );
      expect(result).toEqual({ granted: 1, revoked: 0 });
      expect(await perimeterOpens(todo)).toBe(true);
      expect(await launcher(member)).toEqual([{ appId: "todo", via: "Sales" }]);

      // Granting them directly too makes the grant direct in the launcher.
      await AppAccessService.updateAccessForApp(
        ctx(admin, "admin"),
        todo.rowId,
        [owner, admin, member],
      );
      expect(await launcher(member)).toEqual([{ appId: "todo", via: null }]);
      // Revoking the direct grant leaves the group's.
      await AppAccessService.updateAccessForApp(
        ctx(admin, "admin"),
        todo.rowId,
        [owner],
      );
      expect(await launcher(member)).toEqual([{ appId: "todo", via: "Sales" }]);
      expect(await perimeterOpens(todo)).toBe(true);
    });

    it("ends access when the group loses the app, the member, or is deleted", async () => {
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      await GroupService.setGroupApps(asOwner(), id, [todo.rowId, crmRowId]);
      expect(await launcher(member)).toEqual([
        { appId: "crm", via: "Sales" },
        { appId: "todo", via: "Sales" },
      ]);

      await GroupService.setGroupApps(asOwner(), id, [todo.rowId]);
      expect(await launcher(member)).toEqual([{ appId: "todo", via: "Sales" }]);

      await GroupService.setGroupMembers(asOwner(), id, []);
      expect(await launcher(member)).toEqual([]);
      expect(await perimeterOpens(todo)).toBe(false);
      expect(await mcpCatalogs(member)).toEqual([]);

      await GroupService.setGroupMembers(asOwner(), id, [member]);
      expect(await perimeterOpens(todo)).toBe(true);
      await GroupService.deleteGroup(asOwner(), id);
      expect(await perimeterOpens(todo)).toBe(false);
      expect(await launcher(member)).toEqual([]);
      expect(await capabilityLists(todo)).toEqual(["owner@acme.test"]);
      expect(await db.select().from(groupMembers)).toEqual([]);
      expect(await db.select().from(groupAppAccess)).toEqual([]);
    });

    it("never opens a tombstone, even with a group grant left on it", async () => {
      // What a delete from before group grants were among its companions
      // leaves behind: the status flipped, the grant in place.
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      await GroupService.setGroupApps(asOwner(), id, [todo.rowId]);
      await db
        .update(apps)
        .set({ status: "deleted" })
        .where(eq(apps.id, todo.rowId));
      expect(await groupRows(id)).toEqual({
        members: [member],
        apps: [todo.rowId],
      });

      expect(await perimeterOpens(todo)).toBe(false);
      expect(await launcher(member)).toEqual([]);
      expect(await mcpCatalogs(member)).toEqual([]);
      expect(
        (await AppRepository.findAllWithAccessCounts(org)).map((row) => row.id),
      ).toEqual([crmRowId]);
      // Nor is it offered to a group, or counted among the group's apps.
      const { apps: offered } = await GroupService.getGroupApps(asOwner(), id);
      expect(offered.map((app) => app.appId)).toEqual(["crm"]);
      const { groups: listed } = await GroupService.listGroups(asOwner());
      expect(listed.map((g) => [g.name, g.appCount])).toEqual([["Sales", 0]]);
    });

    it("drops a group's grant to an app the admin deletes", async () => {
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      await GroupService.setGroupApps(asOwner(), id, [todo.rowId]);
      const app = await AppRepository.findById(todo.rowId, org);
      await AppRepository.tombstone(app!);
      expect(await groupRows(id)).toEqual({ members: [member], apps: [] });
      expect(await launcher(member)).toEqual([]);
    });
  });

  describe("membership", () => {
    it("removing a member from the organization takes them out of its groups", async () => {
      // A member of another organization too, so the account stays and
      // only this organization's rows go.
      const other = await seedOrganization(db, "other");
      await db.insert(members).values({
        id: "member-elsewhere",
        organizationId: other,
        userId: member,
        role: "member",
        createdAt: new Date(),
      });
      const { id: sales } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      const { id: ops } = await GroupService.createGroup(asOwner(), {
        name: "Ops",
      });
      await GroupService.setGroupMembers(asOwner(), sales, [member, admin]);
      await GroupService.setGroupMembers(asOwner(), ops, [member]);

      await AdminService.deleteUser(asOwner(), member);
      await Promise.all(background.splice(0));

      expect(await groupRows(sales)).toEqual({ members: [admin], apps: [] });
      expect(await groupRows(ops)).toEqual({ members: [], apps: [] });
      const { groups: listed } = await GroupService.listGroups(asOwner());
      expect(listed.map((g) => [g.name, g.memberCount])).toEqual([
        ["Ops", 0],
        ["Sales", 1],
      ]);
    });

    it("lists every member with whether they are in the group, and refuses outsiders", async () => {
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      const { users } = await GroupService.getGroupMembers(asOwner(), id);
      expect(users.map((u) => [u.email, u.inGroup]).sort()).toEqual([
        ["admin@acme.test", false],
        ["member@acme.test", true],
        ["owner@acme.test", false],
      ]);

      const other = await seedOrganization(db, "other");
      const outsider = await seedMember(db, { organizationId: other });
      await expect(
        GroupService.setGroupMembers(asOwner(), id, [member, outsider]),
      ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
      await expect(
        GroupService.setGroupMembers(asOwner(), id, ["nobody"]),
      ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
      expect(await groupRows(id)).toEqual({ members: [member], apps: [] });
    });
  });

  describe("the record", () => {
    it("logs each change, with who made it", async () => {
      const by = ctx(admin, "admin");
      const { id } = await GroupService.createGroup(by, { name: "Sales" });
      await GroupService.setGroupMembers(by, id, [member, owner]);
      await GroupService.setGroupApps(by, id, [todo.rowId]);
      await GroupService.setGroupMembers(by, id, [member]);
      await GroupService.setGroupApps(by, id, []);
      await GroupService.deleteGroup(by, id);
      const common = { organizationId: org, groupId: id, by: admin };
      expect(groupEvents()).toEqual([
        { evt: "group.created", ...common },
        { evt: "group.members_changed", added: 2, removed: 0, ...common },
        { evt: "group.apps_changed", granted: 1, revoked: 0, ...common },
        { evt: "group.members_changed", added: 0, removed: 1, ...common },
        { evt: "group.apps_changed", granted: 0, revoked: 1, ...common },
        { evt: "group.deleted", ...common },
      ]);
    });
  });

  describe("what a group refuses", () => {
    it("never holds a shared app", async () => {
      await db.insert(apps).values({
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: org,
        appSlug: "openseo",
        name: "OpenSEO",
        description: "Shared",
        scope: "shared",
        status: "active",
      });
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await expect(
        GroupService.setGroupApps(asOwner(), id, [
          "11111111-1111-4111-8111-111111111111",
        ]),
      ).rejects.toMatchObject({ code: "SHARED_APP_ACCESS" });
      // Nor is it offered.
      const { apps: offered } = await GroupService.getGroupApps(asOwner(), id);
      expect(offered.map((app) => app.appId)).toEqual(["crm", "todo"]);
      expect(await groupRows(id)).toEqual({ members: [], apps: [] });
    });

    it("refuses a duplicate name, letter case aside, on create and rename", async () => {
      const { id } = await GroupService.createGroup(asOwner(), {
        name: "  Sales ",
      });
      expect(
        (await GroupService.listGroups(asOwner())).groups.map((g) => g.name),
      ).toEqual(["Sales"]);
      await expect(
        GroupService.createGroup(asOwner(), { name: "sales" }),
      ).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN" });
      await GroupService.createGroup(asOwner(), { name: "Ops" });
      await expect(
        GroupService.updateGroup(asOwner(), id, { name: "OPS" }),
      ).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN" });
      // Renaming a group to its own name (or case) is fine.
      await GroupService.updateGroup(asOwner(), id, {
        name: "SALES",
        description: "  ",
      });
      const [row] = await db.select().from(groups).where(eq(groups.id, id));
      expect(row).toMatchObject({ name: "SALES", description: null });
      expect(row!.id).toMatch(/^grp_[0-9a-f]{16}$/);
    });

    it("refuses a duplicate name at the database too, when two admins race", async () => {
      await GroupService.createGroup(asOwner(), { name: "Sales" });
      // The unique index is on lower(name): the case twin fails without
      // the service's check.
      await expect(
        db.insert(groups).values({
          id: "grp_0000000000000001",
          organizationId: org,
          name: "sales",
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/UNIQUE constraint failed/) },
      });
      // The service's check lost the race (the other isolate's insert
      // landed between its read and its write): the database's refusal
      // reads the same as its own.
      vi.spyOn(GroupRepository, "findByName").mockImplementation(
        async () => null,
      );
      await expect(
        GroupService.createGroup(asOwner(), { name: "SALES" }),
      ).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN" });
      const { id } = await GroupService.createGroup(asOwner(), { name: "Ops" });
      await expect(
        GroupService.updateGroup(asOwner(), id, { name: "sales" }),
      ).rejects.toMatchObject({ code: "GROUP_NAME_TAKEN" });
      expect(
        (await GroupService.listGroups(asOwner())).groups.map((g) => g.name),
      ).toEqual(["Ops", "Sales"]);
    });

    it("keeps organizations apart: neither their apps, their people nor their groups cross", async () => {
      const other = await seedOrganization(db, "other");
      const otherOwner = await seedMember(db, {
        organizationId: other,
        role: "owner",
      });
      const otherApp = await deploy("wiki", other);
      const otherCtx = {
        orgId: other,
        userId: otherOwner,
        role: "owner" as const,
      };

      const { id } = await GroupService.createGroup(asOwner(), {
        name: "Sales",
      });
      await expect(
        GroupService.setGroupApps(asOwner(), id, [otherApp.rowId]),
      ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
      await expect(
        GroupService.setGroupMembers(asOwner(), id, [otherOwner]),
      ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
      // The other organization neither sees nor edits it, and may reuse
      // the name.
      await expect(
        GroupService.getGroupMembers(otherCtx, id),
      ).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
      await expect(
        GroupService.deleteGroup(otherCtx, id),
      ).rejects.toMatchObject({ code: "GROUP_NOT_FOUND" });
      expect((await GroupService.listGroups(otherCtx)).groups).toEqual([]);
      await GroupService.createGroup(otherCtx, { name: "Sales" });

      // A grant in one organization opens nothing in another, even for a
      // person who belongs to both.
      await db.insert(members).values({
        id: "member-in-other",
        organizationId: other,
        userId: member,
        role: "member",
        createdAt: new Date(),
      });
      await GroupService.setGroupMembers(asOwner(), id, [member]);
      await GroupService.setGroupApps(asOwner(), id, [todo.rowId]);
      expect(
        (
          await AppAccessService.getAppsForUser({
            orgId: other,
            userId: member,
            role: "member",
          })
        ).apps,
      ).toEqual([]);
      expect(
        await AppToolRepository.findVisibleCatalogs({
          organizationId: other,
          userId: member,
          sharedApps: false,
        }),
      ).toEqual([]);
      const [row] = await db
        .select()
        .from(groupAppAccess)
        .where(
          and(
            eq(groupAppAccess.groupId, id),
            eq(groupAppAccess.organizationId, org),
          ),
        );
      expect(row).toBeDefined();
    });
  });
});
