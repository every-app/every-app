/**
 * The `oauth_client` capability against a migrated SQLite database: apps
 * registered and deployed the way the CLI writes them, read back through the
 * registry the Worker uses, and their token calls through the AppGateway
 * entrypoint. The deployed manifest is the grant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const TOKEN =
  "http://every-app-gateway.internal/api/integrations/linkedin/www.linkedin.com/oauth/v2/accessToken";

describe("OAuth clients for deployed apps (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  const workers: Record<string, string> = {};
  const upstream = vi.fn(async (request: Request) => {
    sent.push({ url: request.url, body: await request.text() });
    return Response.json({ access_token: "user-token" });
  });
  let sent: { url: string; body: string }[];

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    sent = [];
    upstream.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
    const owner = await seedMember(db, { organizationId: acme, role: "owner" });
    for (const [appSlug, capabilities] of [
      [
        "postiz",
        { linkedin: { access: "write", why: "Connects LinkedIn channels." } },
      ],
      ["notes", { dataforseo: { access: "read" } }],
    ] as const) {
      const plan = await deployLiveApp(db, {
        organizationId: acme,
        appSlug,
        manifest: { id: appSlug, capabilities },
        deployerUserId: owner,
      });
      workers[appSlug] = plan.app.workerName!;
    }
  });

  function call(appSlug: string, init: RequestInit & { url?: string } = {}) {
    return handleAppGatewayRequest({
      request: new Request(init.url ?? TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=c&client_secret=app-secret",
        ...init,
      }),
      props: {
        organizationId: acme,
        appId: appSlug,
        workerName: workers[appSlug],
      },
      env: {
        GATEWAY_DEPLOYMENT_MODE: "self_hosted",
        LINKEDIN_CLIENT_ID: "gw-linkedin-id",
        LINKEDIN_CLIENT_SECRET: "gw-linkedin-secret",
      },
      registry: new DrizzleAppRegistry(db as never),
      organizations: OrganizationRepository,
      fetchUpstream: upstream,
    });
  }

  it("puts the gateway's client on the token call of an app whose manifest lists LinkedIn", async () => {
    const response = await call("postiz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      access_token: "user-token",
    });
    expect(sent).toEqual([
      {
        url: "https://www.linkedin.com/oauth/v2/accessToken",
        body: "grant_type=authorization_code&code=c&client_id=gw-linkedin-id&client_secret=gw-linkedin-secret",
      },
    ]);

    const status = await call("postiz", {
      url: "http://every-app-gateway.internal/api/integrations/linkedin",
      method: "GET",
      body: null,
    });
    await expect(status.json()).resolves.toMatchObject({
      ready: true,
      clientId: "gw-linkedin-id",
    });
  });

  it("refuses an app whose manifest doesn't, and tells it nothing", async () => {
    const response = await call("notes");
    expect(response.status).toBe(403);
    expect(response.headers.get("x-everyapp-error")).toBe(
      "capability_not_requested",
    );
    expect(upstream).not.toHaveBeenCalled();

    const status = await call("notes", {
      url: "http://every-app-gateway.internal/api/integrations/linkedin",
      method: "GET",
      body: null,
    });
    await expect(status.json()).resolves.toEqual({
      capability: "linkedin",
      requested: false,
      configured: false,
      ready: false,
    });
  });
});
