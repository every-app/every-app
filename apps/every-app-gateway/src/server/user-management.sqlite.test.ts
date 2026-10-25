/**
 * User management against a migrated SQLite database: private-by-default
 * apps, "Available to everyone", roles, and deactivation reaching every
 * credential the gateway accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuv";

const background = vi.hoisted(() => [] as Promise<unknown>[]);
type Mail = { to: string; subject: string; text?: string };
const mailbox = vi.hoisted(() => ({ sent: [] as Mail[] }));
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
// The OAuth grants a removal revokes are covered by the MCP OAuth tests.
vi.mock("@/server/mcp-auth/config", () => ({ getMcpAuth: () => null }));

import { env as workerEnv } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "@/auth";
import {
  members,
  sessions,
  userAccessTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import { createProdAuthenticator } from "@/perimeter/betterAuthAuthenticator";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { UserRepository } from "@/server/repositories/UserRepository";
import { AdminService } from "@/server/services/AdminService";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppService } from "@/server/services/AppService";
import { MembershipService } from "@/server/services/MembershipService";
import { hashUserPat } from "@/server/user-pat-hash";
import { registerApp } from "@/test/registry";
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

  async function registerTodo(manifest: Record<string, unknown> = {}) {
    const { app } = await registerApp(db, {
      organizationId: org,
      appSlug: "todo",
      name: "Todo",
      description: "Todos",
      manifest: { id: "todo", ...manifest },
      deployerUserId: deployer,
    });
    return { appId: app.id };
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

    it("lets an owner make a member or an admin an owner; an admin cannot", async () => {
      await expect(
        MembershipService.changeRole(ctx(admin, "admin"), member, "owner"),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      expect(await roleOf(member)).toBe("member");

      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");
      expect(await roleOf(member)).toBe("owner");
      await MembershipService.changeRole(ctx(owner, "owner"), admin, "owner");
      expect(await roleOf(admin)).toBe("owner");
    });

    it("lets one of two owners demote the other, and an admin never touch an owner", async () => {
      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");

      await expect(
        MembershipService.changeRole(ctx(admin, "admin"), owner, "member"),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      expect(await roleOf(owner)).toBe("owner");

      await MembershipService.changeRole(ctx(member, "owner"), owner, "admin");
      expect(await roleOf(owner)).toBe("admin");
      expect(await roleOf(member)).toBe("owner");
    });

    it("keeps the last owner: no demoting, deactivating or deleting them", async () => {
      // A second owner demotes the first: allowed. They are the sole owner
      // now, and every move against them is refused, even from a caller
      // whose context still says owner (the count is read from the database).
      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");
      await MembershipService.changeRole(ctx(member, "owner"), owner, "admin");
      expect(await roleOf(owner)).toBe("admin");

      for (const action of [
        () =>
          MembershipService.changeRole(ctx(owner, "owner"), member, "admin"),
        () => MembershipService.deactivate(ctx(owner, "owner"), member),
        () => AdminService.deleteUser(ctx(owner, "owner"), member),
      ]) {
        await expect(action()).rejects.toMatchObject({ code: "LAST_OWNER" });
      }
      await expect(
        MembershipService.changeRole(ctx(owner, "admin"), member, "admin"),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      expect(await roleOf(member)).toBe("owner");
      const [row] = await db.select().from(users).where(eq(users.id, member));
      expect(row?.banned).toBe(false);
    });

    it("keeps the last live owner in the write itself, with no check before it", async () => {
      // Two owners. The repository, asked directly, demotes one; the same
      // write on the one left changes nothing, as it would for the second of
      // two owners demoting each other at once.
      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");
      expect(
        await OrganizationMembersRepository.updateRole(member, org, "admin"),
      ).toBe(true);
      expect(
        await OrganizationMembersRepository.updateRole(owner, org, "admin"),
      ).toBe(false);
      expect(await roleOf(owner)).toBe("owner");

      // Nor does removing or deactivating them: nothing in the batch lands.
      expect(await OrganizationMembersRepository.removeMember(owner, org)).toBe(
        false,
      );
      expect(
        await UserRepository.deactivate(owner, "test", {
          unlessLastOwnerOf: org,
        }),
      ).toBe(false);
      const [row] = await db.select().from(users).where(eq(users.id, owner));
      expect(row?.banned).toBe(false);
      expect(await roleOf(owner)).toBe("owner");

      // Keeping them an owner, or making another, is never refused.
      expect(
        await OrganizationMembersRepository.updateRole(owner, org, "owner"),
      ).toBe(true);
      expect(
        await OrganizationMembersRepository.updateRole(member, org, "owner"),
      ).toBe(true);

      // A deactivated owner doesn't count: the one who can act stays, and
      // the deactivated one may lose the role.
      expect(await UserRepository.deactivate(member, "test")).toBe(true);
      expect(
        await OrganizationMembersRepository.updateRole(owner, org, "admin"),
      ).toBe(false);
      expect(
        await OrganizationMembersRepository.updateRole(member, org, "member"),
      ).toBe(true);
      expect(await roleOf(owner)).toBe("owner");
      expect(await roleOf(member)).toBe("member");
    });

    it("answers LAST_OWNER from the refused write when the early count was stale", async () => {
      // The count another owner's write can overtake: here it says two
      // while the database holds one, and each service still refuses.
      const stale = vi
        .spyOn(OrganizationMembersRepository, "countOwners")
        .mockResolvedValue(2);
      try {
        for (const action of [
          () =>
            MembershipService.changeRole(ctx(admin, "owner"), owner, "admin"),
          () => MembershipService.deactivate(ctx(admin, "owner"), owner),
          () => AdminService.deleteUser(ctx(admin, "owner"), owner),
        ]) {
          await expect(action()).rejects.toMatchObject({ code: "LAST_OWNER" });
        }
      } finally {
        stale.mockRestore();
      }
      expect(await roleOf(owner)).toBe("owner");
      const [row] = await db.select().from(users).where(eq(users.id, owner));
      expect(row?.banned).toBe(false);
    });

    it("never changes the acting user's own role", async () => {
      await expect(
        MembershipService.changeRole(ctx(admin, "admin"), admin, "member"),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
      await expect(
        MembershipService.changeRole(ctx(owner, "owner"), owner, "admin"),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");
      await expect(
        MembershipService.changeRole(ctx(owner, "owner"), owner, "member"),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
      expect(await roleOf(owner)).toBe("owner");
    });

    it("never hands out a password reset for an owner, even to another owner", async () => {
      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");
      await expect(
        MembershipService.createPasswordResetLink(ctx(member, "owner"), owner),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_OWNER" });
      await expect(
        MembershipService.createPasswordResetLink(ctx(admin, "admin"), owner),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    });
  });

  const PAT = "epat_member-personal-access-token";

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
  }

  function authenticatePat() {
    return createProdAuthenticator().authenticate(
      new Request("https://todo-acme.gateway.example.com/mcp", {
        headers: { authorization: `Bearer ${PAT}` },
      }),
    );
  }

  describe("deactivate", () => {
    it("ends sessions and rejects the user's PAT", async () => {
      await seedCredentials();
      await expect(authenticatePat()).resolves.toMatchObject({ sub: member });

      await MembershipService.deactivate(ctx(admin, "admin"), member);

      expect(
        await db.select().from(sessions).where(eq(sessions.userId, member)),
      ).toEqual([]);
      await expect(authenticatePat()).resolves.toBeNull();
    });

    it("rejects a banned user's tokens even if they were never revoked", async () => {
      await seedCredentials();
      await MembershipService.deactivate(ctx(owner, "owner"), member);
      await db.update(userAccessTokens).set({ revokedAt: null });

      await expect(authenticatePat()).resolves.toBeNull();

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

    it("refuses to deactivate the last owner, admins (unless owner) and yourself", async () => {
      await expect(
        MembershipService.deactivate(ctx(admin, "admin"), owner),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
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
    it("lets an admin remove a member, never an admin or an owner (OWNER_REQUIRED)", async () => {
      await expect(
        AdminService.deleteUser(ctx(admin, "admin"), owner),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      const second = await seedMember(db, {
        organizationId: org,
        role: "admin",
      });
      await expect(
        AdminService.deleteUser(ctx(admin, "admin"), second),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      expect(
        await db.select().from(users).where(eq(users.id, owner)),
      ).toHaveLength(1);

      await AdminService.deleteUser(ctx(admin, "admin"), member);
      expect(await db.select().from(users).where(eq(users.id, member))).toEqual(
        [],
      );
    });

    it("revokes the deleted user's personal access tokens", async () => {
      await seedCredentials();
      await expect(authenticatePat()).resolves.toMatchObject({ sub: member });

      await AdminService.deleteUser(ctx(owner, "owner"), member);

      expect(await db.select().from(users).where(eq(users.id, member))).toEqual(
        [],
      );
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
      const [pat] = await db.select().from(userAccessTokens);
      expect(pat?.revokedAt).toBeInstanceOf(Date);
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
  });

  describe("password reset email", () => {
    // Mail goes out through the EMAIL binding; the fake keeps what was sent.
    beforeEach(() => {
      mailbox.sent = [];
      Object.assign(workerEnv, {
        EMAIL_FROM: "Every App <noreply@example.com>",
        EMAIL: {
          send: async (mail: Mail) => {
            mailbox.sent.push(mail);
            return { messageId: `m-${mailbox.sent.length}` };
          },
        },
      });
    });
    afterEach(() => {
      Object.assign(workerEnv, { EMAIL_FROM: undefined, EMAIL: undefined });
    });

    it("mails a plain member of this organization a genuine reset link", async () => {
      await expect(
        MembershipService.sendPasswordResetEmail(ctx(admin, "admin"), member),
      ).resolves.toEqual({ success: true });

      expect(mailbox.sent).toEqual([
        expect.objectContaining({
          to: `${member}@example.com`,
          subject: "Reset your Every App password",
        }),
      ]);
      expect(mailbox.sent[0]?.text).toMatch(
        /https:\/\/gateway\.example\.com\/reset-password\?token=[A-Za-z0-9_-]+/,
      );
    });

    it("refuses to mail an owner, another admin or yourself", async () => {
      await expect(
        MembershipService.sendPasswordResetEmail(ctx(admin, "admin"), owner),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await MembershipService.changeRole(ctx(owner, "owner"), member, "owner");
      await expect(
        MembershipService.sendPasswordResetEmail(ctx(member, "owner"), owner),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_OWNER" });
      const otherAdmin = await seedMember(db, {
        organizationId: org,
        role: "admin",
      });
      await expect(
        MembershipService.sendPasswordResetEmail(
          ctx(admin, "admin"),
          otherAdmin,
        ),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
      await expect(
        MembershipService.sendPasswordResetEmail(ctx(admin, "admin"), admin),
      ).rejects.toMatchObject({ code: "CANNOT_MANAGE_SELF" });
      expect(mailbox.sent).toEqual([]);
    });

    it("lets the owner mail an admin", async () => {
      // The one step above "member" the role rule allows; without this a
      // tightening that refused admins outright would pass the file.
      await expect(
        MembershipService.sendPasswordResetEmail(ctx(owner, "owner"), admin),
      ).resolves.toEqual({ success: true });
      expect(mailbox.sent).toEqual([
        expect.objectContaining({ to: `${admin}@example.com` }),
      ]);
    });

    it("refuses to mail a deactivated member", async () => {
      await MembershipService.deactivate(ctx(owner, "owner"), member);

      await expect(
        MembershipService.sendPasswordResetEmail(ctx(admin, "admin"), member),
      ).rejects.toMatchObject({ code: "PASSWORD_RESET_REQUIRES_ACTIVE_USER" });
      expect(mailbox.sent).toEqual([]);
    });

    it("refuses to mail someone who also belongs to another organization", async () => {
      const other = await seedOrganization(db, "other");
      await db.insert(members).values({
        id: "member-elsewhere",
        organizationId: other,
        userId: member,
        role: "owner",
        createdAt: new Date(),
      });

      await expect(
        MembershipService.sendPasswordResetEmail(ctx(admin, "admin"), member),
      ).rejects.toMatchObject({ code: "USER_IN_OTHER_ORGANIZATION" });
      expect(mailbox.sent).toEqual([]);
    });
  });

  describe("on the hosted gateway", () => {
    beforeEach(() => {
      workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    });
    afterEach(() => {
      workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
    });

    it("refuses to act on a member's account: no deactivating, reactivating or resetting it", async () => {
      await seedCredentials();
      for (const action of [
        () => MembershipService.deactivate(ctx(owner, "owner"), member),
        () => MembershipService.reactivate(ctx(owner, "owner"), member),
        () =>
          MembershipService.createPasswordResetLink(
            ctx(owner, "owner"),
            member,
          ),
        () =>
          MembershipService.sendPasswordResetEmail(ctx(owner, "owner"), member),
      ]) {
        await expect(action()).rejects.toMatchObject({
          code: "ACCOUNT_ACTIONS_UNAVAILABLE",
        });
      }
      const [user] = await db.select().from(users).where(eq(users.id, member));
      expect(user?.banned).toBe(false);
      await expect(authenticatePat()).resolves.toMatchObject({ sub: member });
    });

    it("removes a member from the organization but keeps their account", async () => {
      await seedCredentials();

      await expect(
        AdminService.deleteUser(ctx(owner, "owner"), member),
      ).resolves.toEqual({ deactivatedInstead: false });

      expect(
        await db.select().from(members).where(eq(members.userId, member)),
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, member)),
      ).toHaveLength(1);
      // What the organization gave them goes with the membership.
      await expect(authenticatePat()).resolves.toBeNull();
      await Promise.all(background.splice(0));
    });
  });
});
