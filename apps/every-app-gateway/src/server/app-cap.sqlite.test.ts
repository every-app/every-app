/**
 * An organization's monthly cap on an app's provider calls, enforced at
 * the AppGateway entrypoint against a migrated SQLite database: at the cap
 * an AI or capability call is refused with 429 and the seconds left in the
 * UTC month, and not counted; under it the call goes through and counts;
 * with no cap the counter is never read; a cap just set binds at once; a
 * new month starts over; one organization's cap on a shared app never
 * binds another's use of it; the gateway's own services are not capped; a
 * default binds every app without a cap of its own; the owners and admins
 * hear of a cap reached, once, off the call's path. The dollar cap the
 * same way, on the cost a provider reports (DataForSEO here), never moved
 * by one that reports none.
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
const GOOGLE_TOKENS =
  "http://every-app-gateway.internal/api/integrations/google-workspace/oauth2.googleapis.com/token";
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";

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
        "google-workspace": {
          access: "write",
          scopes: ["gmail.read"],
          why: "Read your inbox",
        },
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
    effectiveMonthlyCaps: OrgAppSettingsRepository.getEffectiveMonthlyCaps,
    monthlyUsage: UsageRepository.monthlyUsage,
  };

  async function call(
    app: RegisteredApp,
    request: Request,
    options: {
      clearCaches?: boolean;
      counter?: typeof caps;
    } = {},
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
        GOOGLE_WORKSPACE_CLIENT_ID: "gw-google-id",
        GOOGLE_WORKSPACE_CLIENT_SECRET: "gw-google-secret",
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

  async function setCap(
    orgId: string,
    appRowId: string,
    cap: number | null,
    unlimited = false,
  ) {
    await AppCapService.setMonthlyCap(
      { orgId, userId: acmeAdmin, role: "admin" },
      { appRowId, cap, unlimited },
    );
  }

  async function setDefault(orgId: string, cap: number | null) {
    await AppCapService.setDefaultMonthlyCap(
      { orgId, userId: acmeAdmin, role: "admin" },
      { cap },
    );
  }

  async function countedCalls(orgId: string, appRowId: string) {
    const month = new Date().toISOString().slice(0, 7);
    return (await UsageRepository.monthlyUsage(orgId, appRowId, month)).calls;
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
        source: "app",
      }),
    );
  });

  it("answers the AI refusal in OpenAI's error shape, naming the cap and who raises it by role", async () => {
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
    const body = await refused.text();
    expect(JSON.parse(body)).toEqual({
      error: {
        message:
          "chef has reached its monthly cap of 1 provider calls for this organization. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
        code: "app_monthly_cap_exceeded",
        type: "gateway_refusal",
      },
      code: "app_monthly_cap_exceeded",
      message:
        "chef has reached its monthly cap of 1 provider calls for this organization. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    });
    // Never a name or an address: the body reaches the app's code.
    expect(body).not.toContain("@example.com");
    expect(body).not.toContain("User ");
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
    const monthlyUsage = vi.fn(UsageRepository.monthlyUsage);
    const counter = {
      effectiveMonthlyCaps: OrgAppSettingsRepository.getEffectiveMonthlyCaps,
      monthlyUsage,
    };
    expect((await call(app, aiRequest(), { counter })).status).toBe(200);
    expect((await call(app, serpRequest(), { counter })).status).toBe(200);
    expect(monthlyUsage).not.toHaveBeenCalled();
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(2);

    await setCap(acme, app.rowId!, 5);
    expect((await call(app, aiRequest(), { counter })).status).toBe(200);
    expect(monthlyUsage).toHaveBeenCalledTimes(1);
    expect(monthlyUsage).toHaveBeenCalledWith(
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
      UsageRepository.monthlyUsage(acme, app.rowId!, "2026-10"),
    ).resolves.toMatchObject({ calls: 1 });
    await expect(
      UsageRepository.monthlyUsage(acme, app.rowId!, "2026-11"),
    ).resolves.toMatchObject({ calls: 1 });
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
      Response.json({
        access_token: "user-token",
        expires_in: 3600,
        scope: GMAIL,
      }),
    );
    const tokenRequest = async () =>
      new Request(GOOGLE_TOKENS, {
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
        target: "google-workspace",
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
    const effectiveMonthlyCaps = vi.fn(async () => ({
      calls: { cap: 1, source: "app" as const },
      cost: { cap: null, source: null },
    }));
    const monthlyUsage = vi.fn(async () => ({ calls: 99, costMicros: 0 }));
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await call(app, aiRequest(), {
            counter: { effectiveMonthlyCaps, monthlyUsage },
          })
        ).status,
      ).toBe(200);
    }
    expect(effectiveMonthlyCaps).not.toHaveBeenCalled();
    expect(monthlyUsage).not.toHaveBeenCalled();
  });

  it("binds the workspace default to an app without a cap of its own, and says so", async () => {
    const app = chef();
    await setDefault(acme, 1);
    expect((await call(app, aiRequest())).status).toBe(200);
    const refused = await call(app, aiRequest());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      code: "app_monthly_cap_exceeded",
      message:
        "chef has reached its monthly cap of 1 provider calls for this organization (the workspace default). Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    });
    expect(warn).toHaveBeenCalledWith(
      "App gateway monthly cap reached",
      expect.objectContaining({ cap: 1, calls: 1, source: "default" }),
    );
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(1);

    // Its own cap wins over the default; no cap at all lets it through.
    await setCap(acme, app.rowId!, 3);
    expect((await call(app, aiRequest())).status).toBe(200);
    expect((await call(app, aiRequest())).status).toBe(200);
    expect((await call(app, aiRequest())).status).toBe(429);
    await setCap(acme, app.rowId!, null, true);
    expect((await call(app, aiRequest())).status).toBe(200);
    // Back under the default: refused again.
    await setCap(acme, app.rowId!, null);
    expect((await call(app, aiRequest())).status).toBe(429);
    await expect(countedCalls(acme, app.rowId!)).resolves.toBe(4);
  });

  describe("the dollar cap", () => {
    // DataForSEO reports $0.002 a call; a cap of a cent holds five.
    const pricedSerp = () =>
      upstream.mockImplementation(async () =>
        Response.json({ status_code: 20000, cost: 0.002, tasks: [] }),
      );

    it("refuses once the reported cost reaches it, saying dollars, and leaves the call cap alone", async () => {
      const app = chef();
      pricedSerp();
      await AppCapService.setMonthlyCap(
        { orgId: acme, userId: acmeAdmin, role: "admin" },
        { appRowId: app.rowId!, costUsd: 0.01 },
      );
      for (let i = 0; i < 5; i += 1) {
        expect((await call(app, serpRequest())).status).toBe(200);
      }
      const refused = await call(app, serpRequest());
      expect(refused.status).toBe(429);
      expect(refused.headers.get("x-everyapp-error")).toBe(
        "app_monthly_cap_exceeded",
      );
      expect(await refused.json()).toMatchObject({
        code: "app_monthly_cap_exceeded",
        message:
          "chef has reached its monthly cap of $0.01 of provider-reported cost for this organization. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
      });
      expect(warn).toHaveBeenCalledWith(
        "App gateway monthly cap reached",
        expect.objectContaining({
          kind: "cost",
          cap: 10_000,
          costMicros: 10_000,
          calls: 5,
          source: "app",
        }),
      );
      // Paused is paused: an AI call is refused too.
      expect((await call(app, aiRequest())).status).toBe(429);
      expect(upstream).toHaveBeenCalledTimes(5);
      await expect(
        UsageRepository.pausedApps(acme, [app.rowId!]),
      ).resolves.toEqual(new Set([app.rowId]));
    });

    it("is never moved by a provider that reports no cost", async () => {
      const app = chef();
      await setDefaultCost(acme, 0.01);
      // OpenAI's answers carry tokens, no price.
      for (let i = 0; i < 8; i += 1) {
        expect((await call(app, aiRequest())).status).toBe(200);
      }
      await expect(
        UsageRepository.monthlyUsage(
          acme,
          app.rowId!,
          new Date().toISOString().slice(0, 7),
        ),
      ).resolves.toEqual({ calls: 8, costMicros: 0 });
    });

    it("binds the workspace default dollar cap beside an app's own call cap, and says it is the default", async () => {
      const app = chef();
      pricedSerp();
      await setCap(acme, app.rowId!, 100);
      await setDefaultCost(acme, 0.01);
      for (let i = 0; i < 5; i += 1) {
        expect((await call(app, serpRequest())).status).toBe(200);
      }
      const refused = await call(app, serpRequest());
      expect(refused.status).toBe(429);
      expect(((await refused.json()) as { message: string }).message).toContain(
        "monthly cap of $0.01 of provider-reported cost for this organization (the workspace default)",
      );
      // Unlimited lifts both defaults.
      await setCap(acme, app.rowId!, null, true);
      expect((await call(app, serpRequest())).status).toBe(200);
    });
  });

  async function setDefaultCost(orgId: string, costUsd: number | null) {
    await AppCapService.setDefaultMonthlyCap(
      { orgId, userId: acmeAdmin, role: "admin" },
      { costUsd },
    );
  }
});
