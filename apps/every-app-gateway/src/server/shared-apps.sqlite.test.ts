/**
 * Shared first-party apps across organizations, in process: the real
 * worker entry (server.ts) and Better Auth on SQLite, apps behind their
 * service bindings, on a hosted gateway with three organizations: the
 * platform organization (the setup claim's, "Every App") that owns the
 * shared app `openseo`, and two customer organizations, Acme and Beta,
 * each with an app of its own.
 *
 * A shared app opens for any live member of any active organization, with
 * that member's organization in the identity; an organization's own app
 * stays its own; a suspended organization opens nothing; a person acting
 * under one of their organizations still opens another's apps as their
 * membership there. The launcher, the AI-connection consent, the gateway's
 * /mcp catalog and Admin → Apps list shared apps the same way.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
// The worker entry's Better Auth instance lives for the whole file, so its
// database must follow each test's.
vi.mock("drizzle-orm/d1", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { drizzle: () => testDbProxy(hoisted.testDb) };
});
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: async () => new Response("control plane") },
}));

import { createHash, generateKeyPairSync } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createAuth } from "@/auth";
import {
  accounts,
  mcpConnectionApps,
  mcpConnections,
  members,
  organizations,
  ownerSetupTokens,
  sessions,
  userAppAccess,
  users,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { consentChoices } from "@/server/mcp-auth/consent";
import { resolvePatCaller } from "@/server/mcp-auth/validate";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppService } from "@/server/services/AppService";
import { SetupService } from "@/server/services/SetupService";
import { UserPatService } from "@/server/services/UserPatService";
import { deployLiveApp } from "@/test/registry";
import { createTestDb } from "@/test/sqlite-db";

const GATEWAY = "https://gateway.example.com";
const BASE = "gateway.example.com";
const PASSWORD = "a-password-for-tests";

let privateKeyPem: string;
let db: TestDb;
/** The identity each app received, request by request. */
const received: Array<{ app: string; identity: string | null }> = [];

type Person = { userId: string; email: string };
let platformOwner: Person & { organizationId: string };
let acme: string;
let beta: string;
/** Acme's owner, also a member of Beta. */
let alice: Person;
/** Beta's owner. */
let bob: Person;
const hosts: Record<"openseo" | "todo" | "notes", string> = {
  openseo: "",
  todo: "",
  notes: "",
};
const rows: Record<"openseo" | "todo" | "notes", string> = {
  openseo: "",
  todo: "",
  notes: "",
};

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
});

async function addOrganization(slug: string): Promise<string> {
  const id = `org-${slug}`;
  await db.insert(organizations).values({
    id,
    name: slug,
    slug,
    createdAt: new Date(),
  });
  return id;
}

/** A person who signs in with a password, verified. */
async function addPerson(name: string): Promise<Person> {
  const userId = `user-${name}`;
  const email = `${name}@example.com`;
  await db.insert(users).values({
    id: userId,
    name,
    email,
    emailVerified: true,
  });
  await db.insert(accounts).values({
    id: `account-${name}`,
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(PASSWORD),
  });
  return { userId, email };
}

async function join(organizationId: string, userId: string, role: string) {
  await db.insert(members).values({
    id: `member-${organizationId}-${userId}`,
    organizationId,
    userId,
    role,
    createdAt: new Date(),
  });
}

async function signIn(email: string): Promise<string> {
  const response = await createAuth().handler(
    new Request(`${GATEWAY}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: GATEWAY, "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** The person's session acts under `organizationId`, as switching to it does. */
async function actUnder(userId: string, organizationId: string) {
  await db
    .update(sessions)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessions.userId, userId));
}

function open(
  app: keyof typeof hosts,
  headers: Record<string, string>,
): Promise<Response> {
  return server.fetch(
    new Request(`https://${hosts[app]}/`, {
      headers: { host: hosts[app], ...headers },
    }),
  );
}

/** The org claims of the identity the app last received. */
function lastIdentity() {
  const token = received.at(-1)?.identity;
  if (!token) throw new Error("the app received no identity");
  const { org_id, org_role, sub } = decodeJwt(token);
  return { sub, org_id, org_role };
}

async function deployApp(
  slug: keyof typeof hosts,
  organizationId: string,
  deployerUserId: string,
  scope: "org" | "shared" = "org",
) {
  const { app } = await deployLiveApp(db, {
    organizationId,
    appSlug: slug,
    name: slug,
    manifest: { id: slug, name: slug },
    deployerUserId,
    appBaseDomain: BASE,
    // Organizations made in one millisecond tie on age; say which it is.
    isInstallOrganization: organizationId === platformOwner.organizationId,
    scope,
  });
  hosts[slug] = app.hostname!;
  rows[slug] = app.id;
  hoisted.env[`APP__${app.workerName}`] = {
    fetch: async (request: Request) => {
      received.push({
        app: slug,
        identity: request.headers.get("x-everyapp-identity"),
      });
      return new Response(`${slug} app`);
    },
  };
}

function setMode(mode: "hosted" | "self_hosted") {
  hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = mode;
}

function forgetCaches() {
  clearHostnameCacheForTests();
  clearOrgContextCacheForTests();
}

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: privateKeyPem,
    DB: { prepare: () => undefined },
  });
  received.length = 0;
  forgetCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  db = await createTestDb();
  hoisted.testDb.current = db;

  // The setup claim makes the platform organization and its owner.
  await db.insert(ownerSetupTokens).values({
    id: "link-1",
    kind: "claim",
    tokenHash: createHash("sha256").update("est_setup").digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const claimed = await SetupService.claimOwner({
    token: "est_setup",
    name: "Platform",
    email: "platform@example.com",
    password: PASSWORD,
  });
  platformOwner = { ...claimed, email: "platform@example.com" };

  acme = await addOrganization("acme");
  beta = await addOrganization("beta");
  alice = await addPerson("alice");
  bob = await addPerson("bob");
  await join(acme, alice.userId, "owner");
  await join(beta, bob.userId, "owner");
  await join(beta, alice.userId, "member");

  await deployApp(
    "openseo",
    platformOwner.organizationId,
    platformOwner.userId,
    "shared",
  );
  await deployApp("todo", acme, alice.userId);
  // Everyone in Beta, Alice included.
  await deployApp("notes", beta, bob.userId);
  await AppAccessService.updateAccessForApp(
    { orgId: beta, userId: bob.userId, role: "owner" },
    rows.notes,
    [bob.userId, alice.userId],
  );
});

describe("shared apps across organizations (SQLite)", () => {
  it("registers the shared app in the platform organization at <app>.<base>", async () => {
    const [platform] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, platformOwner.organizationId));
    expect(platform?.name).toBe("Every App");
    expect(hosts.openseo).toBe(`openseo.${BASE}`);
    expect(hosts.todo).toMatch(
      new RegExp(`^todo-[a-z0-9]+\\.${BASE.replaceAll(".", "\\.")}$`),
    );
  });

  it("opens a shared app for members of every organization, with their own organization in the identity", async () => {
    const aliceCookie = await signIn(alice.email);
    await actUnder(alice.userId, acme);
    expect((await open("openseo", { cookie: aliceCookie })).status).toBe(200);
    expect(lastIdentity()).toEqual({
      sub: alice.userId,
      org_id: acme,
      org_role: "owner",
    });

    const bobCookie = await signIn(bob.email);
    expect((await open("openseo", { cookie: bobCookie })).status).toBe(200);
    expect(lastIdentity()).toEqual({
      sub: bob.userId,
      org_id: beta,
      org_role: "owner",
    });

    const platformCookie = await signIn(platformOwner.email);
    expect((await open("openseo", { cookie: platformCookie })).status).toBe(
      200,
    );
    expect(lastIdentity()).toMatchObject({
      org_id: platformOwner.organizationId,
    });

    // The same person, now acting under Beta: Beta is in the identity.
    await actUnder(alice.userId, beta);
    forgetCaches();
    expect((await open("openseo", { cookie: aliceCookie })).status).toBe(200);
    expect(lastIdentity()).toEqual({
      sub: alice.userId,
      org_id: beta,
      org_role: "member",
    });
  });

  it("keeps an organization's own app from another organization's members", async () => {
    const bobCookie = await signIn(bob.email);
    const response = await open("todo", { cookie: bobCookie });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "no_app_access",
    });
    expect(received).toEqual([]);
  });

  it.each(["hosted", "self_hosted"] as const)(
    "opens another of the person's organizations' apps as their membership there (%s)",
    async (mode) => {
      setMode(mode);
      // Alice owns Acme and was invited to Beta, which her session acts
      // under now: Acme's app still opens, as Acme's owner.
      const aliceCookie = await signIn(alice.email);
      await actUnder(alice.userId, beta);
      expect((await open("todo", { cookie: aliceCookie })).status).toBe(200);
      expect(lastIdentity()).toEqual({
        sub: alice.userId,
        org_id: acme,
        org_role: "owner",
      });
      expect((await open("notes", { cookie: aliceCookie })).status).toBe(200);
      expect(lastIdentity()).toEqual({
        sub: alice.userId,
        org_id: beta,
        org_role: "member",
      });

      // Without the app installed for her there, it is still refused.
      await db
        .delete(userAppAccess)
        .where(
          and(
            eq(userAppAccess.userId, alice.userId),
            eq(userAppAccess.appRowId, rows.todo),
          ),
        );
      forgetCaches();
      expect((await open("todo", { cookie: aliceCookie })).status).toBe(403);
    },
  );

  it("keeps a personal access token to its own organization", async () => {
    const { plaintext } = await UserPatService.create({
      userId: alice.userId,
      organizationId: acme,
      name: "a script",
    });
    const bearer = { authorization: `Bearer ${plaintext}` };
    expect((await open("todo", bearer)).status).toBe(200);
    expect(lastIdentity()).toMatchObject({ org_id: acme });
    expect((await open("openseo", bearer)).status).toBe(200);
    expect(lastIdentity()).toMatchObject({ org_id: acme });
    // Beta's app, though she is a member there: the token is Acme's.
    expect((await open("notes", bearer)).status).toBe(403);
  });

  it("refuses everything to a suspended organization's members, cookies and tokens alike", async () => {
    const bobCookie = await signIn(bob.email);
    const { plaintext } = await UserPatService.create({
      userId: bob.userId,
      organizationId: beta,
      name: "a script",
    });
    expect((await open("notes", { cookie: bobCookie })).status).toBe(200);

    await db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, beta));
    forgetCaches();
    received.length = 0;
    for (const app of ["openseo", "notes"] as const) {
      for (const headers of [
        { cookie: bobCookie },
        { authorization: `Bearer ${plaintext}` },
      ] as Record<string, string>[]) {
        const response = await open(app, headers);
        expect(response.status).toBe(403);
      }
    }
    expect(received).toEqual([]);

    // The gateway's /mcp refuses the organization's tokens too.
    await expect(resolvePatCaller(plaintext)).resolves.toEqual({
      kind: "refused",
      reason: "organization_suspended",
    });

    // Alice acting under suspended Beta still opens Acme's app as Acme's.
    const aliceCookie = await signIn(alice.email);
    await actUnder(alice.userId, beta);
    expect((await open("todo", { cookie: aliceCookie })).status).toBe(200);
    expect((await open("notes", { cookie: aliceCookie })).status).toBe(403);
    expect((await open("openseo", { cookie: aliceCookie })).status).toBe(403);
  });

  it("opens a shared row for nobody on a self-hosted gateway", async () => {
    setMode("self_hosted");
    const aliceCookie = await signIn(alice.email);
    await actUnder(alice.userId, acme);
    expect((await open("openseo", { cookie: aliceCookie })).status).toBe(403);
    expect((await open("todo", { cookie: aliceCookie })).status).toBe(200);
  });
});

describe("listings of shared apps (SQLite)", () => {
  it("puts shared apps in every organization's launcher on the hosted gateway only", async () => {
    const slugs = async (orgId: string, userId: string) =>
      (
        await AppAccessService.getAppsForUser({ orgId, userId, role: "member" })
      ).apps
        .map((app) => app.appId)
        .sort();
    expect(await slugs(beta, bob.userId)).toEqual(["notes", "openseo"]);
    expect(await slugs(acme, alice.userId)).toEqual(["openseo", "todo"]);
    expect(
      await slugs(platformOwner.organizationId, platformOwner.userId),
    ).toEqual(["openseo"]);

    setMode("self_hosted");
    expect(await slugs(beta, bob.userId)).toEqual(["notes"]);
  });

  it("offers shared apps to AI connections in every active organization", async () => {
    const choices = async () =>
      Object.fromEntries(
        (await consentChoices(alice.userId)).map((org) => [
          org.id,
          org.apps.map((app) => app.slug).sort(),
        ]),
      );
    expect(await choices()).toEqual({
      [acme]: ["openseo", "todo"],
      [beta]: ["notes", "openseo"],
    });

    await db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, beta));
    expect(await choices()).toEqual({ [acme]: ["openseo", "todo"] });

    setMode("self_hosted");
    expect(await choices()).toEqual({ [acme]: ["todo"] });
  });

  it("serves a shared app's tools on the gateway /mcp to every organization", async () => {
    const tool = {
      name: "keyword_research",
      description: "Research keywords.",
      risk: "read" as const,
      inputSchema: { type: "object" },
    };
    await AppToolRepository.replace({
      appRowId: rows.openseo,
      organizationId: platformOwner.organizationId,
      versionId: "openseo-version",
      status: "ok",
      catalogHash: "hash-1",
      instructions: null,
      sdkVersion: "1",
      warnings: [],
      lastError: null,
      tools: [tool],
    });
    const visible = (scope: {
      organizationId: string;
      userId: string;
      sharedApps: boolean;
      connectionId?: string;
    }) => AppToolRepository.findVisibleCatalogs(scope);

    const catalogs = await visible({
      organizationId: beta,
      userId: bob.userId,
      sharedApps: true,
    });
    expect(catalogs.map((catalog) => catalog.appSlug)).toEqual(["openseo"]);
    expect(catalogs[0]).toMatchObject({
      // Kept in the platform organization, served to Beta's member.
      organizationId: platformOwner.organizationId,
      tools: [expect.objectContaining({ name: "keyword_research" })],
    });
    expect(
      await visible({
        organizationId: beta,
        userId: bob.userId,
        sharedApps: false,
      }),
    ).toEqual([]);

    // A connection that chose the shared app gets it; one that didn't, doesn't.
    for (const [id, chosen] of [
      ["conn-chose", true],
      ["conn-other", false],
    ] as const) {
      await db.insert(mcpConnections).values({
        id,
        userId: bob.userId,
        organizationId: beta,
        clientId: "client",
        clientName: "Client",
        redirectUri: "https://client.example/cb",
        redirectHost: "client.example",
        appScope: "selected",
        access: "read",
        createdAt: new Date(),
      });
      await db.insert(mcpConnectionApps).values({
        connectionId: id,
        appRowId: chosen ? rows.openseo : rows.notes,
      });
    }
    expect(
      (
        await visible({
          organizationId: beta,
          userId: bob.userId,
          sharedApps: true,
          connectionId: "conn-chose",
        })
      ).map((catalog) => catalog.appSlug),
    ).toEqual(["openseo"]);
    expect(
      await visible({
        organizationId: beta,
        userId: bob.userId,
        sharedApps: true,
        connectionId: "conn-other",
      }),
    ).toEqual([]);
  });

  it("shows shared apps read-only in other organizations' Admin → Apps", async () => {
    const betaAdmin = {
      orgId: beta,
      userId: bob.userId,
      role: "owner" as const,
    };
    const { apps } = await AppService.getAllWithAccessCounts(betaAdmin);
    expect(
      apps.map((app) => [app.appId, app.scope, app.readOnly]).sort(),
    ).toEqual([
      ["notes", "org", false],
      ["openseo", "shared", true],
    ]);
    await expect(
      AppService.update(betaAdmin, { id: rows.openseo, name: "Mine now" }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(
      AppService.delete(betaAdmin, rows.openseo),
    ).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
    });

    // The platform organization's own: editable, its access is no one's to manage.
    const platformAdmin = {
      orgId: platformOwner.organizationId,
      userId: platformOwner.userId,
      role: "owner" as const,
    };
    const platformApps = (
      await AppService.getAllWithAccessCounts(platformAdmin)
    ).apps;
    expect(platformApps.map((app) => [app.appId, app.readOnly])).toEqual([
      ["openseo", false],
    ]);
    await AppService.update(platformAdmin, {
      id: rows.openseo,
      name: "OpenSEO",
      isDefault: false,
    });
    await expect(
      AppService.update(platformAdmin, { id: rows.openseo, isDefault: true }),
    ).rejects.toMatchObject({ code: "SHARED_APP_ACCESS" });
    await expect(
      AppAccessService.updateAccessForApp(platformAdmin, rows.openseo, [
        platformOwner.userId,
      ]),
    ).rejects.toMatchObject({ code: "SHARED_APP_ACCESS" });

    setMode("self_hosted");
    expect(
      (await AppService.getAllWithAccessCounts(betaAdmin)).apps.map(
        (app) => app.appId,
      ),
    ).toEqual(["notes"]);
  });
});
