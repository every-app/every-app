/**
 * The real Better Auth configuration (createAuth) against a migrated SQLite
 * database: what an attacker can and cannot do over HTTP before and after
 * the gateway is claimed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const GATEWAY_URL = "https://gateway.example.com";

vi.mock("cloudflare:workers", () => ({
  env: {
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
// createAuth builds its adapter on D1; hand it the SQLite database instead.
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => testDb.current }));
// Outside a TanStack request there is no response to put cookies on.
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));

import { createHash } from "node:crypto";
import { count, eq } from "drizzle-orm";
import {
  apps,
  members,
  organizations,
  ownerSetupTokens,
  userAppAccess,
  users,
} from "@/db/schema";
import { SetupService } from "@/server/services/SetupService";
import { registerApp } from "@/test/registry";
import { createTestDb, seedOrganization } from "@/test/sqlite-db";
import { createAuth } from "./config";

const SETUP_TOKEN = "est_test-setup-link-secret";
const OWNER = { email: "owner@example.com", password: "owner-password-1" };

function post(path: string, body: unknown, cookie?: string): Request {
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

async function rowCount(db: TestDb, table: typeof users | typeof members) {
  const [row] = await db.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

async function mintLink(db: TestDb) {
  await db.insert(ownerSetupTokens).values({
    id: "link-1",
    kind: "claim",
    tokenHash: createHash("sha256").update(SETUP_TOKEN).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
}

async function claimAndSignIn(db: TestDb) {
  await mintLink(db);
  await SetupService.claimOwner({
    token: SETUP_TOKEN,
    name: "Owner",
    ...OWNER,
  });
  const response = await createAuth().handler(post("/sign-in/email", OWNER));
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describe("Better Auth lockdown (SQLite)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("refuses sign-up without an invitation, before and after the claim", async () => {
    const signUp = () =>
      createAuth().handler(
        post("/sign-up/email", {
          name: "Squatter",
          email: "squatter@example.com",
          password: "squatter-password",
        }),
      );

    const before = await signUp();
    expect(before.status).toBe(403);
    await expect(before.json()).resolves.toMatchObject({
      message: "Sign up is invite-only. Please use the invitation link.",
    });
    expect(await rowCount(db, users)).toBe(0);

    await claimAndSignIn(db);
    const after = await signUp();
    expect(after.status).toBe(403);
    await expect(after.json()).resolves.toMatchObject({
      message: "Sign up is invite-only. Please use the invitation link.",
    });
    expect(await rowCount(db, users)).toBe(1);
  });

  it("closes organization creation over HTTP, before and after the claim", async () => {
    const before = await createAuth().handler(
      post("/organization/create", { name: "Mine", slug: "mine" }),
    );
    expect(before.status).toBe(404);

    const cookie = await claimAndSignIn(db);
    const after = await createAuth().handler(
      post("/organization/create", { name: "Mine", slug: "mine" }, cookie),
    );
    expect(after.status).toBe(404);
    // Even the server-side API refuses a signed-in user.
    await expect(
      createAuth().api.createOrganization({
        headers: new Headers({ cookie }),
        body: { name: "Mine", slug: "mine-2" },
      }),
    ).rejects.toThrow();
    const slugs = (await db.select().from(organizations)).map((o) => o.slug);
    expect(slugs).not.toContain("mine");
    expect(slugs).not.toContain("mine-2");
  });

  it("claims the gateway with a link minted by the CLI's own SQL", async () => {
    // Loaded by path, not imported: the CLI is another package.
    const cliSetupLink = "../../../../packages/cli/src/lib/gateway/setup-link";
    const { mintSetupLink } = (await import(
      /* @vite-ignore */ cliSetupLink
    )) as {
      mintSetupLink(input: {
        db: { run(statements: Statement[]): Promise<unknown[][]> };
        gatewayUrl: string;
      }): Promise<{ url: string; expiresAt: Date }>;
    };
    type Statement = { sql: string; params?: (string | number | null)[] };
    // The CLI sends its statements to the gateway's D1 with `cf d1 query`;
    // run them against this SQLite database instead.
    const gatewayD1 = {
      run: async (statements: Statement[]) => {
        const results: unknown[][] = [];
        for (const { sql, params = [] } of statements) {
          results.push(
            (await testDb.current!.$client.execute({ sql, args: params })).rows,
          );
        }
        return results;
      },
    };

    const link = await mintSetupLink({
      db: gatewayD1,
      gatewayUrl: GATEWAY_URL,
    });
    const token = new URL(link.url).hash.replace(/^#token=/, "");
    expect(token).toMatch(/^est_/);

    await expect(
      SetupService.claimOwner({ token, name: "Owner", ...OWNER }),
    ).resolves.toMatchObject({ userId: expect.any(String) });
    const [membership] = await db.select().from(members);
    expect(membership?.role).toBe("owner");
    const [row] = await db.select().from(ownerSetupTokens);
    expect(row?.expiresAt.getTime()).toBe(link.expiresAt.getTime());
    expect(row?.consumedAt).toBeInstanceOf(Date);
  });

  it("gives the first owner the organization and apps deployed before anyone existed", async () => {
    // A CI-first install: the CLI deployed apps before the owner claimed.
    const ci = await seedOrganization(db, "apps-example-com");
    const todo = await registerApp(db, { organizationId: ci, appSlug: "todo" });
    const notes = await registerApp(db, {
      organizationId: ci,
      appSlug: "notes",
      manifest: { id: "notes", access: "everyone" },
    });
    const gone = await registerApp(db, { organizationId: ci, appSlug: "gone" });
    await db
      .update(apps)
      .set({ status: "deleted" })
      .where(eq(apps.id, gone.app.id));
    expect([todo, notes].map((plan) => plan.grants)).toEqual([[], []]);
    const organizationsBefore = await db.select().from(organizations);

    await claimAndSignIn(db);

    const [owner] = await db.select().from(users);
    expect(await db.select().from(organizations)).toHaveLength(
      organizationsBefore.length,
    );
    const [membership] = await db.select().from(members);
    expect(membership).toMatchObject({
      organizationId: ci,
      userId: owner!.id,
      role: "owner",
    });
    const [adopted] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, ci));
    expect(adopted?.name).toBe("Owner");
    const granted = await db
      .select({ appRowId: userAppAccess.appRowId })
      .from(userAppAccess)
      .where(eq(userAppAccess.userId, owner!.id));
    expect(granted.map((grant) => grant.appRowId).sort()).toEqual(
      [todo.app.id, notes.app.id].sort(),
    );
  });

  it("claims the gateway once with the setup link, then the link is spent", async () => {
    await claimAndSignIn(db);

    const [membership] = await db.select().from(members);
    expect(membership?.role).toBe("owner");
    const [link] = await db.select().from(ownerSetupTokens);
    expect(link?.consumedAt).toBeInstanceOf(Date);

    await expect(
      SetupService.claimOwner({
        token: SETUP_TOKEN,
        name: "Second",
        email: "second@example.com",
        password: "second-password",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await rowCount(db, users)).toBe(1);
  });

  it("closes membership endpoints the gateway handles itself", async () => {
    const cookie = await claimAndSignIn(db);
    for (const path of [
      "/organization/invite-member",
      "/organization/accept-invitation",
      "/organization/update-member-role",
      "/organization/remove-member",
      "/organization/leave",
      "/organization/delete",
    ]) {
      const response = await createAuth().handler(post(path, {}, cookie));
      expect(response.status).toBe(404);
    }
  });
});
