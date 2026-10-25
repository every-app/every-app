/**
 * The `oauth_client` capability against a migrated SQLite database: apps
 * registered and deployed the way the CLI writes them, read back through the
 * registry the Worker uses, and their token calls through the AppGateway
 * entrypoint. The deployed manifest is the grant, and for a client with
 * scope sets, the sets it lists.
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
const GOOGLE_TOKEN =
  "http://every-app-gateway.internal/api/integrations/google-workspace/oauth2.googleapis.com/token";
const GOOGLE_STATUS =
  "http://every-app-gateway.internal/api/integrations/google-workspace";
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";

describe("OAuth clients for deployed apps (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  const workers: Record<string, string> = {};
  /** What the provider answers next: LinkedIn's shape unless a test says. */
  let answer: Record<string, unknown>;
  const upstream = vi.fn(async (request: Request) => {
    sent.push({ url: request.url, body: await request.text() });
    return Response.json(answer);
  });
  let sent: { url: string; body: string }[];

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    sent = [];
    answer = { access_token: "user-token" };
    upstream.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
    const owner = await seedMember(db, { organizationId: acme, role: "owner" });
    for (const [appSlug, capabilities] of [
      [
        "postiz",
        { linkedin: { access: "write", why: "Connects LinkedIn channels." } },
      ],
      ["notes", { dataforseo: { access: "read" } }],
      [
        "crm",
        { "google-workspace": { access: "write", scopes: ["gmail.read"] } },
      ],
      [
        "seo",
        {
          "google-workspace": {
            access: "write",
            scopes: ["search-console.read"],
          },
        },
      ],
      // Deployed before scope sets existed: lists the client, names no sets.
      ["cal", { "google-workspace": { access: "write" } }],
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
        GOOGLE_WORKSPACE_CLIENT_ID: "gw-google-id",
        GOOGLE_WORKSPACE_CLIENT_SECRET: "gw-google-secret",
      },
      registry: new DrizzleAppRegistry(db as never),
      organizations: OrganizationRepository,
      fetchUpstream: upstream,
    });
  }

  function googleStatus(appSlug: string) {
    return call(appSlug, { url: GOOGLE_STATUS, method: "GET", body: null });
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
      flow: "app",
      requested: false,
      configured: false,
      ready: false,
    });
  });

  it("holds each deployed app to the scope sets its own manifest lists", async () => {
    const granted = { access_token: "google-user-token", token_type: "Bearer" };
    // Each app's own scopes pass, on its own Worker.
    for (const [appSlug, scope] of [
      ["crm", GMAIL],
      ["seo", WEBMASTERS],
    ] as const) {
      answer = { ...granted, scope };
      const response = await call(appSlug, { url: GOOGLE_TOKEN });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ...granted, scope });
    }
    expect(sent.map(({ url }) => url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com/token",
    ]);
    expect(sent[0]?.body).toBe(
      "grant_type=authorization_code&code=c&client_id=gw-google-id&client_secret=gw-google-secret",
    );
    // The other app's scopes are refused, and the token stays behind.
    for (const [appSlug, scope] of [
      ["crm", WEBMASTERS],
      ["seo", GMAIL],
    ] as const) {
      answer = { ...granted, scope };
      const response = await call(appSlug, { url: GOOGLE_TOKEN });
      expect(response.status).toBe(403);
      expect(response.headers.get("x-everyapp-error")).toBe(
        "integration_scope_exceeded",
      );
      expect(await response.text()).not.toContain("google-user-token");
    }

    await expect((await googleStatus("crm")).json()).resolves.toEqual({
      capability: "google-workspace",
      flow: "both",
      connectPath: "/connect/google-workspace",
      requested: true,
      configured: true,
      ready: true,
      clientId: "gw-google-id",
      scopeSets: ["gmail.read"],
      scopes: [GMAIL],
    });
    await expect((await googleStatus("seo")).json()).resolves.toMatchObject({
      ready: true,
      scopeSets: ["search-console.read"],
      scopes: [WEBMASTERS],
    });
  });

  it("refuses an app deployed without scope sets, and its status says it isn't ready", async () => {
    const response = await call("cal", { url: GOOGLE_TOKEN });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-everyapp-error")).toBe(
      "integration_scopes_undeclared",
    );
    expect(upstream).not.toHaveBeenCalled();
    await expect((await googleStatus("cal")).json()).resolves.toEqual({
      capability: "google-workspace",
      flow: "both",
      connectPath: "/connect/google-workspace",
      requested: true,
      configured: true,
      ready: false,
      scopeSets: [],
    });

    // Not listing the client at all is still the first refusal.
    const notes = await call("notes", { url: GOOGLE_TOKEN });
    expect(notes.headers.get("x-everyapp-error")).toBe(
      "capability_not_requested",
    );
  });
});
