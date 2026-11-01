/**
 * Linked dev (docs/design/linked-dev.md), end to end and in process: the
 * real worker entry, the real @cloudflare/workers-oauth-provider on an
 * in-memory KV, every migration on SQLite. Only Better Auth's session
 * lookup is stubbed, as in native-sign-in.e2e.
 *
 * `everyapp dev --gateway` is an OAuth client whose `resource` is
 * `${issuer}/linked-dev/<app id>`. Pinned here: the resource exists only
 * where an organization opted in (`dev.off-by-default`), owners and admins
 * who can open the app may consent and nobody else
 * (`dev.owner-admin-only`), the token opens the Gateway's services for
 * that one app and nothing else: not `/mcp`, not the app's host, not
 * another app (`dev.audience-is-one-app`), a native token opens none of it,
 * the identity and organization headers the SDK sends are never read
 * (`dev.identity-never-forwarded`), every call re-reads the row, role,
 * switch and app access (`dev.per-request-recheck`, `dev.revocation-paths`),
 * spend is rate-limited and audited (`dev.rate-limited-and-audited`), and
 * nothing here serves a cookie or reads a secret.
 */
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

const hoisted = vi.hoisted(() => {
  (globalThis as { Cloudflare?: unknown }).Cloudflare = {
    compatibilityFlags: { global_fetch_strictly_public: true },
  };
  return {
    testDb: { current: null as TestDb | null },
    env: {} as Record<string, unknown>,
    background: [] as Promise<unknown>[],
    sessions: new Map<
      string,
      { email: string; activeOrganizationId: string | null }
    >(),
    controlPlane: vi.fn(async () => new Response("control plane")),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: (task: Promise<unknown>) => {
    hoisted.background.push(task);
  },
  WorkerEntrypoint: class {},
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => hoisted.testDb.current }));
vi.mock("@/auth", () => ({
  createAuth: vi.fn(),
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const userId = /every-app\.session_token=([^;]+)/.exec(
          headers.get("cookie") ?? "",
        )?.[1];
        const session = userId ? hoisted.sessions.get(userId) : undefined;
        return userId && session
          ? {
              user: { id: userId, email: session.email, banned: false },
              session: { activeOrganizationId: session.activeOrganizationId },
            }
          : null;
      },
    },
  },
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: hoisted.controlPlane },
}));

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { everyApp, getEveryAppUser } from "@every-app/sdk/server";
import { events, mcpConnections, members, usageDaily } from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { LINKED_DEV_LIMITS } from "@/server/linked-dev";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { resetAppHostMcpForTests } from "@/server/toolbus/app-host-mcp";
import { clearCatalogSyncClaimsForTests } from "@/server/toolbus/catalog-sync";
import { clearAppCallerCacheForTests } from "@/server/app-gateway-entrypoint";
import { createKvFake } from "@/test/kv-fake";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { getMcpAuth, resetMcpAuthForTests } from "./config";
import { buildConsentContext, type ConsentContext } from "./consent";
import { resetRegistrationLimitsForTests } from "./registration-limit";
import {
  appResourceOrigin,
  devResource,
  resetAppResourcesForTests,
} from "./resources";

const GATEWAY = "https://gateway.example.com";
const HOST = "gateway.example.com";
const REGISTERED_LOOPBACK = "http://127.0.0.1/callback";
const loopback = (port: number) => `http://127.0.0.1:${port}/callback`;

type Tokens = {
  access_token: string;
  refresh_token: string;
  scope: string;
  resource: string;
  expires_in: number;
};

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let kv: ReturnType<typeof createKvFake>;
let orgId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let todoRowId: string;
let todoOrigin: string;
let todoDev: string;
let notesDev: string;
const env = hoisted.env as unknown as Cloudflare.Env;

async function settle(): Promise<void> {
  while (hoisted.background.length) {
    await Promise.all(hoisted.background.splice(0));
  }
}

function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return server.fetch(new Request(`${GATEWAY}${path}`, { ...init, headers }));
}

class Browser {
  readonly cookies = new Map<string, string>();

  constructor(readonly userId?: string) {
    if (userId) this.cookies.set("every-app.session_token", userId);
  }

  cookieHeader(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private absorb(response: Response): Response {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      if (attributes.some((part) => /^\s*max-age=0\s*$/i.test(part))) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, pair.slice(separator + 1));
      }
    }
    return response;
  }

  async get(path: string): Promise<Response> {
    return this.absorb(
      await send(path, { headers: { cookie: this.cookieHeader() } }),
    );
  }

  async postForm(
    path: string,
    fields: Record<string, string | string[]>,
  ): Promise<Response> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        body.append(name, item);
      }
    }
    return this.absorb(
      await send(path, {
        method: "POST",
        headers: {
          cookie: this.cookieHeader(),
          "content-type": "application/x-www-form-urlencoded",
          origin: "null",
          "sec-fetch-site": "same-origin",
        },
        body,
      }),
    );
  }
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** The CLI as a client: dynamically registered, loopback, public. */
async function registerCli(): Promise<{ client_id: string }> {
  const response = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "everyapp dev on anas-laptop",
      redirect_uris: [REGISTERED_LOOPBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ client_id: string }>;
}

function tokenRequest(params: Record<string, string>): Promise<Response> {
  return send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

function authorizeQuery(
  clientId: string,
  redirectUri: string,
  challenge: string,
  resource: string,
): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  });
}

type Consent = Extract<ConsentContext, { ok: true }>;

async function openConsent(
  browser: Browser,
  clientId: string,
  redirectUri: string,
  resource: string,
) {
  const { verifier, challenge } = pkce();
  const authorize = await browser.get(
    `/oauth/authorize?${authorizeQuery(clientId, redirectUri, challenge, resource)}`,
  );
  if (authorize.status !== 302) {
    return { authorize, location: null, context: null, verifier };
  }
  const location = new URL(authorize.headers.get("location")!, GATEWAY);
  expect(location.pathname).toBe("/oauth/consent");
  const session = hoisted.sessions.get(browser.userId!)!;
  const context = await buildConsentContext(
    getMcpAuth(env)!,
    env,
    location.search,
    {
      id: browser.userId!,
      email: session.email,
      activeOrganizationId: session.activeOrganizationId,
    },
  );
  return { authorize, location, context, verifier };
}

/** The whole flow, from authorize to tokens, as `everyapp dev` does it. */
async function link(options: {
  clientId: string;
  resource?: string;
  userId?: string;
}): Promise<{ tokens: Tokens; context: Consent }> {
  const browser = new Browser(options.userId ?? ownerId);
  const resource = options.resource ?? todoDev;
  const redirectUri = loopback(49152);
  const { authorize, context, verifier } = await openConsent(
    browser,
    options.clientId,
    redirectUri,
    resource,
  );
  if (!context) {
    throw new Error(`authorize answered ${authorize.status}`);
  }
  if (!context.ok) throw new Error(context.message);
  const decision = await browser.postForm("/oauth/consent/decision", {
    handle: context.handle,
    decision: "approve",
    client_id: context.client.id,
    redirect_uri: context.client.redirectUri,
    resource: context.grant.resource,
    organization_id: orgId,
  });
  expect(decision.status, await decision.clone().text()).toBe(302);
  const callback = new URL(decision.headers.get("location")!);
  expect(callback.searchParams.get("iss")).toBe(GATEWAY);
  const exchange = await tokenRequest({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    redirect_uri: redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
    resource,
  });
  expect(exchange.status, await exchange.clone().text()).toBe(200);
  await settle();
  return { tokens: (await exchange.json()) as Tokens, context };
}

/** A call `everyapp dev`'s forwarder makes: the SDK's path under the app's linked dev prefix. */
function devCall(
  appSlug: string,
  path: string,
  token: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return send(`/linked-dev/${appSlug}${path}`, { ...init, headers });
}

function aiCall(
  appSlug: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return devCall(appSlug, "/api/ai/openai/v1/responses", token, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "gpt-5.2", input: "hello" }),
  });
}

function onHost(
  origin: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(origin).host);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return server.fetch(new Request(`${origin}${path}`, { ...init, headers }));
}

function mcp(token: string): Promise<Response> {
  return send("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
}

async function onlyConnection() {
  const rows = await db.select().from(mcpConnections);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function eventTypes(): Promise<string[]> {
  return (await db.select({ type: events.type }).from(events)).map(
    (row) => row.type,
  );
}

/** The upstream provider, never reached for real: what the proxy sent it. */
let upstream: ReturnType<typeof vi.fn>;

function app(id: string, publicKeyPem: string) {
  return everyApp(
    async (request, env) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/")) {
        return Response.json({
          app: id,
          user: await getEveryAppUser(request, env),
        });
      }
      return new Response(`${id} page`);
    },
    { id },
    { publicKeys: [publicKeyPem], issuer: GATEWAY },
  );
}

async function deployApp(appSlug: string) {
  const name = appSlug[0]!.toUpperCase() + appSlug.slice(1);
  const { app: row } = await deployLiveApp(db, {
    organizationId: orgId,
    deployerUserId: ownerId,
    appBaseDomain: HOST,
    isInstallOrganization: false,
    appSlug,
    name,
    description: name,
    manifest: { id: appSlug, name, providers: ["openai"] },
  });
  const worker = app(appSlug, keys.publicKeyPem);
  const appEnv = { EVERYAPP_AUDIENCE: row.workerName };
  hoisted.env[`APP__${row.workerName}`] = {
    fetch: (request: Request) =>
      worker.fetch(request, appEnv, {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext),
  };
  return {
    rowId: row.id,
    hostname: row.hostname!,
    origin: appResourceOrigin(row.hostname!),
  };
}

async function turnOn(on = true): Promise<void> {
  await OrgSettingsRepository.setLinkedDev({
    organizationId: orgId,
    on,
    updatedBy: ownerId,
  });
  // The resource list is a minute behind the registry; a fresh isolate
  // reads it on the next request that names one.
  resetAppResourcesForTests();
  resetMcpAuthForTests();
}

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keys = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
});

afterEach(async () => {
  await settle();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  kv = createKvFake();
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: keys.privateKeyPem,
    JWT_PUBLIC_KEY: keys.publicKeyPem,
    OPENAI_API_KEY: "gateway-provider-key",
    DB: { prepare: () => undefined },
    OAUTH_KV: kv.kv,
  });
  hoisted.sessions.clear();
  hoisted.background.length = 0;
  resetAppHostMcpForTests();
  resetRegistrationLimitsForTests();
  clearCatalogSyncClaimsForTests();
  clearHostnameCacheForTests();
  clearAppCallerCacheForTests();
  resetAppResourcesForTests();
  resetMcpAuthForTests();
  upstream = vi.fn(async () =>
    Response.json({
      id: "response-1",
      usage: { input_tokens: 3, output_tokens: 5 },
    }),
  );
  vi.stubGlobal("fetch", upstream);

  db = await createTestDb();
  hoisted.testDb.current = db;
  orgId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, {
    organizationId: orgId,
    role: "owner",
    email: "owner@example.com",
  });
  adminId = await seedMember(db, {
    organizationId: orgId,
    role: "admin",
    email: "admin@example.com",
  });
  memberId = await seedMember(db, {
    organizationId: orgId,
    role: "member",
    email: "member@example.com",
  });
  for (const [id, email] of [
    [ownerId, "owner@example.com"],
    [adminId, "admin@example.com"],
    [memberId, "member@example.com"],
  ] as const) {
    hoisted.sessions.set(id, { email, activeOrganizationId: orgId });
  }
  const todo = await deployApp("todo");
  await deployApp("notes");
  todoRowId = todo.rowId;
  todoOrigin = todo.origin;
  todoDev = devResource(GATEWAY, "todo");
  notesDev = devResource(GATEWAY, "notes");
  expect(todoDev).toBe("https://gateway.example.com/linked-dev/todo");
});

describe("opt-in", () => {
  it("lists no linked dev resource, and refuses an authorization naming one, until the organization turns it on (`dev.off-by-default`)", async () => {
    const client = await registerCli();
    const browser = new Browser(ownerId);
    const { authorize } = await openConsent(
      browser,
      client.client_id,
      loopback(49152),
      todoDev,
    );
    expect(authorize.status).toBe(400);
    expect(await authorize.text()).toContain(
      "must name exactly one configured protected resource",
    );
    expect(await db.select().from(mcpConnections)).toHaveLength(0);

    // And the endpoint is a 404 for anyone, bearer or not.
    const whoami = await devCall("todo", "/whoami", null);
    expect(whoami.status).toBe(401);

    await turnOn();
    const { tokens } = await link({ clientId: client.client_id });
    expect(tokens).toMatchObject({ scope: "*", resource: todoDev });
  });

  it("is 404 for every linked dev path while MCP_OAUTH_ENABLED is false, and a JSON 401 without a bearer (never the control plane, never a cookie)", async () => {
    await turnOn();
    hoisted.env["MCP_OAUTH_ENABLED"] = "false";
    const off = await devCall("todo", "/whoami", null);
    expect(off.status).toBe(404);
    delete hoisted.env["MCP_OAUTH_ENABLED"];

    const cookieOnly = await send("/linked-dev/todo/whoami", {
      headers: { cookie: `every-app.session_token=${ownerId}` },
    });
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get("www-authenticate")).toContain("Bearer");
    expect(hoisted.controlPlane).not.toHaveBeenCalled();
  });
});

describe("consent", () => {
  beforeEach(() => turnOn());

  it("issues a grant for an app's linked dev resource: scope *, one dev row, the audit event (`dev.audience-is-one-app`)", async () => {
    const client = await registerCli();
    const { tokens, context } = await link({ clientId: client.client_id });
    expect(context.grant).toEqual({
      kind: "dev",
      resource: todoDev,
      app: {
        rowId: todoRowId,
        slug: "todo",
        name: "Todo",
        hostname: "todo-acme.gateway.example.com",
      },
    });
    expect(context.organizations).toEqual([
      expect.objectContaining({
        id: orgId,
        role: "owner",
        apps: [expect.objectContaining({ rowId: todoRowId, slug: "todo" })],
      }),
    ]);
    expect(tokens).toMatchObject({
      scope: "*",
      resource: todoDev,
      expires_in: 3600,
    });
    const row = await onlyConnection();
    expect(row).toMatchObject({
      kind: "dev",
      resource: todoDev,
      userId: ownerId,
      organizationId: orgId,
      appScope: "selected",
      access: "write",
      clientName: "everyapp dev on anas-laptop",
    });
    expect(await eventTypes()).toEqual(["connection.created"]);
  });

  it("lets an admin link, and refuses a member even with app access (`dev.owner-admin-only`)", async () => {
    const client = await registerCli();
    await expect(
      link({ clientId: client.client_id, userId: adminId }),
    ).resolves.toMatchObject({ tokens: { scope: "*" } });

    // Give the member the app, as an owner would: still no.
    const { AppAccessRepository } = await import(
      "@/server/repositories/AppAccessRepository"
    );
    await AppAccessRepository.create({
      id: "access-member-todo",
      organizationId: orgId,
      userId: memberId,
      appRowId: todoRowId,
      grantedBy: ownerId,
    });
    const browser = new Browser(memberId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      loopback(49152),
      todoDev,
    );
    expect(context).toMatchObject({ ok: false });
    expect((context as { message: string }).message).toContain(
      "owners and admins",
    );
    // The decision form is refused too, before the handle is spent.
    const decision = await browser.postForm("/oauth/consent/decision", {
      handle: "h",
      decision: "approve",
      client_id: client.client_id,
      redirect_uri: loopback(49152),
      resource: todoDev,
      organization_id: orgId,
    });
    expect(decision.status).toBe(403);
    expect(await db.select().from(mcpConnections)).toHaveLength(1);
  });

  it("refuses an owner who can't open the app", async () => {
    const client = await registerCli();
    const { AppAccessRepository } = await import(
      "@/server/repositories/AppAccessRepository"
    );
    await AppAccessRepository.deleteByOrganizationAndUser(orgId, ownerId);
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      loopback(49152),
      todoDev,
    );
    expect(context).toMatchObject({ ok: false });
  });
});

describe("the endpoint", () => {
  let token: string;
  let refresh: string;
  let clientId: string;

  beforeEach(async () => {
    await turnOn();
    const client = await registerCli();
    clientId = client.client_id;
    const { tokens } = await link({ clientId });
    token = tokens.access_token;
    refresh = tokens.refresh_token;
  });

  it("answers whoami with the real member and app", async () => {
    const whoami = await devCall("todo", "/whoami", token);
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({
      user: { id: ownerId, email: "owner@example.com" },
      organization: { id: orgId, name: "acme" },
      role: "owner",
      app: {
        id: "todo",
        rowId: todoRowId,
        hostname: "todo-acme.gateway.example.com",
      },
      hasAccess: true,
      limits: LINKED_DEV_LIMITS,
    });
  });

  it("proxies a provider call as the app, attributed to the member by the token, never by the headers the SDK sent (`dev.identity-never-forwarded`)", async () => {
    const response = await aiCall("todo", token, {
      "x-everyapp-identity": "not.a.jwt",
      "x-everyapp-org": "another-org",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await settle();
    expect(upstream).toHaveBeenCalledOnce();
    const sent = upstream.mock.calls[0]![0] as Request;
    expect(new URL(sent.url).host).toContain("openai");
    expect(sent.headers.get("authorization")).toBe(
      "Bearer gateway-provider-key",
    );
    expect(sent.headers.get("x-everyapp-identity")).toBeNull();
    expect(sent.headers.get("x-everyapp-org")).toBeNull();
    // Counted against the organization, the app and the member.
    const usage = await db.select().from(usageDaily);
    expect(usage).toEqual([
      expect.objectContaining({
        organizationId: orgId,
        appRowId: todoRowId,
        userId: ownerId,
        kind: "ai",
        target: "openai",
        calls: 1,
      }),
    ]);
    // The first call of the day is in the audit log; the second is not.
    expect(await eventTypes()).toEqual([
      "connection.created",
      "connection.used",
    ]);
    await aiCall("todo", token);
    await settle();
    expect(await eventTypes()).toEqual([
      "connection.created",
      "connection.used",
    ]);
  });

  it("serves only the binding's routes: a provider the manifest doesn't list is refused, and an unknown path is 404", async () => {
    const other = await devCall(
      "todo",
      "/api/ai/openrouter/v1/chat/completions",
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(other.status).toBe(403);
    const unknown = await devCall("todo", "/api/apps", token);
    expect(unknown.status).toBe(404);
    const noSecrets = await devCall("todo", "/api/secrets", token);
    expect(noSecrets.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("opens that one app only: not another app's linked dev, not /mcp, not the app's own host (`dev.audience-is-one-app`)", async () => {
    const notes = await devCall("notes", "/whoami", token);
    expect(notes.status).toBe(401);
    expect(await notes.json()).toMatchObject({ error: "invalid_token" });

    const mcpResponse = await mcp(token);
    expect(mcpResponse.status).toBe(401);

    const host = await onHost(todoOrigin, "/api/me", { token });
    expect(host.status).toBe(401);
    expect(await host.text()).not.toContain("owner@example.com");
    expect(hoisted.controlPlane).not.toHaveBeenCalled();
  });

  it("refuses a native token (an app host's audience) and a personal-token shape at the endpoint", async () => {
    const browser = new Browser(ownerId);
    const { context, verifier } = await openConsent(
      browser,
      clientId,
      loopback(49153),
      todoOrigin,
    );
    expect(context?.ok).toBe(true);
    const decision = await browser.postForm("/oauth/consent/decision", {
      handle: (context as Consent).handle,
      decision: "approve",
      client_id: clientId,
      redirect_uri: loopback(49153),
      resource: todoOrigin,
      organization_id: orgId,
    });
    const callback = new URL(decision.headers.get("location")!);
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      redirect_uri: loopback(49153),
      client_id: clientId,
      code_verifier: verifier,
      resource: todoOrigin,
    });
    expect(exchange.status).toBe(200);
    const native = (await exchange.json()) as Tokens;
    expect((await devCall("todo", "/whoami", native.access_token)).status).toBe(
      401,
    );
    expect(
      (await devCall("todo", "/whoami", "epat_0123456789abcdef")).status,
    ).toBe(401);
    // And the dev token still opens nothing on the host, after a native consent too.
    expect((await onHost(todoOrigin, "/api/me", { token })).status).toBe(401);
  });

  it("stops on the next call when the person revokes it, and the refresh is invalid_grant (`dev.revocation-paths`)", async () => {
    const row = await onlyConnection();
    expect((await devCall("todo", "/whoami", token)).status).toBe(200);
    await McpConnectionService.revokeForUser(ownerId, row.id);
    await settle();
    expect((await devCall("todo", "/whoami", token)).status).toBe(401);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: todoDev,
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
    expect(await eventTypes()).toContain("connection.revoked");
  });

  it("stops when the member is demoted, when linked dev is turned off, and when their app access goes (`dev.per-request-recheck`)", async () => {
    await db
      .update(members)
      .set({ role: "member" })
      .where(eq(members.userId, ownerId));
    expect((await devCall("todo", "/whoami", token)).status).toBe(401);
    await db
      .update(members)
      .set({ role: "owner" })
      .where(eq(members.userId, ownerId));
    expect((await devCall("todo", "/whoami", token)).status).toBe(200);

    await OrgSettingsRepository.setLinkedDev({
      organizationId: orgId,
      on: false,
      updatedBy: ownerId,
    });
    expect((await devCall("todo", "/whoami", token)).status).toBe(401);
    await OrgSettingsRepository.setLinkedDev({
      organizationId: orgId,
      on: true,
      updatedBy: ownerId,
    });
    expect((await devCall("todo", "/whoami", token)).status).toBe(200);

    const { AppAccessRepository } = await import(
      "@/server/repositories/AppAccessRepository"
    );
    await AppAccessRepository.deleteByOrganizationAndUser(orgId, ownerId);
    const lost = await devCall("todo", "/whoami", token);
    expect(lost.status).toBe(403);
    expect(await lost.json()).toMatchObject({ error: "app_access_revoked" });

    // With linked dev off, a refresh fails too (and the library revokes the
    // grant with it), so the CLI signs in again rather than retrying.
    await OrgSettingsRepository.setLinkedDev({
      organizationId: orgId,
      on: false,
      updatedBy: ownerId,
    });
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: todoDev,
    });
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("rate-limits a connection per minute (`dev.rate-limited-and-audited`)", async () => {
    for (let i = 0; i < LINKED_DEV_LIMITS.perMinute; i += 1) {
      const ok = await aiCall("todo", token);
      expect(ok.status, `call ${i}`).toBe(200);
    }
    const over = await aiCall("todo", token);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    // whoami shares the minute's budget (a token lookup and reads), not the day's.
    expect((await devCall("todo", "/whoami", token)).status).toBe(429);
  });
});
