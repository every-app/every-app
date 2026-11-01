/**
 * Sign-up on the hosted gateway, through the real Better Auth configuration
 * against a migrated SQLite database: open registration into a personal
 * organization, email verification before sign-in, invitees joining only
 * the inviting organization, the session's starting organization, the
 * invite-only switch, and self-hosted staying as it was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const GATEWAY_URL = "https://gateway.example.com";

type Mail = { to: string; subject: string; html: string; text: string };
const mailbox = vi.hoisted(() => ({ sent: [] as Mail[] }));
const workerEnv = vi.hoisted(() => ({
  GATEWAY_DEPLOYMENT_MODE: "hosted" as string,
  GATEWAY_URL: "https://gateway.example.com",
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  DB: {},
  HOSTED_OPEN_SIGNUP: undefined as string | undefined,
  EMAIL_FROM: "EveryApp <noreply@example.com>" as string | undefined,
  EMAIL: undefined as { send: (mail: Mail) => Promise<unknown> } | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));
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
import { count, eq } from "drizzle-orm";
import { createAuth } from "@/auth";
import {
  accounts,
  invitations,
  members,
  organizations,
  ownerSetupTokens,
  sessions,
  users,
} from "@/db/schema";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { InvitationService } from "@/server/services/InvitationService";
import { SetupService } from "@/server/services/SetupService";
import { createTestDb, seedOrganization } from "@/test/sqlite-db";

const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const PASSWORD = "stranger-password-1";

function authRequest(
  path: string,
  init: { body?: unknown; cookie?: string } = {},
): Request {
  return new Request(`${GATEWAY_URL}/api/auth${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      origin: GATEWAY_URL,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function signUp(
  email: string,
  options: {
    name?: string;
    invitationToken?: string;
    callbackURL?: string;
  } = {},
) {
  const query = options.invitationToken
    ? `?invitationToken=${encodeURIComponent(options.invitationToken)}`
    : "";
  return createAuth().handler(
    authRequest(`/sign-up/email${query}`, {
      body: {
        name: options.name ?? email.split("@")[0],
        email,
        password: PASSWORD,
        ...(options.callbackURL ? { callbackURL: options.callbackURL } : {}),
      },
    }),
  );
}

function signIn(email: string, password = PASSWORD) {
  return createAuth().handler(
    authRequest("/sign-in/email", { body: { email, password } }),
  );
}

async function signedIn(email: string, password = PASSWORD): Promise<string> {
  const response = await signIn(email, password);
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function activeOrganizationOf(cookie: string): Promise<string | null> {
  const response = await createAuth().handler(
    authRequest("/get-session", { cookie }),
  );
  const body = (await response.json()) as {
    session: { activeOrganizationId?: string | null };
  } | null;
  return body?.session.activeOrganizationId ?? null;
}

function mailsTo(email: string, subject?: string): Mail[] {
  return mailbox.sent.filter(
    (mail) => mail.to === email && (!subject || mail.subject === subject),
  );
}

const VERIFY_SUBJECT = "Verify your EveryApp email";

/** The link in the latest verification mail to this address. */
function verificationLink(email: string): string {
  const mail = mailsTo(email, VERIFY_SUBJECT).at(-1);
  expect(mail, `a verification mail to ${email}`).toBeDefined();
  return mail!.text.slice(mail!.text.indexOf("https://"));
}

/** Follow a verification link; returns where it redirects and the cookie. */
async function verify(link: string) {
  const response = await createAuth().handler(
    new Request(link, { headers: { origin: GATEWAY_URL } }),
  );
  return {
    status: response.status,
    location: response.headers.get("location"),
    cookie: cookieOf(response),
  };
}

function inviteTokenOf(inviteUrl: string): string {
  return new URL(inviteUrl).searchParams.get("token")!;
}

async function rows(db: TestDb, table: typeof users | typeof organizations) {
  const [row] = await db.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

describe("hosted sign-up (SQLite)", () => {
  let db: TestDb;
  let platform: { orgId: string; userId: string; role: "owner" };
  let ownerCookie: string;

  async function claim() {
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
    platform = {
      orgId: owner.organizationId,
      userId: owner.userId,
      role: "owner",
    };
    ownerCookie = await signedIn(OWNER.email, OWNER.password);
  }

  function invite(email: string, from = platform, cookie = ownerCookie) {
    return InvitationService.invite(from, new Headers({ cookie }), {
      email,
      role: "member",
    });
  }

  /** Sign up without an invitation, verify and sign in. */
  async function stranger(email: string, name?: string) {
    expect((await signUp(email, { name })).status).toBe(200);
    const { cookie } = await verify(verificationLink(email));
    expect(cookie).not.toBe("");
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const [membership] = await db
      .select()
      .from(members)
      .where(eq(members.userId, user!.id));
    return {
      userId: user!.id,
      orgId: membership!.organizationId,
      cookie: await signedIn(email),
    };
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearOrgContextCacheForTests();
    mailbox.sent = [];
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    workerEnv.HOSTED_OPEN_SIGNUP = undefined;
    workerEnv.EMAIL_FROM = "EveryApp <noreply@example.com>";
    workerEnv.EMAIL = {
      send: async (mail: Mail) => {
        mailbox.sent.push(mail);
        return { messageId: `m-${mailbox.sent.length}` };
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("on a claimed gateway", () => {
    beforeEach(claim);

    it("verifies the setup owner without mail, so they sign in at once", async () => {
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, platform.userId));
      expect(owner?.emailVerified).toBe(true);
      expect(mailbox.sent).toEqual([]);
      await expect(activeOrganizationOf(ownerCookie)).resolves.toBe(
        platform.orgId,
      );
    });

    it("signs a stranger up into an organization of their own, as its owner", async () => {
      const response = await signUp("ada@example.com", {
        name: "Ada Lovelace",
        callbackURL: "/verify-email",
      });
      expect(response.status).toBe(200);

      const [ada] = await db
        .select()
        .from(users)
        .where(eq(users.email, "ada@example.com"));
      expect(ada?.emailVerified).toBe(false);
      const memberships = await db
        .select()
        .from(members)
        .where(eq(members.userId, ada!.id));
      expect(memberships).toEqual([expect.objectContaining({ role: "owner" })]);
      const [personal] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, memberships[0]!.organizationId));
      expect(personal).toMatchObject({
        name: "Ada Lovelace",
        status: "active",
        metadata: JSON.stringify({ personalFor: ada!.id }),
      });
      expect(personal?.slug).toMatch(/^ada-lovelace-[a-z0-9]{6}$/);
      // Nothing else: the platform organization is untouched.
      expect(await rows(db, organizations)).toBe(2);

      // No sign-in until the email is verified.
      const refused = await signIn("ada@example.com");
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({
        code: "EMAIL_NOT_VERIFIED",
      });

      // The mailed link verifies, signs in once and lands on the callback.
      const link = verificationLink("ada@example.com");
      expect(new URL(link).pathname).toBe("/api/auth/verify-email");
      expect(new URL(link).searchParams.get("token")).toBeTruthy();
      const verified = await verify(link);
      expect(verified.status).toBe(302);
      expect(verified.location).toBe("/verify-email");
      await expect(activeOrganizationOf(verified.cookie)).resolves.toBe(
        personal!.id,
      );
      // Clicked again, it signs nobody in.
      expect((await verify(link)).cookie).toBe("");

      // A password sign-in starts in the personal organization too.
      await expect(
        activeOrganizationOf(await signedIn("ada@example.com")),
      ).resolves.toBe(personal!.id);
    });

    it("names the organization after the email when the name won't do", async () => {
      expect(
        (await signUp("grace@example.com", { name: "Grace\nBcc: x" })).status,
      ).toBe(200);
      const names = (await db.select().from(organizations)).map((o) => o.name);
      expect(names).toContain("grace");
    });

    it("leaves nothing behind when the organization can't be made", async () => {
      const before = {
        users: await rows(db, users),
        organizations: await rows(db, organizations),
      };
      // D1 batches fail (the organization's, and the mail budget's).
      const batch = vi
        .spyOn(db, "batch")
        .mockRejectedValue(new Error("D1 unavailable"));

      const response = await signUp("unlucky@example.com");
      batch.mockRestore();
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        code: "ACCOUNT_CREATION_FAILED",
      });

      expect(await rows(db, users)).toBe(before.users);
      expect(await rows(db, organizations)).toBe(before.organizations);
      expect(
        await db
          .select()
          .from(accounts)
          .where(eq(accounts.accountId, "unlucky@example.com")),
      ).toEqual([]);
      expect(await db.select().from(members)).toHaveLength(1);

      // The address is free to sign up again.
      expect((await signUp("unlucky@example.com")).status).toBe(200);
    });

    it("gives an invitee no organization of their own, only the inviting one", async () => {
      const { inviteUrl } = await invite("invitee@example.com");
      const token = inviteTokenOf(inviteUrl);
      expect(mailsTo("invitee@example.com")).toEqual([
        expect.objectContaining({
          subject: "You have been invited to EveryApp",
        }),
      ]);

      const organizationsBefore = await rows(db, organizations);
      expect(
        (
          await signUp("invitee@example.com", {
            invitationToken: token,
            callbackURL: `/verify-email?redirect=${encodeURIComponent(`/accept-invitation?token=${token}`)}`,
          })
        ).status,
      ).toBe(200);
      expect(await rows(db, organizations)).toBe(organizationsBefore);

      // Invitees verify too, and the link brings them back to the invitation.
      expect((await signIn("invitee@example.com")).status).toBe(403);
      const verified = await verify(verificationLink("invitee@example.com"));
      expect(verified.location).toBe(
        `/verify-email?redirect=${encodeURIComponent(`/accept-invitation?token=${token}`)}`,
      );
      // No membership yet: the session starts in none.
      await expect(activeOrganizationOf(verified.cookie)).resolves.toBeNull();

      const [invitee] = await db
        .select()
        .from(users)
        .where(eq(users.email, "invitee@example.com"));
      await InvitationService.accept(
        { id: invitee!.id, email: "invitee@example.com" },
        new Headers({ cookie: verified.cookie }),
        token,
      );
      const memberships = await db
        .select()
        .from(members)
        .where(eq(members.userId, invitee!.id));
      expect(memberships.map((m) => m.organizationId)).toEqual([
        platform.orgId,
      ]);
      await expect(
        activeOrganizationOf(await signedIn("invitee@example.com")),
      ).resolves.toBe(platform.orgId);
    });

    it("still refuses a bad invite link, open sign-up or not", async () => {
      const { inviteUrl } = await invite("invitee@example.com");
      const token = inviteTokenOf(inviteUrl);
      expect(
        (await signUp("someone@example.com", { invitationToken: token }))
          .status,
      ).toBe(403);
      expect(
        (await signUp("invitee@example.com", { invitationToken: "einv_nope" }))
          .status,
      ).toBe(403);
      expect(
        await db
          .select()
          .from(users)
          .where(eq(users.email, "someone@example.com")),
      ).toEqual([]);
    });

    it("starts a two-organization session in the personal one", async () => {
      const ada = await stranger("ada@example.com");
      const { inviteUrl } = await invite("ada@example.com");
      await InvitationService.accept(
        { id: ada.userId, email: "ada@example.com" },
        new Headers({ cookie: ada.cookie }),
        inviteTokenOf(inviteUrl),
      );
      expect(
        await db.select().from(members).where(eq(members.userId, ada.userId)),
      ).toHaveLength(2);

      // Even after working in the other one.
      await db
        .update(sessions)
        .set({ activeOrganizationId: platform.orgId, updatedAt: new Date() })
        .where(eq(sessions.userId, ada.userId));
      await expect(
        activeOrganizationOf(await signedIn("ada@example.com")),
      ).resolves.toBe(ada.orgId);
    });

    it("lets only a verified account invite, and escapes its organization's name", async () => {
      expect(
        (await signUp("mallory@example.com", { name: "<b>Mallory</b> & co" }))
          .status,
      ).toBe(200);
      const [mallory] = await db
        .select()
        .from(users)
        .where(eq(users.email, "mallory@example.com"));
      const [membership] = await db
        .select()
        .from(members)
        .where(eq(members.userId, mallory!.id));
      const ctx = {
        orgId: membership!.organizationId,
        userId: mallory!.id,
        role: "owner" as const,
      };

      await expect(invite("victim@example.com", ctx, "")).rejects.toMatchObject(
        { code: "EMAIL_NOT_VERIFIED" },
      );
      expect(await db.select().from(invitations)).toEqual([]);

      const { cookie } = await verify(verificationLink("mallory@example.com"));
      await invite("victim@example.com", ctx, cookie);
      const [mail] = mailsTo("victim@example.com");
      expect(mail?.subject).toBe(
        "You have been invited to <b>Mallory</b> & co",
      );
      expect(mail?.html).toContain(
        "mallory@example.com invited you to join &lt;b&gt;Mallory&lt;/b&gt; &amp; co.",
      );
      expect(mail?.html).not.toContain("<b>");
    });

    it("resends verification mail a few times a day per address, and no more", async () => {
      expect((await signUp("ada@example.com")).status).toBe(200);
      const resend = () =>
        createAuth().handler(
          authRequest("/send-verification-email", {
            body: { email: "ada@example.com", callbackURL: "/verify-email" },
          }),
        );
      for (let i = 0; i < 6; i += 1) {
        // The same answer whether or not a mail went.
        expect((await resend()).status).toBe(200);
      }
      // The sign-up's mail and four resends: five a day to one address.
      expect(mailsTo("ada@example.com", VERIFY_SUBJECT)).toHaveLength(5);
    }, 15_000);

    it("keeps the preview invite-only with HOSTED_OPEN_SIGNUP=false", async () => {
      workerEnv.HOSTED_OPEN_SIGNUP = "false";
      const refused = await signUp("ada@example.com");
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({
        message: "Sign up is invite-only. Please use the invitation link.",
      });
      expect(
        await db.select().from(users).where(eq(users.email, "ada@example.com")),
      ).toEqual([]);

      const { inviteUrl } = await invite("invitee@example.com");
      expect(
        (
          await signUp("invitee@example.com", {
            invitationToken: inviteTokenOf(inviteUrl),
          })
        ).status,
      ).toBe(200);
      expect(await rows(db, organizations)).toBe(1);
    });

    it("refuses every sign-up with an operator error when it can't send email", async () => {
      workerEnv.EMAIL = undefined;
      const { inviteUrl } = await invite("invitee@example.com");
      const before = await rows(db, users);

      for (const response of [
        await signUp("ada@example.com"),
        await signUp("invitee@example.com", {
          invitationToken: inviteTokenOf(inviteUrl),
        }),
      ]) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          code: "EMAIL_NOT_CONFIGURED",
        });
      }
      expect(await rows(db, users)).toBe(before);
    });
  });

  it("refuses open sign-up until the gateway is claimed", async () => {
    const response = await signUp("early@example.com");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      message: "This gateway has not been set up yet.",
    });
    expect(await rows(db, users)).toBe(0);
    // The claim still works.
    await claim();
  });

  describe("self-hosted", () => {
    beforeEach(async () => {
      workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
      await claim();
    });

    it("stays invite-only, with no personal organization and no verification", async () => {
      const refused = await signUp("ada@example.com");
      expect(refused.status).toBe(403);
      await expect(refused.json()).resolves.toMatchObject({
        message: "Sign up is invite-only. Please use the invitation link.",
      });

      const { inviteUrl } = await invite("invitee@example.com");
      const organizationsBefore = await rows(db, organizations);
      expect(
        (
          await signUp("invitee@example.com", {
            invitationToken: inviteTokenOf(inviteUrl),
          })
        ).status,
      ).toBe(200);
      expect(await rows(db, organizations)).toBe(organizationsBefore);
      // Signs in unverified, and no verification mail was sent.
      expect((await signIn("invitee@example.com")).status).toBe(200);
      expect(mailsTo("invitee@example.com", VERIFY_SUBJECT)).toEqual([]);
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, platform.userId));
      expect(owner?.emailVerified).toBe(false);

      // Nor will it send one on request.
      const resend = await createAuth().handler(
        authRequest("/send-verification-email", {
          body: { email: "invitee@example.com" },
        }),
      );
      expect(resend.status).toBe(400);
      expect(mailsTo("invitee@example.com", VERIFY_SUBJECT)).toEqual([]);
    });

    it("signs up without verification when email isn't configured", async () => {
      workerEnv.EMAIL = undefined;
      workerEnv.EMAIL_FROM = undefined;
      const { inviteUrl } = await invite("invitee@example.com");
      expect(
        (
          await signUp("invitee@example.com", {
            invitationToken: inviteTokenOf(inviteUrl),
          })
        ).status,
      ).toBe(200);
      expect((await signIn("invitee@example.com")).status).toBe(200);
    });

    it("starts sessions in the only, then the last active, then the first organization", async () => {
      const { inviteUrl } = await invite("invitee@example.com");
      const token = inviteTokenOf(inviteUrl);
      expect(
        (await signUp("invitee@example.com", { invitationToken: token }))
          .status,
      ).toBe(200);

      // No membership: no organization.
      const first = await signedIn("invitee@example.com");
      await expect(activeOrganizationOf(first)).resolves.toBeNull();

      // One.
      const [invitee] = await db
        .select()
        .from(users)
        .where(eq(users.email, "invitee@example.com"));
      await InvitationService.accept(
        { id: invitee!.id, email: "invitee@example.com" },
        new Headers({ cookie: first }),
        token,
      );
      await expect(
        activeOrganizationOf(await signedIn("invitee@example.com")),
      ).resolves.toBe(platform.orgId);

      // Two: the first joined, until another was the last active.
      const other = await seedOrganization(db, "other");
      await db.insert(members).values({
        id: "member-other",
        organizationId: other,
        userId: invitee!.id,
        role: "member",
        createdAt: new Date(Date.now() + 1000),
      });
      await expect(
        activeOrganizationOf(await signedIn("invitee@example.com")),
      ).resolves.toBe(platform.orgId);

      // Switched to the other one in an earlier session.
      const [earlier] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, invitee!.id));
      await db
        .update(sessions)
        .set({
          activeOrganizationId: other,
          updatedAt: new Date(Date.now() + 60_000),
        })
        .where(eq(sessions.id, earlier!.id));
      await expect(
        activeOrganizationOf(await signedIn("invitee@example.com")),
      ).resolves.toBe(other);

      // A last-active organization they have left doesn't count.
      await db.delete(members).where(eq(members.id, "member-other"));
      await expect(
        activeOrganizationOf(await signedIn("invitee@example.com")),
      ).resolves.toBe(platform.orgId);
    });
  });
});
