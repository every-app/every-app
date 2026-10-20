/**
 * The `members` capability through the AppGateway entrypoint against a
 * migrated SQLite database: who an app's list holds, by the rule the
 * perimeter applies when people open the app, with the repository the
 * Worker uses.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import { mintIdentityJwt } from "@every-app/sdk/internal";
import { InMemoryAppRegistry } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import { apps, members, organizations, userAppAccess } from "@/db/schema";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const LIST = "http://every-app-gateway.internal/api/integrations/members/list";
const GATEWAY_URL = "https://home.example.com";

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = keys.privateKey;
  publicKeyPem = keys.publicKey;
});

describe("members capability (SQLite)", () => {
  let db: TestDb;
  let acme: string;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
  });

  /** The app's registry row, and grants to `userIds`. */
  async function installApp(
    organizationId: string,
    appSlug: string,
    userIds: string[],
  ) {
    const appRowId = `app-${organizationId}-${appSlug}`;
    await db.insert(apps).values({
      id: appRowId,
      organizationId,
      appSlug,
      name: appSlug,
      description: "",
    });
    for (const userId of userIds) {
      await db.insert(userAppAccess).values({
        id: `grant-${userId}-${appRowId}`,
        userId,
        appRowId,
        organizationId,
      });
    }
  }

  function list(
    options: {
      organizationId?: string;
      scope?: "org" | "shared";
      capabilities?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const organizationId = options.organizationId ?? acme;
    clearAppCallerCacheForTests();
    return handleAppGatewayRequest({
      request: new Request(LIST, { headers: options.headers }),
      props: { organizationId, appId: "crm", workerName: "every-acme-crm" },
      env: {
        // Shared apps run on a hosted gateway only.
        GATEWAY_DEPLOYMENT_MODE:
          options.scope === "shared" ? "hosted" : "self_hosted",
        GATEWAY_URL,
        JWT_PUBLIC_KEY: publicKeyPem,
      },
      registry: new InMemoryAppRegistry([
        {
          appId: "crm",
          hostname: "crm.example.com",
          workerName: "every-acme-crm",
          tier: "service_binding",
          scope: options.scope ?? "org",
          organizationId,
          status: "active",
          manifest: validateManifest({
            id: "crm",
            capabilities: options.capabilities ?? {
              members: { access: "read", why: "Whom reports go to" },
            },
          }),
        },
      ]),
      organizations: { isAttributable: async () => true },
    });
  }

  async function emails(response: Response): Promise<string[]> {
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      members: { email: string }[];
    };
    return body.members.map((member) => member.email).sort();
  }

  it("lists the organization's live members the app is granted to, with their roles", async () => {
    const owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
      email: "owner@acme.test",
    });
    const member = await seedMember(db, {
      organizationId: acme,
      email: "member@acme.test",
    });
    await seedMember(db, { organizationId: acme, email: "no-grant@acme.test" });
    const banned = await seedMember(db, {
      organizationId: acme,
      email: "banned@acme.test",
      banned: true,
    });
    await installApp(acme, "crm", [owner, member, banned]);

    const response = await list();
    const body = (await response.json()) as {
      members: { email: string; role: string; name: string }[];
    };
    expect(body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "owner@acme.test", role: "owner" }),
        expect.objectContaining({ email: "member@acme.test", role: "member" }),
      ]),
    );
    expect(body.members).toHaveLength(2);
  });

  it("drops a member once they are removed from the organization", async () => {
    const leaving = await seedMember(db, {
      organizationId: acme,
      email: "leaving@acme.test",
    });
    const staying = await seedMember(db, {
      organizationId: acme,
      email: "staying@acme.test",
    });
    await installApp(acme, "crm", [leaving, staying]);
    expect(await emails(await list())).toEqual([
      "leaving@acme.test",
      "staying@acme.test",
    ]);

    await db.delete(members).where(eq(members.userId, leaving));
    expect(await emails(await list())).toEqual(["staying@acme.test"]);
  });

  it("never lists another organization's members or grants", async () => {
    const mine = await seedMember(db, {
      organizationId: acme,
      email: "mine@acme.test",
    });
    await installApp(acme, "crm", [mine]);
    const other = await seedOrganization(db, "other");
    const theirs = await seedMember(db, {
      organizationId: other,
      email: "theirs@other.test",
    });
    await installApp(other, "crm", [theirs]);

    expect(await emails(await list())).toEqual(["mine@acme.test"]);
  });

  it("lists no one for a suspended organization", async () => {
    const owner = await seedMember(db, { organizationId: acme, role: "owner" });
    await installApp(acme, "crm", [owner]);
    await db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, acme));

    expect(await emails(await list())).toEqual([]);
  });

  it("lists every live member of the organization a shared app's work is for", async () => {
    await seedMember(db, { organizationId: acme, email: "a@acme.test" });
    await seedMember(db, { organizationId: acme, email: "b@acme.test" });

    const response = await list({
      scope: "shared",
      organizationId: "org-platform",
      headers: { "x-everyapp-org": acme },
    });
    expect(await emails(response)).toEqual(["a@acme.test", "b@acme.test"]);
  });

  it("reports whether the app may list, without listing", async () => {
    const status = await handleAppGatewayRequest({
      request: new Request(
        "http://every-app-gateway.internal/api/integrations/members",
      ),
      props: {
        organizationId: acme,
        appId: "crm",
        workerName: "every-acme-crm",
      },
      env: { GATEWAY_DEPLOYMENT_MODE: "self_hosted" },
      registry: new InMemoryAppRegistry([
        {
          appId: "crm",
          hostname: "crm.example.com",
          workerName: "every-acme-crm",
          tier: "service_binding",
          scope: "org",
          organizationId: acme,
          status: "active",
          manifest: validateManifest({
            id: "crm",
            capabilities: { members: { access: "read" } },
          }),
        },
      ]),
      organizations: { isAttributable: async () => true },
    });
    expect(await status.json()).toEqual({
      capability: "members",
      requested: true,
      configured: true,
      ready: true,
    });
  });

  it("refuses an app that doesn't list members, and an agent's tool call", async () => {
    const refused = await list({ capabilities: {} });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "capability_not_requested",
    );

    const agent = await mintIdentityJwt(privateKeyPem, {
      subject: {
        sub: "user-agent",
        email: "agent@acme.test",
        orgId: acme,
        orgRole: "owner",
      },
      audience: "every-acme-crm",
      issuer: GATEWAY_URL,
      channel: "mcp",
      actor: { sub: "mcp:client" },
      scopes: ["mcp:read"],
      toolCall: { id: "call-1", name: "list_contacts" },
    });
    const viaAgent = await list({
      headers: { "x-everyapp-identity": agent },
    });
    expect(viaAgent.status).toBe(403);
    expect(viaAgent.headers.get("x-everyapp-error")).toBe(
      "integration_agent_not_allowed",
    );
  });
});
