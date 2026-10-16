/**
 * User management against a migrated SQLite database: private-by-default
 * apps, "Available to everyone", roles, and deactivation reaching every
 * credential the gateway accepts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuv";

const background = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("cloudflare:workers", () => ({
  env: {
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
// The OAuth grants a removal revokes are covered by the MCP OAuth tests.
vi.mock("@/server/mcp-auth/config", () => ({ getMcpAuth: () => null }));

import { eq, sql } from "drizzle-orm";
import { createAuth } from "@/auth";
import {
  appTokens,
  members,
  sessions,
  userAccessTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import { createProdAuthenticator } from "@/perimeter/betterAuthAuthenticator";
import { hashAppToken } from "@/server/app-token-hash";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { AdminService } from "@/server/services/AdminService";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";
import { AppService } from "@/server/services/AppService";
import { AppTokenService } from "@/server/services/AppTokenService";
import { MembershipService } from "@/server/services/MembershipService";
import { hashUserPat } from "@/server/user-pat-hash";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

type Role = "owner" | "admin" | "member";

describe("user management (SQLite)", () => {
  let db: TestDb;
  let org: string;
  let owner: string;
  let admin: string;
  let deployer: string;
  let member: string;
  const ctx = (userId: string, role: Role) => ({ orgId: org, userId, role });
  const visibleTo = async (userId: string) =>
    (await AppAccessService.getAppsForUser(ctx(userId, "member"))).apps.map(
      (app) => app.appId,
    );

  function registerTodo(manifest: Record<string, unknown> = {}) {
    return AppRegistrationService.register({
      organizationId: org,
      appSlug: "todo",
      name: "Todo",
      description: "Todos",
      manifest: { id: "todo", ...manifest },
      deployerUserId: deployer,
    });
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearOrgContextCacheForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    org = await seedOrganization(db, "acme");
    owner = await seedMember(db, { organizationId: org, role: "owner" });
    admin = await seedMember(db, { organizationId: org, role: "admin" });
    deployer = await seedMember(db, { organizationId: org });
    member = await seedMember(db, { organizationId: org });
  });

  describe("apps are private by default", () => {
    it("a newly deployed app is invisible to plain members until granted", async () => {
      const { appId } = await registerTodo();

      expect(await visibleTo(member)).toEqual([]);
      expect(await visibleTo(owner)).toEqual(["todo"]);
      expect(await visibleTo(admin)).toEqual(["todo"]);
      expect(await visibleTo(deployer)).toEqual(["todo"]);

      // A member who joins later doesn't get it either.
      const newcomer = await seedMember(db, { organizationId: org });
      await AppAccessService.grantDefaultAppsToUser(newcomer, org);
      expect(await visibleTo(newcomer)).toEqual([]);

      // An admin grants it explicitly.
      await AppAccessService.updateAccessForApp(ctx(admin, "admin"), appId, [
        owner,
        admin,
        deployer,
        member,
      ]);
      expect(await visibleTo(member)).toEqual(["todo"]);
    });

    it('access: "everyone" opens a new app to every member', async () => {
      await registerTodo({ access: "everyone" });

      expect(await visibleTo(member)).toEqual(["todo"]);
      const newcomer = await seedMember(db, { organizationId: org });
      await AppAccessService.grantDefaultAppsToUser(newcomer, org);
      expect(await visibleTo(newcomer)).toEqual(["todo"]);
    });

    it('"Available to everyone" grants every current and future member', async () => {
      const { appId } = await registerTodo();

      await AppService.update(ctx(admin, "admin"), {
        id: appId,
        name: "Todo",
        description: "Todos",
        isDefault: true,
      });

      expect(await visibleTo(member)).toEqual(["todo"]);
      const newcomer = await seedMember(db, { organizationId: org });
      await AppAccessService.grantDefaultAppsToUser(newcomer, org);
      expect(await visibleTo(newcomer)).toEqual(["todo"]);
    });
  });

  describe("roles", () => {
    const roleOf = async (userId: string) =>
      (await db.select().from(members).where(eq(members.userId, userId)))[0]
        ?.role;

    it("lets an admin promote a member, and only an owner change an admin", async () => {
      await MembershipService.changeRole(ctx(admin, "admin"), member, "admin");
      expect(await roleOf(member)).toBe("admin");

      await expect(
        MembershipService.changeRole(ctx(admin, "admin"), member, "member"),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });

      await MembershipService.changeRole(ctx(owner, "owner"), member, "member");
      expect(await roleOf(member)).toBe("member");
    });

    it("never changes an owner or the acting user", async () => {
      await expect(
        MembershipService.changeRole(ctx(admin, "admin"), owner, "member"),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_OWNER" });
      await expect(
        MembershipService.changeRole(ctx(admin, "admin"), admin, "member"),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
    });
  });

  const PAT = "epat_member-personal-access-token";
  const DEPLOY_TOKEN = "eak_member-deploy-token";

  async function seedCredentials() {
    await registerTodo({ access: "everyone" });
    await db.insert(sessions).values({
      id: "session-1",
      token: "session-token",
      userId: member,
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
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
    await db.insert(appTokens).values({
      id: "deploy-1",
      organizationId: org,
      tokenHash: await hashAppToken(DEPLOY_TOKEN, SECRET),
      tokenPrefix: "eak_memb",
      scopes: JSON.stringify(["apps:register", "apps:deploy"]),
      createdBy: member,
    });
  }

  function authenticatePat() {
    return createProdAuthenticator().authenticate(
      new Request("https://todo-acme.gateway.example.com/mcp", {
        headers: { authorization: `Bearer ${PAT}` },
      }),
    );
  }

  describe("deactivate", () => {
    it("ends sessions and rejects the user's PAT and deploy token", async () => {
      await seedCredentials();
      await expect(authenticatePat()).resolves.toMatchObject({ sub: member });
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toMatchObject({ organizationId: org, createdBy: member });

      await MembershipService.deactivate(ctx(admin, "admin"), member);

      expect(
        await db.select().from(sessions).where(eq(sessions.userId, member)),
      ).toEqual([]);
      await expect(authenticatePat()).resolves.toBeNull();
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toBeNull();
    });

    it("rejects a banned user's tokens even if they were never revoked", async () => {
      await seedCredentials();
      await MembershipService.deactivate(ctx(owner, "owner"), member);
      await db.update(userAccessTokens).set({ revokedAt: null });
      await db.update(appTokens).set({ revokedAt: null });

      await expect(authenticatePat()).resolves.toBeNull();
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toBeNull();

      // Reactivating lets them sign in again, but revoked tokens stay dead.
      await db.update(userAccessTokens).set({ revokedAt: new Date() });
      await MembershipService.reactivate(ctx(owner, "owner"), member);
      const [user] = await db.select().from(users).where(eq(users.id, member));
      expect(user?.banned).toBe(false);
      await expect(authenticatePat()).resolves.toBeNull();
    });

    it("blocks the deactivated user's next sign-in", async () => {
      const auth = createAuth();
      const { user } = await auth.api.signUpEmail({
        body: {
          name: "Pat",
          email: "pat@example.com",
          password: "pat-password-123",
        },
      });
      await db.insert(members).values({
        id: "member-pat",
        organizationId: org,
        userId: user.id,
        role: "member",
        createdAt: new Date(),
      });

      await MembershipService.deactivate(ctx(owner, "owner"), user.id);

      const response = await auth.handler(
        new Request("https://gateway.example.com/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://gateway.example.com",
          },
          body: JSON.stringify({
            email: "pat@example.com",
            password: "pat-password-123",
          }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it("refuses to deactivate owners, admins (unless owner) and yourself", async () => {
      await expect(
        MembershipService.deactivate(ctx(admin, "admin"), owner),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_OWNER" });
      const otherAdmin = await seedMember(db, {
        organizationId: org,
        role: "admin",
      });
      await expect(
        MembershipService.deactivate(ctx(admin, "admin"), otherAdmin),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await expect(
        MembershipService.deactivate(ctx(owner, "owner"), owner),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
    });

    it("refuses to deactivate someone who also belongs to another organization", async () => {
      const other = await seedOrganization(db, "other");
      await db.insert(members).values({
        id: "member-elsewhere",
        organizationId: other,
        userId: member,
        role: "owner",
        createdAt: new Date(),
      });

      await expect(
        MembershipService.deactivate(ctx(owner, "owner"), member),
      ).rejects.toMatchObject({ code: "USER_IN_OTHER_ORGANIZATION" });
    });
  });

  describe("delete user", () => {
    it("revokes the deleted user's deploy tokens and personal access tokens", async () => {
      await seedCredentials();
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toMatchObject({ createdBy: member });

      await AdminService.deleteUser(ctx(owner, "owner"), member);

      expect(await db.select().from(users).where(eq(users.id, member))).toEqual(
        [],
      );
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toBeNull();
      const [token] = await db.select().from(appTokens);
      expect(token?.revokedAt).toBeInstanceOf(Date);
      await expect(authenticatePat()).resolves.toBeNull();
    });

    it("keeps a user of another organization, revoking only what this one gave them", async () => {
      await seedCredentials();
      const other = await seedOrganization(db, "other");
      await db.insert(members).values({
        id: "member-elsewhere",
        organizationId: other,
        userId: member,
        role: "owner",
        createdAt: new Date(),
      });
      const OTHER_DEPLOY_TOKEN = "eak_member-other-org-token";
      await db.insert(appTokens).values({
        id: "deploy-other",
        organizationId: other,
        tokenHash: await hashAppToken(OTHER_DEPLOY_TOKEN, SECRET),
        tokenPrefix: "eak_memb",
        scopes: JSON.stringify(["apps:register", "apps:deploy"]),
        createdBy: member,
      });

      await AdminService.deleteUser(ctx(owner, "owner"), member);

      expect(
        await db.select().from(members).where(eq(members.userId, member)),
      ).toEqual([expect.objectContaining({ organizationId: other })]);
      expect(
        await db
          .select()
          .from(userAppAccess)
          .where(eq(userAppAccess.userId, member)),
      ).toEqual([]);
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toBeNull();
      const [pat] = await db.select().from(userAccessTokens);
      expect(pat?.revokedAt).toBeInstanceOf(Date);
      await expect(
        AppTokenService.verifyDeployToken(OTHER_DEPLOY_TOKEN),
      ).resolves.toMatchObject({ organizationId: other, createdBy: member });
    });

    it("removes and deactivates even before the AI app connections table exists", async () => {
      // A database without the connections tables: /mcp refuses removed
      // and banned users anyway, so the connections table is never what
      // an offboarding hangs on.
      await seedCredentials();
      await db.run(sql`DROP TABLE mcp_connection_apps`);
      await db.run(sql`DROP TABLE mcp_connections`);
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const other = await seedOrganization(db, "other");
      await db.insert(members).values({
        id: "member-elsewhere",
        organizationId: other,
        userId: member,
        role: "member",
        createdAt: new Date(),
      });

      await AdminService.deleteUser(ctx(owner, "owner"), member);
      expect(
        await db.select().from(members).where(eq(members.userId, member)),
      ).toEqual([expect.objectContaining({ organizationId: other })]);
      const [pat] = await db.select().from(userAccessTokens);
      expect(pat?.revokedAt).toBeInstanceOf(Date);

      await MembershipService.deactivate(ctx(owner, "owner"), deployer);
      const [deactivated] = await db
        .select()
        .from(users)
        .where(eq(users.id, deployer));
      expect(deactivated?.banned).toBe(true);

      const failures = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((line) => line["evt"] === "mcp.connection.revoke_failed");
      expect(failures.map((line) => line["reason"])).toEqual([
        "member_removed",
        "user_deactivated",
      ]);
      await Promise.all(background.splice(0));
    });

    it("refuses a deploy token whose creator left the organization or was deleted", async () => {
      await seedCredentials();

      // Membership removed some other way: the unrevoked token still fails.
      await db.delete(members).where(eq(members.userId, member));
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toBeNull();

      // Creator deleted: created_by is nulled and the token has no owner.
      await db.delete(users).where(eq(users.id, member));
      const [token] = await db.select().from(appTokens);
      expect(token).toMatchObject({ createdBy: null, revokedAt: null });
      await expect(
        AppTokenService.verifyDeployToken(DEPLOY_TOKEN),
      ).resolves.toBeNull();
    });
  });
});
