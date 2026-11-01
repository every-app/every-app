/**
 * "Sign in with Every App" for native apps (docs/design/native-sign-in.md),
 * the authorization server's half, end to end and in process: the real
 * worker entry, the real @cloudflare/workers-oauth-provider on an in-memory
 * KV, every migration on SQLite. Only Better Auth's session lookup (a
 * cookie naming the user) is stubbed, as in gateway-mcp.e2e.
 *
 * A native app is an OAuth client whose `resource` is an app host's origin
 * instead of `/mcp`. Pinned here: the grant is bound to that one origin
 * (`native.audience-is-one-app-host`), scope `*` whatever was asked
 * (`native.full-scope-only`), PKCE S256 and loopback-or-https redirects
 * (`native.loopback-or-https-redirect`), the consent names the app and
 * needs app access (`native.consent-names-app-and-org`), the per-request
 * re-read (`native.per-request-recheck`) and every revocation path
 * (`native.revocation-paths`), and, through the real worker entry on the
 * app hosts, the perimeter's side: the token acts as the member on its own
 * host and nowhere else, bearer routes take no cookie, and the metadata
 * document is the gateway's (`mcp.app-host-refuses-oauth-tokens`,
 * `native.bearer-routes-no-cookie`, `native.metadata-gateway-authored`).
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
import {
  apps,
  events,
  mcpConnectionApps,
  mcpConnections,
  members,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppService } from "@/server/services/AppService";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { MembershipService } from "@/server/services/MembershipService";
import { resetAppHostMcpForTests } from "@/server/toolbus/app-host-mcp";
import { clearCatalogSyncClaimsForTests } from "@/server/toolbus/catalog-sync";
import { createKvFake } from "@/test/kv-fake";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import {
  getMcpAuth,
  mcpAuthForResource,
  resetMcpAuthForTests,
  validateAppHostToken,
} from "./config";
import { buildConsentContext, type ConsentContext } from "./consent";
import { runMcpMaintenance } from "./maintenance";
import { resetRegistrationLimitsForTests } from "./registration-limit";
import { appResourceOrigin, resetAppResourcesForTests } from "./resources";
import { resolveNativeCaller, resolveOauthCaller } from "./validate";

const GATEWAY = "https://gateway.example.com";
const HOST = "gateway.example.com";
const MCP_RESOURCE = `${GATEWAY}/mcp`;
/** Registered once per install, RFC 8252 §7.3: the port is the request's. */
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
let memberId: string;
let todoRowId: string;
let notesRowId: string;
let todoOrigin: string;
let notesOrigin: string;
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

/** A native client as the design's contract registers one (§12.3). */
async function registerNativeClient(
  metadata: Record<string, unknown> = {},
): Promise<{ client_id: string }> {
  const response = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "OpenZen for Mac",
      redirect_uris: [REGISTERED_LOOPBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...metadata,
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

/** The contract's authorization request (§12.5): no scope, a resource. */
function authorizeQuery(
  clientId: string,
  redirectUri: string,
  challenge: string,
  resource: string,
  extra: Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    ...extra,
  });
}

type Consent = Extract<ConsentContext, { ok: true }>;

async function consentContext(browser: Browser, location: URL) {
  const session = hoisted.sessions.get(browser.userId!)!;
  return buildConsentContext(getMcpAuth(env)!, env, location.search, {
    id: browser.userId!,
    email: session.email,
    activeOrganizationId: session.activeOrganizationId,
  });
}

async function openConsent(
  browser: Browser,
  clientId: string,
  redirectUri: string,
  resource: string,
  extra: Record<string, string> = {},
) {
  const { verifier, challenge } = pkce();
  const authorize = await browser.get(
    `/oauth/authorize?${authorizeQuery(clientId, redirectUri, challenge, resource, extra)}`,
  );
  expect(authorize.status).toBe(302);
  const location = new URL(authorize.headers.get("location")!, GATEWAY);
  expect(location.pathname).toBe("/oauth/consent");
  const context = await consentContext(browser, location);
  return { authorize, location, context, verifier };
}

function approvalForm(
  context: Consent,
  choices: Record<string, string | string[]> = {},
): Record<string, string | string[]> {
  return {
    handle: context.handle,
    decision: "approve",
    client_id: context.client.id,
    redirect_uri: context.client.redirectUri,
    resource: context.grant.resource,
    organization_id: orgId,
    ...choices,
  };
}

/** The whole flow, from authorize to tokens, as the Mac app does it. */
async function signIn(options: {
  clientId: string;
  resource?: string;
  port?: number;
  userId?: string;
  choices?: Record<string, string | string[]>;
}): Promise<{ tokens: Tokens; context: Consent; callback: URL }> {
  const browser = new Browser(options.userId ?? ownerId);
  const resource = options.resource ?? todoOrigin;
  const redirectUri = loopback(options.port ?? 49152);
  const { context, verifier } = await openConsent(
    browser,
    options.clientId,
    redirectUri,
    resource,
  );
  if (!context.ok) throw new Error(context.message);
  const decision = await browser.postForm(
    "/oauth/consent/decision",
    approvalForm(context, options.choices),
  );
  expect(decision.status).toBe(302);
  const callback = new URL(decision.headers.get("location")!);
  expect(callback.origin).toBe(`http://127.0.0.1:${options.port ?? 49152}`);
  expect(callback.searchParams.get("state")).toBe("state-1");
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
  return { tokens: (await exchange.json()) as Tokens, context, callback };
}

/** What an app host's perimeter does with a bearer (lane b), in one call. */
async function validateOnHost(resource: string, token: string) {
  const validated = await validateAppHostToken(env, resource, token);
  if (!validated) return null;
  const caller = await resolveNativeCaller(validated.props);
  await settle();
  return caller ? { validated, caller } : null;
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

async function connectionRow(id: string) {
  const [row] = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.id, id));
  return row ?? null;
}

async function onlyConnection() {
  const rows = await db.select().from(mcpConnections);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/**
 * An app behind the SDK: `/api/me` (and anything under `/api/` or
 * `/public/`) answers who the gateway says is calling, as an app's own
 * handler reads it; every other path is a page.
 */
function app(id: string, publicKeyPem: string) {
  return everyApp(
    async (request, env) => {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/api/") || pathname.startsWith("/public/")) {
        return Response.json({
          app: id,
          user: await getEveryAppUser(request, env),
        });
      }
      return new Response(`${id} page`);
    },
    { id },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
    },
  );
}

function bindApp(binding: string, worker: ReturnType<typeof everyApp>) {
  const appEnv = { EVERYAPP_AUDIENCE: binding.slice("APP__".length) };
  hoisted.env[binding] = {
    fetch: (request: Request) =>
      worker.fetch(request, appEnv, {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext),
  };
}

async function deployApp(
  appSlug: string,
  manifest: Record<string, unknown> = {},
) {
  const name = appSlug[0]!.toUpperCase() + appSlug.slice(1);
  const { app: row } = await deployLiveApp(db, {
    organizationId: orgId,
    deployerUserId: ownerId,
    appBaseDomain: HOST,
    isInstallOrganization: false,
    appSlug,
    name,
    description: name,
    manifest: { id: appSlug, name, ...manifest },
  });
  bindApp(`APP__${row.workerName}`, app(appSlug, keys.publicKeyPem));
  return {
    rowId: row.id,
    hostname: row.hostname!,
    origin: appResourceOrigin(row.hostname!),
  };
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
});

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  kv = createKvFake();
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: keys.privateKeyPem,
    DB: { prepare: () => undefined },
    OAUTH_KV: kv.kv,
  });
  hoisted.sessions.clear();
  hoisted.background.length = 0;
  resetAppHostMcpForTests();
  resetRegistrationLimitsForTests();
  clearCatalogSyncClaimsForTests();
  clearHostnameCacheForTests();
  resetAppResourcesForTests();
  resetMcpAuthForTests();

  db = await createTestDb();
  hoisted.testDb.current = db;
  orgId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, {
    organizationId: orgId,
    role: "owner",
    email: "owner@example.com",
  });
  memberId = await seedMember(db, {
    organizationId: orgId,
    role: "member",
    email: "member@example.com",
  });
  hoisted.sessions.set(ownerId, {
    email: "owner@example.com",
    activeOrganizationId: orgId,
  });
  hoisted.sessions.set(memberId, {
    email: "member@example.com",
    activeOrganizationId: orgId,
  });
  const todo = await deployApp("todo");
  const notes = await deployApp("notes");
  todoRowId = todo.rowId;
  notesRowId = notes.rowId;
  todoOrigin = todo.origin;
  notesOrigin = notes.origin;
  expect(todoOrigin).toBe("https://todo-acme.gateway.example.com");
});

describe("issuance", () => {
  it("issues a grant for an app origin: scope *, bound to that host, one native row (`native.audience-is-one-app-host`, `native.full-scope-only`)", async () => {
    const client = await registerNativeClient();
    const { tokens, context } = await signIn({ clientId: client.client_id });

    expect(context.grant).toEqual({
      kind: "native",
      resource: todoOrigin,
      app: {
        rowId: todoRowId,
        slug: "todo",
        name: "Todo",
        hostname: "todo-acme.gateway.example.com",
      },
    });
    expect(context.client).toMatchObject({
      name: "OpenZen for Mac",
      domain: null,
      redirectHost: "127.0.0.1",
      redirectIsLoopback: true,
    });
    expect(context.writeRequested).toBe(true);
    // Only the organizations where the person can open the app, each with
    // that one app and nothing to pick.
    expect(context.organizations).toEqual([
      expect.objectContaining({
        id: orgId,
        apps: [expect.objectContaining({ rowId: todoRowId, slug: "todo" })],
      }),
    ]);

    expect(tokens).toMatchObject({
      scope: "*",
      resource: todoOrigin,
      expires_in: 3600,
    });
    expect(tokens.refresh_token).toBeTruthy();

    const row = await onlyConnection();
    expect(row).toMatchObject({
      kind: "native",
      resource: todoOrigin,
      userId: ownerId,
      organizationId: orgId,
      clientName: "OpenZen for Mac",
      clientDomain: null,
      redirectHost: "127.0.0.1",
      appScope: "selected",
      access: "write",
      revokedAt: null,
    });
    expect(
      await db
        .select({ appRowId: mcpConnectionApps.appRowId })
        .from(mcpConnectionApps),
    ).toEqual([{ appRowId: todoRowId }]);

    // On its host: validated, and the member behind it.
    const onTodo = await validateOnHost(todoOrigin, tokens.access_token);
    expect(onTodo?.validated).toMatchObject({
      audience: todoOrigin,
      scope: ["*"],
      userId: ownerId,
      clientId: client.client_id,
      props: {
        v: 1,
        kind: "native",
        connectionId: row.id,
        userId: ownerId,
        organizationId: orgId,
        appRowId: todoRowId,
      },
    });
    expect(onTodo?.caller).toEqual({
      connectionId: row.id,
      userId: ownerId,
      email: "owner@example.com",
      organizationId: orgId,
      organizationName: expect.any(String),
      orgRole: "owner",
      appRowId: todoRowId,
      clientName: "OpenZen for Mac",
      clientDomain: null,
    });
    expect((await connectionRow(row.id))?.lastUsedAt).not.toBeNull();

    // The event names the kind and the app, never a token.
    const [created] = await db.select().from(events);
    expect(created?.type).toBe("connection.created");
    expect(JSON.parse(created!.data)).toMatchObject({
      connection: {
        id: row.id,
        kind: "native",
        app: { id: "todo", rowId: todoRowId, name: "Todo" },
      },
    });
    expect(created!.data).not.toContain(tokens.access_token);
  });

  it("refuses the token at /mcp, on another app host, and with a trailing slash; refuses an /mcp token for an app host", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });

    const atMcp = await mcp(tokens.access_token);
    expect(atMcp.status).toBe(401);
    expect(atMcp.headers.get("www-authenticate")).toContain("invalid_token");
    expect(await validateOnHost(notesOrigin, tokens.access_token)).toBeNull();
    expect(await validateOnHost(MCP_RESOURCE, tokens.access_token)).toBeNull();
    // Never a different resource than the one declared (the library throws
    // for an undeclared one; validateAppHostToken answers null).
    expect(
      await validateOnHost(`${todoOrigin}/api`, tokens.access_token),
    ).toBeNull();
    expect(
      await validateOnHost(`${todoOrigin}/`, tokens.access_token),
    ).toBeNull();

    // An MCP connection's token (Codex-style, resource /mcp) opens no host.
    const mcpClient = await registerNativeClient({
      client_name: "Codex",
      redirect_uris: ["http://localhost:1455/auth/callback"],
    });
    const browser = new Browser(ownerId);
    const { context, verifier } = await openConsent(
      browser,
      mcpClient.client_id,
      "http://localhost:1455/auth/callback",
      MCP_RESOURCE,
      { scope: "mcp:read mcp:write offline_access" },
    );
    if (!context.ok) throw new Error(context.message);
    expect(context.grant).toEqual({ kind: "mcp", resource: MCP_RESOURCE });
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context, { app_mode: "all", access: "write" }),
    );
    expect(decision.status).toBe(302);
    const code = new URL(decision.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:1455/auth/callback",
      client_id: mcpClient.client_id,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    });
    expect(exchange.status).toBe(200);
    const mcpTokens = (await exchange.json()) as Tokens;
    expect(mcpTokens.scope).not.toContain("*");
    expect(await validateOnHost(todoOrigin, mcpTokens.access_token)).toBeNull();
    // And an /mcp grant's props never resolve as native, nor a native
    // grant's as an MCP caller, whatever the audience check said.
    const mcpValidated = await getMcpAuth(
      env,
    )!.authorizationServer.validateToken(
      MCP_RESOURCE,
      mcpTokens.access_token,
      env,
    );
    expect(await resolveNativeCaller(mcpValidated!.props)).toBeNull();
    const nativeValidated = await getMcpAuth(
      env,
    )!.authorizationServer.validateToken(todoOrigin, tokens.access_token, env);
    expect(await resolveOauthCaller(nativeValidated!.props, ["*"])).toBeNull();
    await settle();
  });

  it("grants * whatever scope the client asked, and never * to an MCP connection", async () => {
    const client = await registerNativeClient();
    const browser = new Browser(ownerId);
    const { context, verifier } = await openConsent(
      browser,
      client.client_id,
      loopback(5000),
      todoOrigin,
      { scope: "mcp:read" },
    );
    if (!context.ok) throw new Error(context.message);
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      // The form's app and access choices count for nothing.
      approvalForm(context, {
        access: "read",
        app_mode: "selected",
        app_ids: [notesRowId],
      }),
    );
    expect(decision.status).toBe(302);
    const code = new URL(decision.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback(5000),
      client_id: client.client_id,
      code_verifier: verifier,
      resource: todoOrigin,
    });
    expect(exchange.status).toBe(200);
    expect(((await exchange.json()) as Tokens).scope).toBe("*");
    const row = await onlyConnection();
    expect(row).toMatchObject({ access: "write", appScope: "selected" });
    expect(
      await db
        .select({ appRowId: mcpConnectionApps.appRowId })
        .from(mcpConnectionApps),
    ).toEqual([{ appRowId: todoRowId }]);
  });

  it("learns a just-deployed app's origin on the first request naming it, and lists * among its scopes", async () => {
    const client = await registerNativeClient();
    await signIn({ clientId: client.client_id });
    const ping = await deployApp("ping");
    const { tokens } = await signIn({
      clientId: client.client_id,
      resource: ping.origin,
    });
    expect(tokens.resource).toBe(ping.origin);
    expect(
      await validateOnHost(ping.origin, tokens.access_token),
    ).not.toBeNull();

    const metadata = (await (
      await send("/.well-known/oauth-authorization-server")
    ).json()) as { scopes_supported: string[]; protected_resources: string[] };
    expect(metadata.scopes_supported).toContain("*");
    // The public document names no app host: a native app discovers the
    // gateway from its own app host's metadata, and the list of every app
    // on a gateway is nobody else's to read.
    expect(metadata.protected_resources).toEqual([MCP_RESOURCE]);
    expect(JSON.stringify(metadata)).not.toContain(ping.origin);
    expect(JSON.stringify(metadata)).not.toContain(todoOrigin);
  });
});

describe("the client's request (`native.loopback-or-https-redirect`)", () => {
  it("requires PKCE S256: no challenge, a plain one, or a missing verifier", async () => {
    const client = await registerNativeClient();
    const browser = new Browser(ownerId);
    const { challenge } = pkce();
    const base = authorizeQuery(
      client.client_id,
      loopback(5000),
      challenge,
      todoOrigin,
    );

    const none = new URLSearchParams(base);
    none.delete("code_challenge");
    none.delete("code_challenge_method");
    const noChallenge = await browser.get(`/oauth/authorize?${none}`);
    expect(noChallenge.status).toBe(400);
    expect(await noChallenge.text()).toContain("PKCE");

    const plain = new URLSearchParams(base);
    plain.set("code_challenge_method", "plain");
    const plainChallenge = await browser.get(`/oauth/authorize?${plain}`);
    expect(plainChallenge.status).toBe(400);

    // A code without its verifier is worthless to whoever caught it.
    const { context } = await openConsent(
      browser,
      client.client_id,
      loopback(5000),
      todoOrigin,
    );
    if (!context.ok) throw new Error(context.message);
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context),
    );
    const code = new URL(decision.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback(5000),
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(exchange.status).toBe(400);
    await expect(exchange.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  it("takes a loopback redirect on any port and nothing else: another path, a remote http host, an unregistered https host, a private-use scheme", async () => {
    const client = await registerNativeClient({
      redirect_uris: [
        REGISTERED_LOOPBACK,
        "https://openzen.app/callback",
        "openzen:/callback",
      ],
    });
    const browser = new Browser(ownerId);
    const { challenge } = pkce();
    const attempt = (redirectUri: string) =>
      browser.get(
        `/oauth/authorize?${authorizeQuery(client.client_id, redirectUri, challenge, todoOrigin)}`,
      );

    for (const port of [1024, 49152, 65535]) {
      expect((await attempt(loopback(port))).status, `port ${port}`).toBe(302);
    }
    expect((await attempt("https://openzen.app/callback")).status).toBe(302);

    for (const redirectUri of [
      "http://127.0.0.1:5000/other",
      "http://127.0.0.1:5000/callback?x=1",
      "http://localhost:5000/callback",
      "http://openzen.app/callback",
      "https://evil.example/callback",
      "openzen:/callback",
    ]) {
      const refused = await attempt(redirectUri);
      expect(refused.status, redirectUri).toBe(400);
      // Shown on the gateway's page, never redirected (RFC 9700 §4.11.2).
      expect(refused.headers.get("location")).toBeNull();
    }
  });

  it("refuses a resource that is not an active first-party app host (`invalid_target`), shown on the page", async () => {
    const client = await registerNativeClient();
    const browser = new Browser(ownerId);
    const { challenge } = pkce();
    for (const resource of [
      "https://evil.example",
      `${todoOrigin}/api`,
      `${GATEWAY}`,
      "http://todo-acme.gateway.example.com",
    ]) {
      const refused = await browser.get(
        `/oauth/authorize?${authorizeQuery(client.client_id, loopback(5000), challenge, resource)}`,
      );
      expect(refused.status, resource).toBe(400);
      expect(refused.headers.get("location")).toBeNull();
    }
    // The token endpoint, too: a grant for todo can't be exchanged for notes.
    const { context, verifier } = await openConsent(
      browser,
      client.client_id,
      loopback(5000),
      todoOrigin,
    );
    if (!context.ok) throw new Error(context.message);
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context),
    );
    const code = new URL(decision.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback(5000),
      client_id: client.client_id,
      code_verifier: verifier,
      resource: notesOrigin,
    });
    expect(exchange.status).toBe(400);
    await expect(exchange.json()).resolves.toMatchObject({
      error: "invalid_target",
    });
  });
});

describe("consent (`native.consent-names-app-and-org`)", () => {
  it("needs app access: a member who can't open the app can't grant it, before the handle is spent", async () => {
    // The member can open Notes, not Todo.
    await AppAccessService.updateAccessForApp(
      { orgId, userId: ownerId, role: "owner" },
      notesRowId,
      [ownerId, memberId],
    );
    const client = await registerNativeClient();
    const browser = new Browser(memberId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      loopback(5000),
      todoOrigin,
    );
    expect(context).toMatchObject({ ok: false });
    expect((context as { message: string }).message).toContain("Todo");

    // A form posted anyway is refused, and the handle still stands for a
    // corrected one (the member can sign in to Notes).
    const handle = new URL(
      (
        await browser.get(
          `/oauth/authorize?${authorizeQuery(client.client_id, loopback(5000), pkce().challenge, todoOrigin)}`,
        )
      ).headers.get("location")!,
      GATEWAY,
    ).searchParams.get("handle")!;
    const refused = await browser.postForm("/oauth/consent/decision", {
      handle,
      decision: "approve",
      client_id: client.client_id,
      redirect_uri: loopback(5000),
      resource: todoOrigin,
      organization_id: orgId,
    });
    expect(refused.status).toBe(403);
    expect(await db.select().from(mcpConnections)).toEqual([]);

    const notes = await signIn({
      clientId: client.client_id,
      resource: notesOrigin,
      userId: memberId,
    });
    expect(notes.tokens.resource).toBe(notesOrigin);
  });

  it("refuses a non-member, a suspended organization, and a page that was for another resource", async () => {
    const otherOrg = await seedOrganization(db, "other");
    const outsider = await seedMember(db, {
      organizationId: otherOrg,
      role: "owner",
      email: "outsider@example.com",
    });
    hoisted.sessions.set(outsider, {
      email: "outsider@example.com",
      activeOrganizationId: otherOrg,
    });
    const client = await registerNativeClient();

    const outside = new Browser(outsider);
    const { context } = await openConsent(
      outside,
      client.client_id,
      loopback(5000),
      todoOrigin,
    );
    expect(context).toMatchObject({ ok: false });

    // An owner posting the form for an organization they're in but where
    // the app isn't: 403.
    const owner = new Browser(ownerId);
    const own = await openConsent(
      owner,
      client.client_id,
      loopback(5000),
      todoOrigin,
    );
    if (!own.context.ok) throw new Error(own.context.message);
    const wrongOrg = await owner.postForm(
      "/oauth/consent/decision",
      approvalForm(own.context, { organization_id: otherOrg }),
    );
    expect(wrongOrg.status).toBe(403);

    // The page said /mcp (an old page, say) but the request named an app.
    const mismatched = await owner.postForm(
      "/oauth/consent/decision",
      approvalForm(own.context, { resource: MCP_RESOURCE, app_mode: "all" }),
    );
    expect(mismatched.status).toBe(400);
    expect(await mismatched.text()).toContain("different app");
    expect(await db.select().from(mcpConnections)).toEqual([]);
  });

  it("supersedes the earlier grant from the same client for the same app, whatever its port, and keeps one for another app", async () => {
    const client = await registerNativeClient();
    const first = await signIn({ clientId: client.client_id, port: 50001 });
    const notes = await signIn({
      clientId: client.client_id,
      resource: notesOrigin,
      port: 50002,
    });
    const second = await signIn({ clientId: client.client_id, port: 50003 });
    await settle();

    const rows = await db.select().from(mcpConnections);
    expect(rows.map((row) => [row.resource, row.revokedReason]).sort()).toEqual(
      [
        [notesOrigin, null],
        [todoOrigin, "superseded"],
        [todoOrigin, null],
      ].sort(),
    );
    expect(
      await validateOnHost(todoOrigin, first.tokens.access_token),
    ).toBeNull();
    expect(
      await validateOnHost(todoOrigin, second.tokens.access_token),
    ).not.toBeNull();
    expect(
      await validateOnHost(notesOrigin, notes.tokens.access_token),
    ).not.toBeNull();
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.tokens.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(refresh.status).toBe(400);
  });
});

describe("lifetimes and revocation (`native.revocation-paths`, `native.per-request-recheck`)", () => {
  it("refreshes with rotation: the new token works, the old refresh token dies once the new one is used", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect(next).toMatchObject({ scope: "*", resource: todoOrigin });
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await validateOnHost(todoOrigin, next.access_token)).not.toBeNull();
    // Refreshing for another resource is refused.
    const elsewhere = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
      client_id: client.client_id,
      resource: notesOrigin,
    });
    expect(elsewhere.status).toBe(400);
    await expect(elsewhere.json()).resolves.toMatchObject({
      error: "invalid_target",
    });

    const again = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(again.status).toBe(200);
    const stale = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(stale.status).toBe(400);
    await expect(stale.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("the app's sign out (RFC 7009) ends the grant; the row says so on the next listing", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    const revoked = await tokenRequest({
      token: tokens.refresh_token,
      token_type_hint: "refresh_token",
      client_id: client.client_id,
    });
    expect(revoked.status).toBe(200);
    expect(await validateOnHost(todoOrigin, tokens.access_token)).toBeNull();
    const row = await onlyConnection();
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000 });
    expect(
      (await McpConnectionService.listForUser(ownerId)).connections,
    ).toEqual([]);
    expect((await connectionRow(row.id))?.revokedReason).toBe("ended");
  });

  it("the person's revoke under Settings → Connections stops the next request and the refresh", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    const row = await onlyConnection();
    expect(
      (await McpConnectionService.listForUser(ownerId)).connections,
    ).toEqual([
      expect.objectContaining({
        id: row.id,
        kind: "native",
        clientName: "OpenZen for Mac",
        app: { name: "Todo", hostname: "todo-acme.gateway.example.com" },
        apps: ["Todo"],
        access: "write",
      }),
    ]);
    await McpConnectionService.revokeForUser(ownerId, row.id);
    await settle();
    expect(await validateOnHost(todoOrigin, tokens.access_token)).toBeNull();
    // Even if the grant had survived in KV, the row alone refuses.
    expect(
      await resolveNativeCaller({
        v: 1,
        kind: "native",
        connectionId: row.id,
        userId: ownerId,
        organizationId: orgId,
        appRowId: todoRowId,
      }),
    ).toBeNull();
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(refresh.status).toBe(400);
    await expect(refresh.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  async function memberCanOpenTodo() {
    await AppAccessService.updateAccessForApp(
      { orgId, userId: ownerId, role: "owner" },
      todoRowId,
      [ownerId, memberId],
    );
  }

  it("nobody but the person revokes their native connection: another member's revoke is not found and changes nothing", async () => {
    await memberCanOpenTodo();
    const client = await registerNativeClient();
    const { tokens } = await signIn({
      clientId: client.client_id,
      userId: memberId,
    });
    const row = await onlyConnection();
    await expect(
      McpConnectionService.revokeForUser(ownerId, row.id),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    expect((await connectionRow(row.id))?.revokedAt).toBeNull();
    expect(
      await validateOnHost(todoOrigin, tokens.access_token),
    ).not.toBeNull();
    expect(
      (await McpConnectionService.listForUser(ownerId)).connections,
    ).toEqual([]);
  });

  it("a deactivated member is refused on the next request, and the row is revoked", async () => {
    await memberCanOpenTodo();
    const client = await registerNativeClient();
    const { tokens } = await signIn({
      clientId: client.client_id,
      userId: memberId,
    });
    expect(
      await validateOnHost(todoOrigin, tokens.access_token),
    ).not.toBeNull();
    await MembershipService.deactivate(
      { orgId, userId: ownerId, role: "owner" },
      memberId,
    );
    await settle();
    expect(await validateOnHost(todoOrigin, tokens.access_token)).toBeNull();
    expect((await onlyConnection()).revokedReason).toBe("user_deactivated");
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(refresh.status).toBe(400);
  });

  it("a member removed from the organization is refused and the row revoked as member_removed; props for another app, user or organization never resolve", async () => {
    await memberCanOpenTodo();
    const client = await registerNativeClient();
    const { tokens } = await signIn({
      clientId: client.client_id,
      userId: memberId,
    });
    const row = await onlyConnection();
    const props = {
      v: 1 as const,
      kind: "native" as const,
      connectionId: row.id,
      userId: memberId,
      organizationId: orgId,
      appRowId: todoRowId,
    };
    expect(
      await resolveNativeCaller({ ...props, appRowId: notesRowId }),
    ).toBeNull();
    expect(await resolveNativeCaller({ ...props, userId: ownerId })).toBeNull();
    expect(
      await resolveNativeCaller({ ...props, organizationId: "x" }),
    ).toBeNull();
    expect(await resolveNativeCaller({ ...props, kind: "oauth" })).toBeNull();
    await settle();

    // The membership row gone without the removal hook having run (the
    // hook is AdminService's, covered by gateway-mcp.e2e): the request's
    // own re-read refuses, and revokes the row on the way.
    await db.delete(members).where(eq(members.userId, memberId));
    expect(await validateOnHost(todoOrigin, tokens.access_token)).toBeNull();
    expect((await connectionRow(row.id))?.revokedReason).toBe("member_removed");
  });

  it("deleting the app revokes its native connections (app_removed) and takes its origin out of the resources", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    const notes = await signIn({
      clientId: client.client_id,
      resource: notesOrigin,
    });
    await AppService.delete(
      { orgId, userId: ownerId, role: "owner" },
      todoRowId,
    );
    await settle();
    const rows = await db.select().from(mcpConnections);
    expect(rows.map((row) => [row.resource, row.revokedReason]).sort()).toEqual(
      [
        [notesOrigin, null],
        [todoOrigin, "app_removed"],
      ],
    );
    // The grant is gone, and the list is re-read: the origin is unknown.
    expect(await validateOnHost(todoOrigin, tokens.access_token)).toBeNull();
    resetAppResourcesForTests();
    const mcpAuth = await mcpAuthForResource(env, todoOrigin);
    expect(mcpAuth?.appResources).toEqual([notesOrigin]);
    expect(
      await validateOnHost(notesOrigin, notes.tokens.access_token),
    ).not.toBeNull();
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      resource: todoOrigin,
    });
    expect(refresh.status).toBe(400);
    const [revokedEvent] = (await db.select().from(events)).filter(
      (event) => event.type === "connection.revoked",
    );
    expect(JSON.parse(revokedEvent!.data)).toMatchObject({
      connection: { kind: "native", app: { id: "todo" } },
      reason: "app_removed",
    });
  });

  it("an app disabled in the registry (the CLI) is refused by audience at once and its rows revoked by the hourly maintenance", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    await db
      .update(apps)
      .set({ status: "disabled" })
      .where(eq(apps.id, todoRowId));
    // Within the minute the build still knows the origin; the next read
    // drops it, and the audience check refuses the token.
    resetAppResourcesForTests();
    expect(await validateOnHost(todoOrigin, tokens.access_token)).toBeNull();
    expect((await onlyConnection()).revokedReason).toBeNull();
    await runMcpMaintenance(env);
    await settle();
    expect((await onlyConnection()).revokedReason).toBe("app_removed");
  });

  it("expires an idle connection as the hourly maintenance does for MCP ones", async () => {
    const client = await registerNativeClient();
    await signIn({ clientId: client.client_id });
    const row = await onlyConnection();
    await db
      .update(mcpConnections)
      .set({
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        lastUsedAt: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000),
      })
      .where(eq(mcpConnections.id, row.id));
    await runMcpMaintenance(env);
    await settle();
    expect((await connectionRow(row.id))?.revokedReason).toBe("expired");
  });
});

describe("on the app host (the perimeter: `mcp.app-host-refuses-oauth-tokens`, `native.bearer-routes-no-cookie`, `native.metadata-gateway-authored`)", () => {
  /** A request to an app host through the real worker entry, as a native client sends it. */
  function onHost(
    origin: string,
    path: string,
    init: RequestInit & { token?: string; cookie?: string } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("host", new URL(origin).host);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.cookie) headers.set("cookie", init.cookie);
    return server.fetch(new Request(`${origin}${path}`, { ...init, headers }));
  }

  type Echo = {
    app: string;
    user: {
      id: string;
      email: string;
      orgId: string;
      orgRole: string;
      channel: string;
      actor: { sub: string };
      scopes: string[];
    } | null;
  };

  it("serves a native token as the member on its own host, on the api channel, and refuses it on every other host and at /mcp, never anonymously", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    const row = await onlyConnection();

    const me = await onHost(todoOrigin, "/api/me", {
      token: tokens.access_token,
    });
    expect(me.status, await me.clone().text()).toBe(200);
    const echo = (await me.json()) as Echo;
    expect(echo).toEqual({
      app: "todo",
      user: {
        id: ownerId,
        email: "owner@example.com",
        orgId: orgId,
        orgRole: "owner",
        orgName: expect.any(String),
        channel: "api",
        actor: { sub: `oauth:${row.id}` },
        scopes: ["*"],
        jti: expect.any(String),
      },
    });
    await settle();
    expect((await connectionRow(row.id))?.lastUsedAt).not.toBeNull();

    // The other app's host: the audience is one origin. Fails closed, with
    // the challenge naming this host's own metadata, never a login page.
    const elsewhere = await onHost(notesOrigin, "/api/me", {
      token: tokens.access_token,
    });
    expect(elsewhere.status).toBe(401);
    expect(await elsewhere.json()).toEqual({ error: "unauthenticated" });
    expect(elsewhere.headers.get("www-authenticate")).toContain(
      `resource_metadata="${notesOrigin}/.well-known/oauth-protected-resource"`,
    );
    expect(elsewhere.headers.get("location")).toBeNull();

    // The gateway's own /mcp refuses it too (pinned above); and an /mcp
    // grant's token opens no app host.
    expect((await mcp(tokens.access_token)).status).toBe(401);
    const mcpClient = await registerNativeClient({
      client_name: "Codex",
      redirect_uris: ["http://localhost:1455/auth/callback"],
    });
    const browser = new Browser(ownerId);
    const { context, verifier } = await openConsent(
      browser,
      mcpClient.client_id,
      "http://localhost:1455/auth/callback",
      MCP_RESOURCE,
      { scope: "mcp:read mcp:write" },
    );
    if (!context.ok) throw new Error(context.message);
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context, { app_mode: "all", access: "write" }),
    );
    const code = new URL(decision.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:1455/auth/callback",
      client_id: mcpClient.client_id,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    });
    const mcpTokens = (await exchange.json()) as Tokens;
    const withMcpToken = await onHost(todoOrigin, "/api/me", {
      token: mcpTokens.access_token,
    });
    expect(withMcpToken.status).toBe(401);
    await settle();
  });

  it("stops serving on the next request once the person signs the app out, and after the app is deleted", async () => {
    const client = await registerNativeClient();
    const { tokens } = await signIn({ clientId: client.client_id });
    const row = await onlyConnection();
    expect(
      (await onHost(todoOrigin, "/api/me", { token: tokens.access_token }))
        .status,
    ).toBe(200);
    await McpConnectionService.revokeForUser(ownerId, row.id);
    await settle();
    const after = await onHost(todoOrigin, "/api/me", {
      token: tokens.access_token,
    });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthenticated" });

    const notes = await signIn({
      clientId: client.client_id,
      resource: notesOrigin,
    });
    expect(
      (
        await onHost(notesOrigin, "/api/me", {
          token: notes.tokens.access_token,
        })
      ).status,
    ).toBe(200);
    await AppService.delete(
      { orgId, userId: ownerId, role: "owner" },
      notesRowId,
    );
    await settle();
    clearHostnameCacheForTests();
    const gone = await onHost(notesOrigin, "/api/me", {
      token: notes.tokens.access_token,
    });
    expect(gone.status).not.toBe(200);
    expect(await gone.text()).not.toContain("owner@example.com");
  });

  it("a bearer route takes the token and refuses the session cookie; a public route serves nobody a refused token", async () => {
    const api = await deployApp("api", {
      public: [{ path: "/public/**" }],
      bearerRoutes: {
        paths: ["/api/**"],
        why: "The Mac app calls the API with its token.",
      },
    });
    const client = await registerNativeClient();
    const { tokens } = await signIn({
      clientId: client.client_id,
      resource: api.origin,
    });

    const withToken = await onHost(api.origin, "/api/me", {
      token: tokens.access_token,
    });
    expect(withToken.status, await withToken.clone().text()).toBe(200);
    expect(((await withToken.json()) as Echo).user?.channel).toBe("api");

    // The gateway's own session cookie on a bearer route: 401 before it is
    // read, token or not, so the Access bypass these paths get opens
    // nothing to a browser.
    for (const token of [undefined, tokens.access_token]) {
      const withCookie = await onHost(api.origin, "/api/me", {
        token,
        cookie: "better-auth.session_token=some-session",
      });
      expect(withCookie.status).toBe(401);
      await expect(withCookie.json()).resolves.toMatchObject({
        reason: "cookie_on_bearer_route",
      });
    }
    // Without a bearer: the challenge, never a login page.
    const bare = await onHost(api.origin, "/api/me", {
      headers: { accept: "text/html" },
    });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("location")).toBeNull();
    expect(bare.headers.get("www-authenticate")).toContain(
      `resource_metadata="${api.origin}/.well-known/oauth-protected-resource"`,
    );

    // A public route: anonymous without a credential, but a refused
    // gateway token (another host's) fails closed there too.
    const anonymous = await onHost(api.origin, "/public/ping");
    expect(anonymous.status).toBe(200);
    expect(((await anonymous.json()) as Echo).user).toBeNull();
    const todo = await signIn({ clientId: client.client_id });
    const refused = await onHost(api.origin, "/public/ping", {
      token: todo.tokens.access_token,
    });
    expect(refused.status).toBe(401);
    // Its own token on the public route: the member, as a personal token
    // would be.
    const own = await onHost(api.origin, "/public/ping", {
      token: tokens.access_token,
    });
    expect(own.status).toBe(200);
    expect(((await own.json()) as Echo).user?.id).toBe(ownerId);
    await settle();
  });

  it("serves the metadata document from the registry on every active first-party host, and only that document", async () => {
    const document = await onHost(
      todoOrigin,
      "/.well-known/oauth-protected-resource",
    );
    expect(document.status).toBe(200);
    expect(await document.json()).toEqual({
      resource: todoOrigin,
      authorization_servers: [GATEWAY],
      resource_name: "Todo",
      bearer_methods_supported: ["header"],
    });
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-protected-resource/mcp",
      "/mcp/.well-known/oauth-protected-resource",
    ]) {
      expect((await onHost(todoOrigin, path)).status, path).toBe(404);
    }
    // With OAuth off, the host serves no document and takes no token.
    hoisted.env["MCP_OAUTH_ENABLED"] = "false";
    expect(
      (await onHost(todoOrigin, "/.well-known/oauth-protected-resource"))
        .status,
    ).toBe(404);
    delete hoisted.env["MCP_OAUTH_ENABLED"];
  });
});
