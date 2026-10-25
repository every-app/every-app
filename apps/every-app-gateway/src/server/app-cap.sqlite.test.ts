/**
 * An organization's monthly cap on an app's provider calls, enforced at
 * the AppGateway entrypoint against a migrated SQLite database: at the cap
 * an AI or capability call is refused with 429 and the seconds left in the
 * UTC month, and not counted; under it the call goes through and counts;
 * with no cap the counter is never read; a cap just set binds at once; a
 * new month starts over; one organization's cap on a shared app never
 * binds another's use of it; the gateway's own services are not capped.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: "https://gateway.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  },
  waitUntil: () => undefined,
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { mintIdentityJwt } from "@every-app/sdk/internal";
import { InMemoryAppRegistry, type RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import { usageDaily, usageMonthly } from "@/db/schema";
import { secondsUntilUtcMonthEnd } from "@/server/app-cap";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { OrgAppSettingsRepository } from "@/server/repositories/OrgAppSettingsRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import { AppCapService } from "@/server/services/AppCapService";
import { registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const GATEWAY_URL = "https://home.example.com";
const RESPONSES =
  "http://every-app-gateway.internal/api/ai/openai/v1/responses";
const SERP =
  "http://every-app-gateway.internal/api/integrations/dataforseo/api.dataforseo.com/v3/serp/google/organic/live/advanced";
const MEMBERS =
  "http://every-app-gateway.internal/api/integrations/members/list";
const LINKEDIN_TOKENS =
  "http://every-app-gateway.internal/api/integrations/linkedin/www.linkedin.com/oauth/v2/accessToken";

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

describe("monthly caps at the AppGateway entrypoint (SQLite)", () => {
  let db: TestDb;
  let platform: string;
  let acme: string;
  let acmeAdmin: string;
  let globex: string;
  let chefRowId: string;
  let openseoRowId: string;
  let background: Promise<unknown>[];
  let warn: ReturnType<typeof vi.spyOn>;
  let upstream: ReturnType<
    typeof vi.fn<(request: Request) => Promise<Response>>
  >;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    background = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    upstream = vi.fn(async () =>
      Response.json({
        id: "resp",
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
    platform = await seedOrganization(db, "every-app");
    await seedMember(db, { organizationId: platform, role: "owner" });
    acme = await seedOrganization(db, "acme");
    acmeAdmin = await seedMember(db, { organizationId: acme, role: "admin" });
    globex = await seedOrganization(db, "globex");
    await seedMember(db, { organizationId: globex, role: "owner" });
    // The apps' registry rows: a cap names one (and the FK holds it).
    chefRowId = (
      await registerApp(db, { organizationId: acme, appSlug: "chef" })
    ).app.id;
    openseoRowId = (
      await registerApp(db, {
        organizationId: platform,
        appSlug: "openseo",
        scope: "shared",
      })
    ).app.id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const chef = (): RegisteredApp => ({
    appId: "chef",
    rowId: chefRowId,
    hostname: "chef.example.com",
    workerName: "every-chef",
    tier: "service_binding",
    scope: "org",
    organizationId: acme,
    status: "active",
    manifest: validateManifest({
      id: "chef",
      providers: ["openai"],
      capabilities: {
        dataforseo: { access: "read", why: "Research" },
        members: { access: "read", why: "Assign" },
        linkedin: { access: "write", why: "Connect a channel" },
      },
    }),
  });

  const openseo = (): RegisteredApp => ({
    appId: "openseo",
    rowId: openseoRowId,
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

  function identity(app: RegisteredApp, orgId: string, sub: string) {
    return mintIdentityJwt(privateKeyPem, {
      subject: { sub, email: `${sub}@example.com`, orgId, orgRole: "member" },
      audience: app.workerName!,
      issuer: GATEWAY_URL,
      channel: "web",
    });
  }

  const caps = {
    monthlyCallCap: OrgAppSettingsRepository.getMonthlyCap,
    monthlyCalls: UsageRepository.monthlyCalls,
  };

  async function call(
    app: RegisteredApp,
    request: Request,
    options: { clearCaches?: boolean; counter?: typeof caps } = {},
  ) {
    if (options.clearCaches ?? true) clearAppCallerCacheForTests();
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
      fetchUpstream: upstream,
      usage: UsageRepository,
      waitUntil: (task) => {
        background.push(task);
      },
      caps: options.counter ?? caps,
    });
    // Read a copy to the end, so the tokens tap reports as an app's read
    // would; the test keeps the original body to inspect.
    await response
      .clone()
      .text()
      .catch(() => undefined);
    await Promise.all(background);
    return response;
  }

  const aiRequest = (headers: Record<string, string> = {}) =>
    new Request(RESPONSES, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
    });

  const serpRequest = (headers: Record<string, string> = {}) =>
    new Request(SERP, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "[]",
    });

  async function setCap(orgId: string, appRowId: string, cap: number | null) {
    await AppCapService.setMonthlyCap(
      { orgId, userId: acmeAdmin, role: "admin" },
      { appRowId, cap },
    );
  }

  async function countedCalls(orgId: string, appRowId: string) {
    const month = new Date().toISOString().slice(0, 7);
    return UsageRepository.monthlyCalls(orgId, appRowId, month);
  }

  it("refuses an AI call at the cap with 429, the seconds left in the month, and no count", async () => {
    const app = chef();
    await setCap(acme, app.rowId!, 2);
    expect((await call(app, aiRequest())).status).toBe(200);
    expect((await call(app, aiRequest())).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);

    const before = new Date();
    const refused = await call(
      app,
      aiRequest({
        "x-everyapp-identity": await identity(app, acme, acmeAdmin),
      }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "app_monthly_cap_exceeded",
    );
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeLessThanOrEqual(secondsUntilUtcMonthEnd(before));
    expect(retryAfter).toBeGreaterThanOrEqual(
      secondsUntilUtcMonthEnd(new Date()) - 1,
    );
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "App gateway monthly cap reached",
      expect.objectContaining({
        event: "usage.cap_exceeded",
        organizationId: acme,
        appId: "chef",
        appRowId: chefRowId,
        cap: 2,
        calls: 2,
      }),
    );
  });

  it("answers the AI refusal in OpenAI's error shape, naming the cap and who raises it", async () => {
    const app = chef();
    await setCap(acme, app.rowId!, 1);
    await call(app, aiRequest());
    clearAppCallerCacheForTests();
    const refused = await handleAppGatewayRequest({
      request: aiRequest(),
      props: { organizationId: acme, appId: "chef", workerName: "every-chef" },
      env: { GATEWAY_DEPLOYMENT_MODE: "hosted", OPENAI_API_KEY: "k" },
      registry: new InMemoryAppRegistry([app]),
      organizations: OrganizationRepository,
      fetchUpstream: upstream,
      usage: UsageRepository,
      caps,
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: {
        message:
          "chef has reached its monthly cap of 1 provider calls for this organization; an owner or admin raises it in Admin → Usage.",
        code: "app_monthly_cap_exceeded",
        type: "gateway_refusal",
      },
      code: "app_monthly_cap_exceeded",
      message:
        "chef has reached its monthly cap of 1 provider calls for this organization; an owner or admin raises it in Admin → Usage.",
    });
  });

  it("refuses a capability call at the cap the same way, and the cap counts both kinds together", async () => {
    const app = chef();
    await setCap(acme, app.rowId!, 2);
    upstream.mockImplementation(async () =>
      Response.json({ status_code: 20000, cost: 0.002, tasks: [] }),
    );
    expect((await call(app, serpRequest())).status).toBe(200);
    expect((await call(app, aiRequest())).status).toBe(200);

    const refused = await call(app, serpRequest());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "app_monthly_cap_exceeded",
    );
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({
      error: "Too Many Requests",
      code: "app_monthly_cap_exceeded",
      message: expect.stringContaining("monthly cap of 2 provider calls"),
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(2);
    expect(await db.select().from(usageDaily)).toHaveLength(2);
  });

  it("passes under the cap and counts the call, up to the cap", async () => {
    const app = chef();
    await setCap(acme, app.rowId!, 3);
    for (const expected of [1, 2, 3]) {
      const response = await call(app, aiRequest());
      expect(response.status).toBe(200);
      await expect(countedCalls(acme, app.rowId!)).resolves.toBe(expected);
    }
    expect((await call(app, aiRequest())).status).toBe(429);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(3);
    expect(await db.select().from(usageMonthly)).toEqual([
      expect.objectContaining({ appRowId: chefRowId, calls: 3 }),
    ]);
  });

  it("never reads the counter when no cap is set", async () => {
    const app = chef();
    const monthlyCalls = vi.fn(UsageRepository.monthlyCalls);
    const counter = {
      monthlyCallCap: OrgAppSettingsRepository.getMonthlyCap,
      monthlyCalls,
    };
    expect((await call(app, aiRequest(), { counter })).status).toBe(200);
    expect((await call(app, serpRequest(), { counter })).status).toBe(200);
    expect(monthlyCalls).not.toHaveBeenCalled();
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(2);

    await setCap(acme, app.rowId!, 5);
    expect((await call(app, aiRequest(), { counter })).status).toBe(200);
    expect(monthlyCalls).toHaveBeenCalledTimes(1);
    expect(monthlyCalls).toHaveBeenCalledWith(
      acme,
      app.rowId,
      new Date().toISOString().slice(0, 7),
    );
  });

  it("binds a cap the moment an admin sets it, without waiting for the cache", async () => {
    const app = chef();
    // Two calls with no cap: the "no cap" answer is cached for the next seconds.
    expect((await call(app, aiRequest())).status).toBe(200);
    expect((await call(app, aiRequest(), { clearCaches: false })).status).toBe(
      200,
    );
    await setCap(acme, app.rowId!, 2);
    const refused = await call(app, aiRequest(), { clearCaches: false });
    expect(refused.status).toBe(429);
    // Clearing it binds at once too.
    await setCap(acme, app.rowId!, null);
    expect((await call(app, aiRequest(), { clearCaches: false })).status).toBe(
      200,
    );
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(3);
  });

  it("starts over with the UTC month", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T23:59:30.000Z"));
    const app = chef();
    await setCap(acme, app.rowId!, 1);
    expect((await call(app, aiRequest())).status).toBe(200);
    const refused = await call(app, aiRequest());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("30");

    vi.setSystemTime(new Date("2026-11-01T00:00:01.000Z"));
    expect((await call(app, aiRequest())).status).toBe(200);
    await expect(
      UsageRepository.monthlyCalls(acme, app.rowId!, "2026-10"),
    ).resolves.toBe(1);
    await expect(
      UsageRepository.monthlyCalls(acme, app.rowId!, "2026-11"),
    ).resolves.toBe(1);
    expect((await call(app, aiRequest())).status).toBe(429);
  });

  it("binds one organization's cap on a shared app to that organization only", async () => {
    const app = openseo();
    await setCap(acme, app.rowId!, 1);
    const acmeUser = await seedMember(db, { organizationId: acme });
    const globexUser = await seedMember(db, { organizationId: globex });

    // Acme uses its one call, through a person and then background work.
    expect(
      (
        await call(
          app,
          aiRequest({
            "x-everyapp-identity": await identity(app, acme, acmeUser),
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(app, serpRequest({ "x-everyapp-org": acme }))).status,
    ).toBe(429);

    // Globex, uncapped, is not bound by acme's cap on the same app row.
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await call(
            app,
            aiRequest({
              "x-everyapp-identity": await identity(app, globex, globexUser),
            }),
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (await call(app, serpRequest({ "x-everyapp-org": globex }))).status,
    ).toBe(200);
    await expect(countedCalls(globex, app.rowId!)).resolves.toBe(4);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(1);
    // Nor does globex's use fill acme's cap: still refused, still 1.
    expect(
      (
        await call(
          app,
          aiRequest({
            "x-everyapp-identity": await identity(app, acme, acmeUser),
          }),
        )
      ).status,
    ).toBe(429);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(1);
  });

  it("refuses an OAuth client's token call at the cap, the one provider path outside integration-proxy.ts", async () => {
    const app = chef();
    await setCap(acme, app.rowId!, 1);
    upstream.mockImplementation(async () =>
      Response.json({ access_token: "user-token", expires_in: 3600 }),
    );
    const tokenRequest = async () =>
      new Request(LINKEDIN_TOKENS, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-everyapp-identity": await identity(app, acme, acmeAdmin),
        },
        body: "grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fchef.example.com%2Fcb",
      });
    const first = await call(app, await tokenRequest());
    expect(first.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(1);

    const refused = await call(app, await tokenRequest());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "app_monthly_cap_exceeded",
    );
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(1);
    expect(await db.select().from(usageDaily)).toEqual([
      expect.objectContaining({
        kind: "capability",
        target: "linkedin",
        calls: 1,
      }),
    ]);
  });

  it("leaves the gateway's own services alone: the members list answers at the cap", async () => {
    const app = chef();
    await setCap(acme, app.rowId!, 1);
    expect((await call(app, aiRequest())).status).toBe(200);
    expect((await call(app, aiRequest())).status).toBe(429);
    const members = await call(
      app,
      new Request(MEMBERS, {
        headers: {
          "x-everyapp-identity": await identity(app, acme, acmeAdmin),
        },
      }),
    );
    expect(members.status).toBe(200);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(1);
  });

  it("skips the cap for an app with no registry row, which is never counted", async () => {
    const app = { ...chef(), rowId: undefined } as RegisteredApp;
    const monthlyCallCap = vi.fn(async () => 1);
    const monthlyCalls = vi.fn(async () => 99);
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await call(app, aiRequest(), {
            counter: { monthlyCallCap, monthlyCalls },
          })
        ).status,
      ).toBe(200);
    }
    expect(monthlyCallCap).not.toHaveBeenCalled();
    expect(monthlyCalls).not.toHaveBeenCalled();
  });
});
