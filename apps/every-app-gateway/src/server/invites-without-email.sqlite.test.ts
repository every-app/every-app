/**
 * Invitations and password resets on a gateway with no email configured,
 * end to end through the real Better Auth configuration on SQLite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const GATEWAY_URL = "https://gateway.example.com";

vi.mock("cloudflare:workers", () => ({
  // No EMAIL binding, no EMAIL_FROM: email is not configured.
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: "https://gateway.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    DB: {},
  },
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

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuth } from "@/auth";
import {
  invitationLinkTokens,
  invitations,
  members,
  ownerSetupTokens,
  users,
  verifications,
} from "@/db/schema";
import { AdminService } from "@/server/services/AdminService";
import { InvitationService } from "@/server/services/InvitationService";
import { MembershipService } from "@/server/services/MembershipService";
import { OrganizationService } from "@/server/services/OrganizationService";
import { SetupService } from "@/server/services/SetupService";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { createTestDb, seedOrganization } from "@/test/sqlite-db";

const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const PASSWORD = "invitee-password-1";

function authRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${GATEWAY_URL}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: GATEWAY_URL,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function authGet(path: string, cookie: string): Request {
  return new Request(`${GATEWAY_URL}/api/auth${path}`, {
    headers: { origin: GATEWAY_URL, cookie },
  });
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await createAuth().handler(
    authRequest("/sign-in/email", { email, password }),
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Sign up through an invite link, with whatever query the client sends. */
function signUpWithQuery(query: string, email: string) {
  return createAuth().handler(
    authRequest(`/sign-up/email?${query}`, {
      name: "Invitee",
      email,
      password: PASSWORD,
    }),
  );
}

function signUp(token: string, email: string) {
  return signUpWithQuery(`invitationToken=${encodeURIComponent(token)}`, email);
}

function tokenOf(inviteUrl: string): string {
  const url = new URL(inviteUrl);
  expect(`${url.origin}${url.pathname}`).toBe(
    `${GATEWAY_URL}/accept-invitation`,
  );
  return url.searchParams.get("token")!;
}

describe("without email (SQLite)", () => {
  let db: TestDb;
  let ownerCtx: { orgId: string; userId: string; role: "owner" };
  let ownerCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearOrgContextCacheForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await db.insert(ownerSetupTokens).values({
      id: "link-1",
      kind: "claim",
      tokenHash: createHash("sha256").update("est_setup").digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const owner = await SetupService.claimOwner({
      token: "est_setup",
      name: "Owner",
      ...OWNER,
    });
    ownerCtx = {
      orgId: owner.organizationId,
      userId: owner.userId,
      role: "owner",
    };
    ownerCookie = await signIn(OWNER.email, OWNER.password);
  });

  function invite(
    email = "invitee@example.com",
    role: "member" | "admin" = "member",
  ) {
    return InvitationService.invite(
      ownerCtx,
      new Headers({ cookie: ownerCookie }),
      { email, role },
    );
  }

  async function userIdOf(email: string): Promise<string> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user!.id;
  }

  /** Accept as a signed-in account, the way the accept page's server function does. */
  async function accept(email: string, cookie: string, token: string) {
    return InvitationService.accept(
      { id: await userIdOf(email), email },
      new Headers({ cookie }),
      token,
    );
  }

  /** Invite, sign up through the link, sign in and join. */
  async function join(email: string, role: "member" | "admin" = "member") {
    const token = tokenOf((await invite(email, role)).inviteUrl);
    expect((await signUp(token, email)).status).toBe(200);
    const cookie = await signIn(email);
    await accept(email, cookie, token);
    return { userId: await userIdOf(email), cookie };
  }

  async function roleOf(email: string): Promise<string | undefined> {
    const [member] = await db
      .select()
      .from(members)
      .where(eq(members.userId, await userIdOf(email)));
    return member?.role;
  }

  it("creates the invitation and hands back a 72-hour link with its own secret", async () => {
    const before = Date.now();
    const result = await invite();

    expect(result).toMatchObject({
      email: "invitee@example.com",
      emailConfigured: false,
      emailSent: false,
    });
    const token = tokenOf(result.inviteUrl);
    expect(token).toMatch(/^einv_[A-Za-z0-9_-]{43}$/);
    expect(result.inviteUrl).not.toContain(result.invitationId);
    const hours = (result.expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThan(72.1);
    const [row] = await db.select().from(invitations);
    expect(row?.status).toBe("pending");

    // Only the SHA-256 of the secret is stored.
    const links = await db.select().from(invitationLinkTokens);
    expect(links).toEqual([
      expect.objectContaining({
        invitationId: result.invitationId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      }),
    ]);
    expect(JSON.stringify(links)).not.toContain(token);
  });

  it("never logs the link's secret", async () => {
    const log = vi.mocked(console.log);
    log.mockClear();
    const { inviteUrl } = await invite();

    const lines = log.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.some((line) => line.includes("invitation.created"))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain(tokenOf(inviteUrl));
  });

  it("lets the invitee join through the copied link, exactly once", async () => {
    const { inviteUrl, invitationId } = await invite(
      "invitee@example.com",
      "admin",
    );
    const token = tokenOf(inviteUrl);

    // Only with the invited email.
    expect((await signUp(token, "someone@example.com")).status).toBe(403);
    expect((await signUp(token, "invitee@example.com")).status).toBe(200);

    const cookie = await signIn("invitee@example.com");
    await expect(accept("invitee@example.com", cookie, token)).resolves.toEqual(
      { organizationId: ownerCtx.orgId },
    );
    expect(await roleOf("invitee@example.com")).toBe("admin");

    // The link is spent: no second account, no second join.
    expect((await signUp(token, "invitee@example.com")).status).toBe(403);
    await expect(
      accept("invitee@example.com", cookie, token),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
    await expect(
      InvitationService.getInvitationLink(ownerCtx, invitationId),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
    expect(await db.select().from(invitationLinkTokens)).toEqual([]);
  });

  it("never accepts the invitation id in place of the link's secret", async () => {
    const { inviteUrl, invitationId } = await invite(
      "invitee@example.com",
      "admin",
    );
    const token = tokenOf(inviteUrl);

    // Sign-up with the id (an old-style link, or one read off the API).
    for (const query of [
      `invitationId=${invitationId}`,
      `invitationToken=${invitationId}`,
      `invitationToken=einv_${invitationId}`,
    ]) {
      expect((await signUpWithQuery(query, "invitee@example.com")).status).toBe(
        403,
      );
    }
    expect(await db.select().from(users)).toHaveLength(1);

    // An account with the invited email still can't join with the id: not
    // through the gateway, and not through Better Auth's own endpoint.
    expect((await signUp(token, "invitee@example.com")).status).toBe(200);
    const cookie = await signIn("invitee@example.com");
    await expect(
      accept("invitee@example.com", cookie, invitationId),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
    const direct = await createAuth().handler(
      authRequest("/organization/accept-invitation", { invitationId }, cookie),
    );
    expect(direct.status).toBe(404);
    expect(await roleOf("invitee@example.com")).toBeUndefined();

    // The link's secret works.
    await accept("invitee@example.com", cookie, token);
    expect(await roleOf("invitee@example.com")).toBe("admin");
  });

  it("gives a plain member no way to read an invitation id or link secret", async () => {
    const member = await join("member@example.com");
    const { invitationId, inviteUrl } = await invite(
      "new-admin@example.com",
      "admin",
    );
    const secrets = [invitationId, tokenOf(inviteUrl)];

    // Closed: they return every pending invitation to any member.
    for (const path of [
      "/organization/list-invitations",
      "/organization/get-full-organization",
    ]) {
      const response = await createAuth().handler(authGet(path, member.cookie));
      expect(response.status).toBe(404);
    }
    // Still open, and none of them mention the invitation.
    for (const [path, status] of [
      ["/organization/list", 200],
      ["/organization/get-organization", 200],
      ["/organization/get-active-member", 200],
      ["/organization/get-active-member-role", 200],
      ["/organization/list-members", 200],
      // Only the caller's own invitations, and only with a verified email.
      ["/organization/list-user-invitations", 403],
    ] as const) {
      const response = await createAuth().handler(authGet(path, member.cookie));
      expect(response.status).toBe(status);
      const body = await response.text();
      for (const secret of secrets) expect(body).not.toContain(secret);
    }

    // What the UI reads instead: the organization, and nothing about it.
    await expect(
      OrganizationService.getActive({
        userId: member.userId,
        activeOrganizationId: ownerCtx.orgId,
      }),
    ).resolves.toEqual({
      id: ownerCtx.orgId,
      name: "Owner",
      slug: "owner",
      role: "member",
    });
    // As with get-full-organization: none until the session has picked one
    // (the organization picker then offers it), and never a stranger's.
    await expect(
      OrganizationService.getActive({
        userId: member.userId,
        activeOrganizationId: null,
      }),
    ).resolves.toBeNull();
    await expect(
      OrganizationService.getActive({
        userId: member.userId,
        activeOrganizationId: await seedOrganization(db, "not-theirs"),
      }),
    ).resolves.toBeNull();
  });

  it("rejects an expired invitation link", async () => {
    const { inviteUrl, invitationId } = await invite();
    const token = tokenOf(inviteUrl);
    expect((await signUp(token, "invitee@example.com")).status).toBe(200);
    const cookie = await signIn("invitee@example.com");
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, invitationId));

    expect((await signUp(token, "invitee@example.com")).status).toBe(403);
    await expect(
      accept("invitee@example.com", cookie, token),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
    await expect(
      InvitationService.getInvitationLink(ownerCtx, invitationId),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
  });

  it("rejects the link of a canceled invitation", async () => {
    const { inviteUrl, invitationId } = await invite();
    await AdminService.cancelInvitation(
      ownerCtx,
      invitationId,
      new Headers({ cookie: ownerCookie }),
    );

    expect(
      (await signUp(tokenOf(inviteUrl), "invitee@example.com")).status,
    ).toBe(403);
  });

  it("copies a new link without breaking the emailed one", async () => {
    const first = tokenOf((await invite()).inviteUrl);
    const [{ id: invitationId }] = await db.select().from(invitations);
    const copied = tokenOf(
      (await InvitationService.getInvitationLink(ownerCtx, invitationId!))
        .inviteUrl,
    );
    expect(copied).not.toBe(first);

    // Either link signs the invitee up; the other dies with the invitation.
    expect((await signUp(first, "invitee@example.com")).status).toBe(200);
    const cookie = await signIn("invitee@example.com");
    await accept("invitee@example.com", cookie, copied);
    await expect(
      accept("invitee@example.com", cookie, first),
    ).rejects.toMatchObject({ code: "INVITATION_TOKEN_INVALID" });
  });

  it("only lets the invited account accept", async () => {
    const other = await join("other@example.com");
    const token = tokenOf((await invite("invitee@example.com")).inviteUrl);

    await expect(
      accept("other@example.com", other.cookie, token),
    ).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });
  });

  it("generates a single-use password-reset link an admin can share", async () => {
    const invitee = await join("invitee@example.com");

    const link = await MembershipService.createPasswordResetLink(
      ownerCtx,
      invitee.userId,
    );
    expect(link.url).toMatch(
      /^https:\/\/gateway\.example\.com\/reset-password\?token=[A-Za-z0-9_-]+$/,
    );
    const token = new URL(link.url).searchParams.get("token")!;

    const reset = () =>
      createAuth().handler(
        authRequest("/reset-password", {
          token,
          newPassword: "brand-new-password-2",
        }),
      );
    expect((await reset()).status).toBe(200);
    await signIn("invitee@example.com", "brand-new-password-2");
    expect((await reset()).status).toBe(400);
  });

  it("never hands out a reset link for someone who also belongs to another organization", async () => {
    const invitee = await join("invitee@example.com");
    const otherOrg = await seedOrganization(db, "elsewhere");
    await db.insert(members).values({
      id: "member-elsewhere",
      organizationId: otherOrg,
      userId: invitee.userId,
      role: "owner",
      createdAt: new Date(),
    });

    // The password is account-wide: resetting it here would take over their
    // owner (or any) membership there.
    for (const role of ["owner", "member"]) {
      await db
        .update(members)
        .set({ role })
        .where(eq(members.id, "member-elsewhere"));
      await expect(
        MembershipService.createPasswordResetLink(ownerCtx, invitee.userId),
      ).rejects.toMatchObject({ code: "USER_IN_OTHER_ORGANIZATION" });
    }
    expect(await db.select().from(verifications)).toEqual([]);
  });

  it("never hands out a reset link for an owner", async () => {
    const admin = await join("admin@example.com", "admin");

    await expect(
      MembershipService.createPasswordResetLink(
        { orgId: ownerCtx.orgId, userId: admin.userId, role: "admin" },
        ownerCtx.userId,
      ),
    ).rejects.toMatchObject({ code: "CANNOT_MANAGE_OWNER" });
  });
});
