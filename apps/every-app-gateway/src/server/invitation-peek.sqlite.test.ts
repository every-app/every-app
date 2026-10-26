/**
 * The invite link lookup the accept page makes before sign-in, through the
 * real route and repositories on SQLite: what a live link shows, and the one
 * answer every dead link gets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const GATEWAY_URL = "https://gateway.example.com";

vi.mock("cloudflare:workers", () => ({
  env: { GATEWAY_URL: "https://gateway.example.com", DB: {} },
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(testDb), schema };
});

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  invitationLinkTokens,
  invitations,
  members,
  organizations,
  users,
} from "@/db/schema";
import { Route } from "@/routes/api/invitations/lookup";
import { createTestDb } from "@/test/sqlite-db";

const handlers = (Route as any).options.server.handlers as {
  POST: (context: { request: Request }) => Promise<Response>;
};

const ORG_ID = "org-acme";
const LIVE_TOKEN = "einv_live-token-0123456789abcdefghijklmnopqrstuv";
const UNKNOWN_TOKEN = "einv_never-minted-0123456789abcdefghijklmnopqrs";

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function lookup(
  body: unknown,
  init: { headers?: Record<string, string>; raw?: string } = {},
): Promise<Response> {
  return handlers.POST({
    request: new Request(`${GATEWAY_URL}/api/invitations/lookup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: GATEWAY_URL,
        ...init.headers,
      },
      body: init.raw ?? JSON.stringify(body),
    }),
  });
}

describe("POST /api/invitations/lookup (SQLite)", () => {
  let db: TestDb;
  let sequence = 0;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    await db.insert(organizations).values({
      id: ORG_ID,
      name: "Acme Corp",
      slug: "acme",
      createdAt: new Date(),
    });
    await db.insert(users).values({
      id: "owner",
      name: "Owner",
      email: "owner@example.com",
    });
    // The inviter must still be an owner or admin for a link to be live.
    await db.insert(members).values({
      id: "owner-membership",
      organizationId: ORG_ID,
      userId: "owner",
      role: "owner",
      createdAt: new Date(),
    });
  });

  /** A pending invitation with one link, 72 hours out unless told otherwise. */
  async function inviteWithLink(
    token: string,
    overrides: { status?: string; expiresAt?: Date; email?: string } = {},
  ): Promise<string> {
    sequence += 1;
    const id = `invitation-${sequence}`;
    await db.insert(invitations).values({
      id,
      organizationId: ORG_ID,
      email: overrides.email ?? "invitee@example.com",
      role: "member",
      status: overrides.status ?? "pending",
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 72 * 3_600_000),
      inviterId: "owner",
    });
    await db.insert(invitationLinkTokens).values({
      id: `link-${sequence}`,
      invitationId: id,
      tokenHash: sha256(token),
    });
    return id;
  }

  it("names the organization and masks the invited address for a live link", async () => {
    await inviteWithLink(LIVE_TOKEN);

    const response = await lookup({ token: LIVE_TOKEN });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      organizationName: "Acme Corp",
      invitedEmail: "i•••@example.com",
    });
  });

  it("answers the same 404 once the inviter is no longer an owner or admin", async () => {
    const id = await inviteWithLink(LIVE_TOKEN);
    await db
      .update(members)
      .set({ role: "member" })
      .where(eq(members.userId, "owner"));

    const response = await lookup({ token: LIVE_TOKEN });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "INVITATION_NOT_VALID",
    });
    // Cancelled on the spot, link deleted: nothing left to probe or accept.
    const [row] = await db
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.id, id));
    expect(row?.status).toBe("canceled");
    await expect(db.select().from(invitationLinkTokens)).resolves.toEqual([]);
  });

  it("answers one identical 404 for unknown, used, canceled and expired links", async () => {
    await inviteWithLink("einv_expired", {
      expiresAt: new Date(Date.now() - 1000),
    });
    const acceptedId = await inviteWithLink("einv_accepted", {
      status: "accepted",
    });
    await inviteWithLink("einv_canceled", { status: "canceled" });
    await inviteWithLink("einv_rejected", { status: "rejected" });
    // Accepting an invitation also deletes its links; the row is gone, not
    // only its status changed.
    const spentId = await inviteWithLink("einv_spent", { status: "accepted" });
    await db
      .delete(invitationLinkTokens)
      .where(eq(invitationLinkTokens.invitationId, spentId));

    const dead = [
      UNKNOWN_TOKEN,
      "einv_expired",
      "einv_accepted",
      "einv_canceled",
      "einv_rejected",
      "einv_spent",
      // The invitation id is never a credential, with or without the prefix.
      acceptedId,
      `einv_${acceptedId}`,
      // Nor is the stored hash.
      sha256("einv_accepted"),
    ];
    const answers = await Promise.all(
      dead.map(async (token) => {
        const response = await lookup({ token });
        return {
          status: response.status,
          body: await response.text(),
          cacheControl: response.headers.get("cache-control"),
        };
      }),
    );
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 404,
        body: JSON.stringify({ error: "INVITATION_NOT_VALID" }),
        cacheControl: "no-store, no-cache, must-revalidate",
      });
    }
  });

  it("keeps answering for a live link beside dead ones", async () => {
    await inviteWithLink(LIVE_TOKEN, { email: "B@Example.com" });
    await inviteWithLink("einv_canceled", { status: "canceled" });

    await expect((await lookup({ token: LIVE_TOKEN })).json()).resolves.toEqual(
      {
        organizationName: "Acme Corp",
        invitedEmail: "•••@example.com",
      },
    );
    expect((await lookup({ token: "einv_canceled" })).status).toBe(404);
  });

  it("rejects requests from another origin before any lookup", async () => {
    await inviteWithLink(LIVE_TOKEN);
    for (const origin of ["https://todo.gateway.example.com", ""]) {
      const response = await lookup(
        { token: LIVE_TOKEN },
        { headers: { origin } },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "ORIGIN_NOT_ALLOWED",
      });
    }
  });

  it("rejects non-JSON bodies, malformed JSON and tokens outside 1-256 characters", async () => {
    await inviteWithLink(LIVE_TOKEN);

    const form = await lookup(null, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      raw: `token=${LIVE_TOKEN}`,
    });
    expect(form.status).toBe(415);

    expect((await lookup(null, { raw: "{" })).status).toBe(400);
    expect((await lookup({ token: "" })).status).toBe(400);
    expect((await lookup({ token: "x".repeat(257) })).status).toBe(400);
    expect((await lookup({})).status).toBe(400);
    expect((await lookup({ token: 42 })).status).toBe(400);
  });

  it("only declares POST, so other methods get 405", () => {
    expect(Object.keys(handlers)).toEqual(["POST"]);
  });
});
