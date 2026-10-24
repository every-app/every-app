/**
 * Counting at the AppGateway entrypoint, against a migrated SQLite
 * database: an answered AI call is counted under the person behind it the
 * moment the provider answers (its tokens added when the body is read to
 * the end), a shared app's background capability call under '' with the
 * provider's cost, an OAuth client's token call with none, a refused call
 * not at all, and an app with no registry row (an in-memory registry's)
 * never.
 *
 * In workerd a browser or app Worker that stops reading is not heard by
 * the gateway at all (response-tap.ts), so the abandoned cases here drop
 * the body unread rather than cancel it: cancelling would run hooks
 * production never runs.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { mintIdentityJwt } from "@every-app/sdk/internal";
import { InMemoryAppRegistry, type RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import { usageDaily, usageMonthly } from "@/db/schema";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const GATEWAY_URL = "https://home.example.com";
const RESPONSES =
  "http://every-app-gateway.internal/api/ai/openai/v1/responses";
const SERP =
  "http://every-app-gateway.internal/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/live/advanced";
const MONTH = new Date().toISOString().slice(0, 7);
const DAY = new Date().toISOString().slice(0, 10);

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

describe("usage counting at the AppGateway entrypoint (SQLite)", () => {
  let db: TestDb;
  let platform: string;
  let acme: string;
  let member: string;
  let background: Promise<unknown>[];

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    background = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    platform = await seedOrganization(db, "every-app");
    await seedMember(db, { organizationId: platform, role: "owner" });
    acme = await seedOrganization(db, "acme");
    member = await seedMember(db, { organizationId: acme, role: "member" });
  });

  const chef = (overrides: Partial<RegisteredApp> = {}): RegisteredApp => ({
    appId: "chef",
    rowId: "app-row-chef",
    hostname: "chef.example.com",
    workerName: "every-chef",
    tier: "service_binding",
    scope: "org",
    organizationId: acme,
    status: "active",
    manifest: validateManifest({
      id: "chef",
      providers: ["openai"],
      capabilities: { dataforseo: { access: "read", why: "Research" } },
    }),
    ...overrides,
  });

  const openseo = (): RegisteredApp => ({
    appId: "openseo",
    rowId: "app-row-openseo",
    hostname: "openseo.example.com",
    workerName: "every-openseo",
    tier: "service_binding",
    scope: "shared",
    organizationId: platform,
    status: "active",
    manifest: validateManifest({
      id: "openseo",
      providers: ["openai"],
      capabilities: { dataforseo: { access: "read", why: "Research" } },
    }),
  });

  function identity(
    app: RegisteredApp,
    orgId: string,
    sub: string,
    channel: "web" | "mcp" = "web",
  ) {
    return mintIdentityJwt(privateKeyPem, {
      subject: { sub, email: `${sub}@example.com`, orgId, orgRole: "member" },
      audience: app.workerName!,
      issuer: GATEWAY_URL,
      channel,
    });
  }

  async function call(
    app: RegisteredApp,
    request: Request,
    fetchUpstream: (request: Request) => Promise<Response>,
    // How the app reads the answer: to the end, unless a test says otherwise.
    read: (response: Response) => Promise<unknown> = (response) =>
      response.text(),
  ) {
    // Each call may describe the app differently.
    clearAppCallerCacheForTests();
    const response = await handleAppGatewayRequest({
      request,
      props: {
        organizationId: app.organizationId,
        appId: app.appId,
        workerName: app.workerName!,
      },
      env: {
        GATEWAY_DEPLOYMENT_MODE: "hosted",
        GATEWAY_URL,
        JWT_PUBLIC_KEY: publicKeyPem,
        OPENAI_API_KEY: "gateway-provider-key",
        DATAFORSEO_API_KEY: "login@example.com:secret",
        LINKEDIN_CLIENT_ID: "gw-linkedin-id",
        LINKEDIN_CLIENT_SECRET: "gw-linkedin-secret",
      },
      registry: new InMemoryAppRegistry([app]),
      organizations: OrganizationRepository,
      fetchUpstream,
      usage: UsageRepository,
      waitUntil: (task) => {
        background.push(task);
      },
    });
    // The count is taken off the response body: read it, then let the
    // background work finish as the Worker's waitUntil would.
    await read(response);
    await Promise.all(background);
    return response;
  }

  /** A streamed answer: `chunks` arrive and then the body stays open. */
  function openEnded(...chunks: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  /**
   * Never read the body: in workerd that is all the gateway sees of a
   * closed tab or an app that gave up (no cancel, no further pull).
   */
  async function dropBody(_response: Response) {}

  const aiRequest = (headers: Record<string, string> = {}) =>
    new Request(RESPONSES, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
    });

  it("counts a person's AI call with its tokens, under their organization and app", async () => {
    const app = chef();
    const response = await call(
      app,
      aiRequest({ "x-everyapp-identity": await identity(app, acme, member) }),
      async () =>
        Response.json({
          id: "resp_1",
          usage: { input_tokens: 12, output_tokens: 5 },
        }),
    );
    expect(response.status).toBe(200);
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: "app-row-chef",
        userId: member,
        kind: "ai",
        target: "openai",
        day: DAY,
        calls: 1,
        failures: 0,
        inputTokens: 12,
        outputTokens: 5,
        costMicros: 0,
      }),
    ]);
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: "app-row-chef",
        month: MONTH,
        calls: 1,
        inputTokens: 12,
        outputTokens: 5,
      }),
    ]);
  });

  it("counts a call the provider refused as a call and a failure, tokens or not", async () => {
    const app = chef();
    const response = await call(app, aiRequest(), async () =>
      Response.json({ error: "rate limited" }, { status: 429 }),
    );
    expect(response.status).toBe(429);
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        userId: "",
        calls: 1,
        failures: 1,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
  });

  it("counts a streamed AI call when the provider answers, before anyone reads the body", async () => {
    const app = chef();
    await call(
      app,
      aiRequest({ "x-everyapp-identity": await identity(app, acme, member) }),
      // Usage comes last in a stream; a closed tab never gets there.
      async () => openEnded('data: {"type":"response.created"}\n\n'),
      dropBody,
    );
    // The provider served and billed the call all the same: counted with
    // no tokens, since nobody read the tail that reports them.
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        userId: member,
        kind: "ai",
        target: "openai",
        calls: 1,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({ appRowId: "app-row-chef", calls: 1 }),
    ]);
  });

  it("counts a capability call the app never read, without the cost its body would have reported", async () => {
    const app = openseo();
    await call(
      app,
      new Request(SERP, {
        method: "POST",
        headers: { "x-everyapp-org": acme },
        body: "[]",
      }),
      async () => openEnded('{"status_code":20000,"cost":0.004,"tasks":['),
      dropBody,
    );
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        kind: "capability",
        target: "dataforseo",
        calls: 1,
        failures: 0,
        costMicros: 0,
      }),
    ]);
  });

  it("counts an OAuth client's token call with no cost, and not an agent's refused one", async () => {
    const app = chef({
      manifest: validateManifest({
        id: "chef",
        capabilities: { linkedin: { access: "write", why: "Connects" } },
      }),
    });
    const tokenRequest = (identityJwt: string) =>
      new Request(
        "http://every-app-gateway.internal/api/integrations/linkedin/www.linkedin.com/oauth/v2/accessToken",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-everyapp-identity": identityJwt,
          },
          body: "grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fchef.example.com%2Fcb",
        },
      );
    const upstream = vi.fn(async () =>
      Response.json({ access_token: "t", expires_in: 3600 }),
    );

    const answered = await call(
      app,
      tokenRequest(await identity(app, acme, member)),
      upstream,
    );
    expect(answered.status).toBe(200);
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: "app-row-chef",
        userId: member,
        kind: "capability",
        target: "linkedin",
        calls: 1,
        failures: 0,
        costMicros: 0,
      }),
    ]);

    // An agent can't mint tokens: refused before the provider, not counted.
    const refused = await call(
      app,
      tokenRequest(await identity(app, acme, member, "mcp")),
      upstream,
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "integration_agent_not_allowed",
    );
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({ appRowId: "app-row-chef", calls: 1 }),
    ]);
  });

  it("counts a shared app's background capability call under '' with the provider's cost", async () => {
    const app = openseo();
    const response = await call(
      app,
      new Request(SERP, {
        method: "POST",
        headers: { "x-everyapp-org": acme },
        body: "[]",
      }),
      async () =>
        Response.json({ status_code: 20000, cost: 0.0025, tasks: [] }),
    );
    expect(response.status).toBe(200);
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: "app-row-openseo",
        userId: "",
        kind: "capability",
        target: "dataforseo",
        calls: 1,
        failures: 0,
        costMicros: 2_500,
      }),
    ]);
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: "app-row-openseo",
        month: MONTH,
        calls: 1,
        costMicros: 2_500,
      }),
    ]);
  });

  it("counts a shared app's call for the person's organization, never the platform's", async () => {
    const app = openseo();
    await call(
      app,
      aiRequest({ "x-everyapp-identity": await identity(app, acme, member) }),
      async () => Response.json({ id: "resp_1" }),
    );
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({
        organizationId: acme,
        appRowId: "app-row-openseo",
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
  });

  it("counts nothing the gateway refused before the provider", async () => {
    const upstream = vi.fn(async () => Response.json({ id: "resp_1" }));
    // A provider the manifest doesn't allow.
    const noAi = chef({ manifest: validateManifest({ id: "chef" }) });
    expect((await call(noAi, aiRequest(), upstream)).status).toBe(403);
    // Background work for an organization that doesn't exist.
    const refusedOrg = await call(
      openseo(),
      new Request(SERP, {
        method: "POST",
        headers: { "x-everyapp-org": "org-unknown" },
        body: "[]",
      }),
      upstream,
    );
    expect(refusedOrg.status).toBe(403);
    // An invalid identity on a shared app.
    const badIdentity = await call(
      openseo(),
      aiRequest({ "x-everyapp-identity": "not-a-jwt" }),
      upstream,
    );
    expect(badIdentity.status).toBe(401);
    // A capability the app doesn't list.
    const noCapability = await call(
      chef({
        manifest: validateManifest({ id: "chef", providers: ["openai"] }),
      }),
      new Request(SERP, { method: "POST", body: "[]" }),
      upstream,
    );
    expect(noCapability.status).toBe(403);
    // A provider that can't be reached.
    const unreachable = await call(chef(), aiRequest(), async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(unreachable.status).toBe(502);

    expect(upstream).not.toHaveBeenCalled();
    expect(await db.select().from(usageDaily)).toEqual([]);
    expect(await db.select().from(usageMonthly)).toEqual([]);
  });

  it("counts nothing for an app without a registry row", async () => {
    const { rowId: _rowId, ...noRow } = chef();
    const response = await call(noRow, aiRequest(), async () =>
      Response.json({
        id: "resp_1",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    expect(response.status).toBe(200);
    expect(await db.select().from(usageDaily)).toEqual([]);
  });

  it("answers the app even when the count can't be written", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const app = chef();
    const response = await handleAppGatewayRequest({
      request: aiRequest(),
      props: {
        organizationId: app.organizationId,
        appId: app.appId,
        workerName: app.workerName!,
      },
      env: { OPENAI_API_KEY: "gateway-provider-key", GATEWAY_URL },
      registry: new InMemoryAppRegistry([app]),
      organizations: OrganizationRepository,
      fetchUpstream: async () => Response.json({ id: "resp_1" }),
      usage: {
        record: async () => {
          throw new Error("D1 is away");
        },
      },
      waitUntil: (task) => {
        background.push(task);
      },
    });
    expect(response.status).toBe(200);
    await response.text();
    await expect(Promise.all(background)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith(
      "App gateway usage count failed",
      expect.objectContaining({ event: "usage.record.failed" }),
    );
  });
});
