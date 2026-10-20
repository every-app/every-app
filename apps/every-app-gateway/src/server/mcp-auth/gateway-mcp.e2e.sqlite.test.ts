/**
 * The gateway's own /mcp end to end, in process: the real worker entry
 * (server.ts), the real @cloudflare/workers-oauth-provider on an in-memory
 * KV, every migration on SQLite, and real SDK apps (`everyApp` +
 * `defineTools`) behind their service bindings. Only Better Auth's session
 * lookup (a cookie naming the user) and a client's metadata document
 * (CIMD) fetch are stubbed.
 *
 * Covers discovery, DCR and CIMD clients through authorize → consent →
 * token → tools/list → tools/call → refresh → revoke, the consent page's
 * protections, the per-request re-checks, personal tokens, the kill switch
 * and the hourly housekeeping.
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
  // The library advertises CIMD only under this compatibility flag.
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
// A session is a cookie naming its user; Better Auth's own behaviour is
// covered by the auth tests.
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

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  defineTools,
  everyApp,
  type EveryAppUser,
  type PlainToolSchema,
} from "@every-app/sdk/server";
import {
  apps,
  appToolCatalogs,
  appTools,
  mcpConnectionApps,
  mcpConnections,
  mcpToolCalls,
  members,
  rateLimitCounters,
  users,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { AdminService } from "@/server/services/AdminService";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppService } from "@/server/services/AppService";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import { McpToolCallRepository } from "@/server/repositories/McpToolCallRepository";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { MembershipService } from "@/server/services/MembershipService";
import { UserPatService } from "@/server/services/UserPatService";
import {
  clearCatalogSyncClaimsForTests,
  syncAppTools,
} from "@/server/toolbus/catalog-sync";
import { resetAppHostMcpForTests } from "@/server/toolbus/app-host-mcp";
import { listenIntervalsForTests } from "@/server/toolbus/runtime";
import { createKvFake } from "@/test/kv-fake";
import { deployLiveApp, markAppDeployed, registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { getMcpAuth } from "./config";
import { buildConsentContext, type ConsentContext } from "./consent";
import { runMcpMaintenance } from "./maintenance";
import { resetRegistrationLimitsForTests } from "./registration-limit";

const GATEWAY = "https://gateway.example.com";
const HOST = "gateway.example.com";
const RESOURCE = `${GATEWAY}/mcp`;
const CODEX_REDIRECT = "http://localhost:1455/auth/callback";
const CLAUDE_CIMD = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_CODE_CIMD = "https://claude.ai/oauth/claude-code-client-metadata";
/** Claude Code listens on a new port each time it connects. */
const loopbackRedirect = (port: number) => `http://localhost:${port}/callback`;
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

type Tokens = {
  access_token: string;
  refresh_token: string;
  scope: string;
  resource: string;
};

function objectInput<T>(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): PlainToolSchema<T> {
  return {
    jsonSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    validate: (value) => ({ value: value as T }),
  };
}

const seen: EveryAppUser[] = [];

function todoApp(publicKeyPem: string, extraTool = false) {
  return everyApp(
    async () => new Response("todo page"),
    { id: "todo" },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
      tools: defineTools({
        list_todos: {
          description: "List todos.",
          risk: "read",
          input: objectInput(),
          handler: (_input, { user }) => {
            seen.push(user);
            return { todos: [] };
          },
        },
        create_todo: {
          description: "Create a todo.",
          risk: "write",
          input: objectInput<{ title: string }>({ title: { type: "string" } }, [
            "title",
          ]),
          handler: ({ title }, { user }) => {
            seen.push(user);
            return { todo: { id: "t1", title } };
          },
        },
        delete_todo: {
          description: "Delete a todo.",
          risk: "destructive",
          input: objectInput(),
          handler: () => "deleted",
        },
        ...(extraTool
          ? {
              archive_todos: {
                description: "Archive completed todos.",
                risk: "write" as const,
                input: objectInput(),
                handler: () => "archived",
              },
            }
          : {}),
      }),
    },
  );
}

/** Another app with one read tool, `ping`, deployed beside the two above. */
function pingApp(id: string, publicKeyPem: string) {
  return everyApp(
    async () => new Response(`${id} page`),
    { id },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
      tools: defineTools({
        ping: {
          description: "Ping.",
          risk: "read",
          input: objectInput(),
          handler: () => "pong",
        },
      }),
    },
  );
}

/** An app on the SDK that declares no tools. */
function blankApp(publicKeyPem: string) {
  return everyApp(
    async () => new Response("blank page"),
    { id: "blank" },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
    },
  );
}

function notesApp(publicKeyPem: string) {
  return everyApp(
    async () => new Response("notes page"),
    { id: "notes" },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
      tools: defineTools({
        list_notes: {
          description: "List notes.",
          risk: "read",
          input: objectInput(),
          handler: () => ({ notes: [] }),
        },
        add_note: {
          description: "Add a note.",
          risk: "write",
          input: objectInput(),
          handler: () => "added",
        },
      }),
    },
  );
}

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let kv: ReturnType<typeof createKvFake>;
let orgId: string;
let ownerId: string;
let memberId: string;
let todoRowId: string;
let notesRowId: string;
let todoHost: string;
let todoBinding: string;
let notesBinding: string;
const env = hoisted.env as unknown as Cloudflare.Env;
/** The requests each app's binding received since it was bound. */
const appRequests = new Map<string, Request[]>();

/** Everything the requests scheduled after their responses. */
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

/** A browser: a cookie jar, signed in as a user (or not). */
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
    // What a browser sends for the consent page's form: the page's
    // no-referrer policy makes a form POST's Origin "null".
    headers: Record<string, string> = {
      origin: "null",
      "sec-fetch-site": "same-origin",
    },
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
          ...headers,
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

async function registerClient(
  metadata: Record<string, unknown> = {},
): Promise<{ client_id: string; token_endpoint_auth_method: string }> {
  // Codex-style: no token_endpoint_auth_method.
  const response = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Codex",
      redirect_uris: [CODEX_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...metadata,
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    client_id: string;
    token_endpoint_auth_method: string;
  }>;
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
  extra: Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "mcp:read offline_access",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...extra,
  });
}

type Consent = Extract<ConsentContext, { ok: true }>;

/** Authorize as `browser` and load the consent page's context. */
async function openConsent(
  browser: Browser,
  clientId: string,
  redirectUri: string,
) {
  const { verifier, challenge } = pkce();
  const authorize = await browser.get(
    `/oauth/authorize?${authorizeQuery(clientId, redirectUri, challenge)}`,
  );
  expect(authorize.status).toBe(302);
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
  if (!context.ok) throw new Error(context.message);
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
    organization_id: orgId,
    app_mode: "all",
    access: "write",
    ...choices,
  };
}

/** The whole flow, from authorize to tokens. */
async function connect(options: {
  clientId: string;
  redirectUri: string;
  userId?: string;
  choices?: Record<string, string | string[]>;
}): Promise<{ tokens: Tokens; context: Consent; callback: URL }> {
  const browser = new Browser(options.userId ?? ownerId);
  const { context, verifier } = await openConsent(
    browser,
    options.clientId,
    options.redirectUri,
  );
  const decision = await browser.postForm(
    "/oauth/consent/decision",
    approvalForm(context, options.choices),
  );
  expect(decision.status).toBe(302);
  const callback = new URL(decision.headers.get("location")!);
  const exchange = await tokenRequest({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  expect(exchange.status).toBe(200);
  await settle();
  return { tokens: (await exchange.json()) as Tokens, context, callback };
}

function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  return send("/mcp", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: MODERN_META },
    }),
  });
}

/** The tool names a tools/list answered with. */
async function listedNames(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  return body.result.tools.map((tool) => tool.name);
}

async function toolNames(token: string): Promise<string[]> {
  const names = await listedNames(await mcp(token, "tools/list"));
  await settle();
  return names;
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await mcp(token, "tools/call", { name, arguments: args });
  await settle();
  return {
    status: response.status,
    body: (await response.json()) as {
      result?: { content: { text: string }[]; structuredContent?: unknown };
      error?: { code: number; message: string };
    },
  };
}

type BindOptions = {
  /** The catalog answers only once this resolves. */
  heldUntil?: Promise<void>;
  /** The catalog answers 500. */
  failing?: boolean;
  /** An app from before the tools contract: `/__everyapp/*` is 404. */
  legacy?: boolean;
};

function bindApp(
  binding: string,
  app: ReturnType<typeof everyApp>,
  options: BindOptions = {},
) {
  // Deployed as everyAppWorker() does: the Worker's name is its audience.
  const env = { EVERYAPP_AUDIENCE: binding.slice("APP__".length) };
  const requests: Request[] = [];
  appRequests.set(binding, requests);
  hoisted.env[binding] = {
    fetch: async (request: Request) => {
      requests.push(request);
      const { pathname } = new URL(request.url);
      if (options.legacy && pathname.startsWith("/__everyapp/")) {
        return new Response("not found", { status: 404 });
      }
      if (pathname === "/__everyapp/tools/list") {
        if (options.failing) {
          return new Response("catalog broke", { status: 500 });
        }
        if (options.heldUntil) await options.heldUntil;
      }
      // TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
      return app.fetch(request, env, {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext);
    },
  };
}

/** How many times an app's catalog was fetched in the test so far. */
function listCalls(binding: string): number {
  return (appRequests.get(binding) ?? []).filter(
    (request) => new URL(request.url).pathname === "/__everyapp/tools/list",
  ).length;
}

/** A hold on an app's catalog answer, until the test releases it. */
function gate(): { opened: Promise<void>; release: () => void } {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

/** Another app, live as `everyapp deploy` leaves it, with no snapshot yet. */
async function deployAnotherApp(
  appSlug: string,
  worker: ReturnType<typeof everyApp>,
  options: BindOptions = {},
) {
  const name = appSlug[0]!.toUpperCase() + appSlug.slice(1);
  const { app } = await deployLiveApp(db, {
    organizationId: orgId,
    deployerUserId: ownerId,
    appBaseDomain: HOST,
    isInstallOrganization: false,
    appSlug,
    name,
    description: name,
    manifest: { id: appSlug, name },
  });
  const binding = `APP__${app.workerName}`;
  bindApp(binding, worker, options);
  return { rowId: app.id, hostname: app.hostname!, binding };
}

/** Each app's tool state on the consent page, by slug. */
function toolStates(context: Consent): Record<string, string> {
  return Object.fromEntries(
    context.organizations[0]!.apps.map((app) => [app.slug, app.tools]),
  );
}

async function catalogRow(rowId: string) {
  const [row] = await db
    .select()
    .from(appToolCatalogs)
    .where(eq(appToolCatalogs.appRowId, rowId));
  return row;
}

async function storedToolNames(rowId: string): Promise<string[]> {
  const rows = await db
    .select({ name: appTools.name })
    .from(appTools)
    .where(eq(appTools.appRowId, rowId));
  return rows.map((row) => row.name).sort();
}

/** A request to an app's host, as the CLI's live wait sends one. */
function openAppHost(hostname: string): Promise<Response> {
  return server.fetch(
    new Request(`https://${hostname}/`, { headers: { host: hostname } }),
  );
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
  vi.unstubAllGlobals();
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
    // D1-shaped, so the registry hands it to the (mocked) drizzle driver.
    DB: { prepare: () => undefined },
    OAUTH_KV: kv.kv,
  });
  hoisted.sessions.clear();
  hoisted.background.length = 0;
  seen.length = 0;
  appRequests.clear();
  resetAppHostMcpForTests();
  resetRegistrationLimitsForTests();
  clearCatalogSyncClaimsForTests();
  clearHostnameCacheForTests();

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

  // A public route, where the app owns bearer auth.
  const todoManifest = {
    id: "todo",
    name: "Todos",
    public: [{ path: "/hooks/*" }],
  };
  const notesManifest = { id: "notes", name: "Notes" };
  // Live, as `everyapp deploy` leaves them: registered, uploaded, then
  // activated by the gateway's first request over the new binding.
  const deployed = {
    organizationId: orgId,
    deployerUserId: ownerId,
    appBaseDomain: HOST,
    isInstallOrganization: false,
  };
  const { app: todo } = await deployLiveApp(db, {
    ...deployed,
    appSlug: "todo",
    name: "Todos",
    description: "Things to do",
    manifest: todoManifest,
  });
  const { app: notes } = await deployLiveApp(db, {
    ...deployed,
    appSlug: "notes",
    name: "Notes",
    description: "Notes",
    manifest: notesManifest,
  });
  todoRowId = todo.id;
  notesRowId = notes.id;
  todoHost = todo.hostname!;
  todoBinding = `APP__${todo.workerName}`;
  notesBinding = `APP__${notes.workerName}`;
  bindApp(todoBinding, todoApp(keys.publicKeyPem));
  bindApp(notesBinding, notesApp(keys.publicKeyPem));
  for (const [app, rowId] of [
    [todo, todoRowId],
    [notes, notesRowId],
  ] as const) {
    await syncAppTools({
      rowId,
      organizationId: orgId,
      appSlug: app.appSlug,
      hostname: app.hostname!,
      workerName: app.workerName!,
      tier: "service_binding",
      versionId: app.versionId,
    });
  }
  // Both apps are private to the owner until shared.
  await AppAccessService.updateAccessForApp(
    { orgId, userId: ownerId, role: "owner" },
    todoRowId,
    [ownerId, memberId],
  );
  // The tests count the catalog fetches they cause themselves.
  for (const requests of appRequests.values()) requests.length = 0;
});

describe("discovery", () => {
  it("advertises one resource, CIMD and public clients", async () => {
    const response = await send("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: GATEWAY,
      authorization_endpoint: `${GATEWAY}/oauth/authorize`,
      token_endpoint: `${GATEWAY}/oauth/token`,
      registration_endpoint: `${GATEWAY}/oauth/register`,
      revocation_endpoint: `${GATEWAY}/oauth/token`,
      protected_resources: [RESOURCE],
      scopes_supported: ["mcp:read", "mcp:write", "offline_access"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(metadata["token_endpoint_auth_methods_supported"]).toContain("none");
  });

  it("describes /mcp at its path-aware metadata URL, with the exact resource", async () => {
    const response = await send("/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [GATEWAY],
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
      resource_name: "Every App",
    });
    // The origin's own metadata describes no resource here.
    expect((await send("/.well-known/oauth-protected-resource")).status).toBe(
      404,
    );
  });

  it("challenges an anonymous /mcp request with the metadata URL", async () => {
    const response = await mcp(null, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="OAuth", resource_metadata="${GATEWAY}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`,
    );
    const invalid = await mcp("user:grant:secret", "tools/list");
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });
});

describe("a DCR client (Codex-style)", () => {
  it("registers as public, connects, calls tools, refreshes and revokes", async () => {
    const client = await registerClient();
    expect(client.token_endpoint_auth_method).toBe("none");

    // Signed out: sign in first, then come back to the same request.
    const anonymous = new Browser();
    const { challenge } = pkce();
    const query = authorizeQuery(client.client_id, CODEX_REDIRECT, challenge);
    const signIn = await anonymous.get(`/oauth/authorize?${query}`);
    expect(signIn.status).toBe(302);
    const signInUrl = new URL(signIn.headers.get("location")!, GATEWAY);
    expect(signInUrl.pathname).toBe("/sign-in");
    const back = signInUrl.searchParams.get("redirect")!;
    expect(back.startsWith("/oauth/authorize?")).toBe(true);
    expect(back).not.toContain("://");
    expect(new URLSearchParams(back.split("?")[1]).get("client_id")).toBe(
      client.client_id,
    );

    const { tokens, context, callback } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    expect(context).toMatchObject({
      client: {
        name: "Codex",
        domain: null,
        redirectHost: "localhost",
      },
      email: "owner@example.com",
      defaultOrganizationId: orgId,
      organizations: [
        {
          id: orgId,
          name: "acme",
          role: "owner",
          apps: expect.arrayContaining([
            { rowId: notesRowId, slug: "notes", name: "Notes", tools: "ready" },
            { rowId: todoRowId, slug: "todo", name: "Todos", tools: "ready" },
          ]),
        },
      ],
    });
    expect(callback.origin + callback.pathname).toBe(CODEX_REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state-1");
    expect(callback.searchParams.get("iss")).toBe(GATEWAY);
    expect(tokens.scope.split(" ").sort()).toEqual([
      "mcp:read",
      "mcp:write",
      "offline_access",
    ]);
    expect(tokens.resource).toBe(RESOURCE);

    expect(await toolNames(tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_add_note",
      "notes_list_notes",
      "todo_create_todo",
      "todo_list_todos",
    ]);
    const created = await callTool(tokens.access_token, "todo_create_todo", {
      title: "buy milk",
    });
    expect(JSON.parse(created.body.result!.content[0]!.text)).toEqual({
      todo: { id: "t1", title: "buy milk" },
    });
    const [connection] = await db.select().from(mcpConnections);
    expect(connection).toMatchObject({
      userId: ownerId,
      organizationId: orgId,
      clientId: client.client_id,
      clientName: "Codex",
      clientDomain: null,
      redirectUri: CODEX_REDIRECT,
      redirectHost: "localhost",
      appScope: "all",
      access: "write",
      revokedAt: null,
    });
    expect(connection!.lastUsedAt).toBeInstanceOf(Date);
    expect(seen.at(-1)).toMatchObject({
      id: ownerId,
      orgId,
      channel: "mcp",
      actor: { sub: `oauth:${connection!.id}` },
      scopes: ["mcp:read", "mcp:write"],
      toolCall: { name: "create_todo" },
    });
    const [audit] = await db.select().from(mcpToolCalls);
    expect(audit).toMatchObject({
      surface: "gateway",
      credentialKind: "oauth",
      credentialId: connection!.id,
      clientName: "Codex",
      appSlug: "todo",
      appRowId: todoRowId,
      toolName: "todo_create_todo",
      risk: "write",
      decision: "allowed",
      outcome: "ok",
    });
    expect(JSON.stringify(audit)).not.toContain("buy milk");

    // Refresh the way Codex does: client_id only, no secret, scope or
    // resource. The new token keeps the grant's scopes.
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.scope).toContain("mcp:write");
    expect(await toolNames(next.access_token)).toContain("todo_create_todo");

    // RFC 7009 revocation at the token endpoint.
    const revoked = await tokenRequest({
      token: next.refresh_token,
      client_id: client.client_id,
    });
    expect(revoked.status).toBe(200);
    expect((await mcp(next.access_token, "tools/list")).status).toBe(401);
  });

  it("serves its token on the 2025 protocol era too", async () => {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    const legacy = (body: Record<string, unknown>, version?: string) =>
      send("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(version ? { "mcp-protocol-version": version } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      });

    const init = await legacy({
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-ai", version: "1" },
      },
    });
    // `<uuid>.<tool list hash>`: the ToolBus compares later requests' hash.
    expect(init.headers.get("mcp-session-id")).toMatch(
      /^[0-9a-f-]{36}\.[0-9a-f]{16}$/,
    );
    expect(((await init.json()) as { result: unknown }).result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "every-app", title: "acme · Every App" },
      instructions: expect.stringContaining(
        "Apps: notes (Notes), todo (Todos).",
      ),
    });
    const call = await legacy(
      {
        method: "tools/call",
        params: { name: "todo_create_todo", arguments: { title: "legacy" } },
      },
      "2025-06-18",
    );
    const { result } = (await call.json()) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      todo: { id: "t1", title: "legacy" },
    });
    await settle();
  });

  it("answers a user who declines with access_denied, state and iss", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    const denied = await browser.postForm("/oauth/consent/decision", {
      ...approvalForm(context),
      decision: "deny",
    });
    expect(denied.status).toBe(302);
    const callback = new URL(denied.headers.get("location")!);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-1");
    expect(callback.searchParams.get("iss")).toBe(GATEWAY);
    expect(await db.select().from(mcpConnections)).toEqual([]);
  });

  it("refuses a request naming more than one resource, or another one", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { challenge } = pkce();
    for (const resources of [
      [RESOURCE, `${GATEWAY}/other`],
      [`${RESOURCE}/`],
      ["https://todo-acme.gateway.example.com/mcp"],
    ]) {
      const query = authorizeQuery(client.client_id, CODEX_REDIRECT, challenge);
      query.delete("resource");
      for (const resource of resources) query.append("resource", resource);
      const response = await browser.get(`/oauth/authorize?${query}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toContain(
        "must name exactly one configured protected resource",
      );
    }
  });

  it("shows a bad request's error here, never redirecting it to the client", async () => {
    // Anyone can register any https redirect URI: redirecting errors there
    // would make the gateway an open redirector.
    const client = await registerClient({
      redirect_uris: ["https://evil.example/x"],
    });
    const { challenge } = pkce();
    const query = authorizeQuery(
      client.client_id,
      "https://evil.example/x",
      challenge,
      { response_type: "nope" },
    );
    for (const browser of [new Browser(), new Browser(ownerId)]) {
      const response = await browser.get(`/oauth/authorize?${query}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("requires PKCE of every client, confidential ones too", async () => {
    const client = await registerClient({
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(client.token_endpoint_auth_method).toBe("client_secret_post");
    const { challenge } = pkce();
    const query = authorizeQuery(client.client_id, CODEX_REDIRECT, challenge);
    query.delete("code_challenge");
    query.delete("code_challenge_method");
    const response = await new Browser(ownerId).get(
      `/oauth/authorize?${query}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("PKCE");
  });

  it("refuses redirect URIs on the gateway's own domain", async () => {
    const { challenge } = pkce();
    for (const redirectUri of [
      `${GATEWAY}/callback`,
      "https://todo-acme.gateway.example.com/hooks/callback",
    ]) {
      const client = await registerClient({ redirect_uris: [redirectUri] });
      const response = await new Browser(ownerId).get(
        `/oauth/authorize?${authorizeQuery(client.client_id, redirectUri, challenge)}`,
      );
      expect(response.status, redirectUri).toBe(400);
      expect(await response.text()).toContain("gateway&#39;s own domain");
    }
    expect(await db.select().from(mcpConnections)).toEqual([]);
  });

  it("shows a registered name without control characters, clipped", async () => {
    const client = await registerClient({
      client_name: `Cl\u202Eedua\u202C ${"x".repeat(200)}`,
    });
    const { context } = await openConsent(
      new Browser(ownerId),
      client.client_id,
      CODEX_REDIRECT,
    );
    expect(context.client.name).toMatch(/^Cledua x+…$/);
    expect([...context.client.name]).toHaveLength(80);
  });

  it("never lets its token into an app host, nor hands it to an app", async () => {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    for (const path of ["/mcp", "/", "/api/todos", "/hooks/incoming"]) {
      const response = await server.fetch(
        new Request(`https://todo-acme.gateway.example.com${path}`, {
          method: path === "/mcp" ? "POST" : "GET",
          headers: {
            host: "todo-acme.gateway.example.com",
            authorization: `Bearer ${tokens.access_token}`,
            accept: "application/json",
          },
        }),
      );
      expect(response.status, path).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        `connect ${RESOURCE}`,
      );
    }
    expect(seen).toEqual([]);
  });

  it("supersedes the earlier connection when the same client connects again", async () => {
    const client = await registerClient();
    const first = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    const second = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
      choices: { access: "read" },
    });

    const rows = await db
      .select()
      .from(mcpConnections)
      .orderBy(mcpConnections.createdAt);
    expect(rows.map((row) => row.revokedReason)).toEqual(["superseded", null]);
    expect((await mcp(first.tokens.access_token, "tools/list")).status).toBe(
      401,
    );
    expect(await toolNames(second.tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_list_notes",
      "todo_list_todos",
    ]);
  });
  it("never retires a connection made while it was being approved", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    // Another consent for the same client, recorded while this one completes.
    const supersede = McpConnectionRepository.supersedeEarlier;
    vi.spyOn(
      McpConnectionRepository,
      "supersedeEarlier",
    ).mockImplementationOnce(async (connection, sameInstallation) => {
      await db.insert(mcpConnections).values({
        id: "mcpc_concurrent",
        userId: ownerId,
        organizationId: orgId,
        clientId: client.client_id,
        clientName: "Codex",
        redirectUri: CODEX_REDIRECT,
        redirectHost: "localhost",
        appScope: "all",
        access: "write",
        createdAt: new Date(connection.createdAt.getTime() + 1),
      });
      return supersede(connection, sameInstallation);
    });
    const approved = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context),
    );
    expect(approved.status).toBe(302);
    const rows = await db
      .select({ id: mcpConnections.id, reason: mcpConnections.revokedReason })
      .from(mcpConnections);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reason === null)).toBe(true);
  });

  it("still sends the code when retiring earlier connections fails", async () => {
    const client = await registerClient();
    const first = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    vi.spyOn(McpConnectionRepository, "supersedeEarlier").mockRejectedValueOnce(
      new Error("D1_ERROR: unavailable"),
    );
    const second = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    expect((await mcp(second.tokens.access_token, "tools/list")).status).toBe(
      200,
    );
    // Its grant went with the completion, so it is shut out all the same.
    expect((await mcp(first.tokens.access_token, "tools/list")).status).toBe(
      401,
    );
  });
});

describe("dynamic client registration", () => {
  const CURSOR = {
    client_name: "Cursor",
    redirect_uris: [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      CODEX_REDIRECT,
    ],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };

  function register(
    metadata: Record<string, unknown>,
    address = "203.0.113.7",
  ) {
    return send("/oauth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": address,
      },
      body: JSON.stringify(metadata),
    });
  }

  const registeredClients = () =>
    [...kv.store.keys()].filter((key) => key.startsWith("client:"));

  it("stores only what Every App uses, for 60 days", async () => {
    const response = await register({
      ...CURSOR,
      client_name: `Spam ${"x".repeat(500)}`,
      "client_name#fr": "Pourriel",
      contacts: ["x".repeat(10_000)],
      logo_uri: "https://evil.example/logo.png",
      client_uri: "https://evil.example",
      policy_uri: "https://evil.example/policy",
      tos_uri: "https://evil.example/tos",
    });
    expect(response.status).toBe(201);
    const { client_id: clientId } = (await response.json()) as {
      client_id: string;
    };
    const entry = kv.store.get(`client:${clientId}`)!;
    const stored = JSON.parse(entry.value) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "authMethodExplicit",
      "clientId",
      "clientName",
      "grantTypes",
      "redirectUris",
      "registrationDate",
      "registrationExpiresAt",
      "responseTypes",
      "tokenEndpointAuthMethod",
    ]);
    expect([...(stored["clientName"] as string)]).toHaveLength(200);
    expect(entry.value.length).toBeLessThan(1024);
    expect(Math.round((entry.expiresAt! - Date.now()) / 86_400_000)).toBe(60);
  });

  it("refuses a registration over 16 KiB, storing nothing", async () => {
    const response = await register({
      ...CURSOR,
      contacts: ["x".repeat(20 * 1024)],
    });
    expect(response.status).toBe(413);
    expect(registeredClients()).toEqual([]);
  });

  it("limits registrations per address and per gateway, per day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    const minuteLater = () => vi.setSystemTime(Date.now() + 61_000);

    // A burst from one address: five a minute.
    for (let count = 0; count < 5; count += 1) {
      expect((await register(CURSOR)).status).toBe(201);
    }
    const burst = await register(CURSOR);
    expect(burst.status).toBe(429);
    expect(burst.headers.get("retry-after")).toBe("60");

    // Twenty a day from one address.
    for (let count = 5; count < 20; count += 1) {
      if (count % 5 === 0) minuteLater();
      expect((await register(CURSOR)).status, `${count}`).toBe(201);
    }
    minuteLater();
    const daily = await register(CURSOR);
    expect(daily.status).toBe(429);
    await expect(daily.json()).resolves.toMatchObject({
      error: "rate_limited",
    });
    expect(Number(daily.headers.get("retry-after"))).toBe(
      (Date.parse("2026-10-14T00:00:00Z") - Date.now()) / 1000,
    );
    // Another address still can, until the gateway's 200 a day are spent.
    expect((await register(CURSOR, "198.51.100.1")).status).toBe(201);
    const gatewayKey = "oauth-register:gateway:2026-10-13";
    const [counter] = await db
      .select()
      .from(rateLimitCounters)
      .where(eq(rateLimitCounters.key, gatewayKey));
    expect(counter?.count).toBe(21);
    await db
      .update(rateLimitCounters)
      .set({ count: 200 })
      .where(eq(rateLimitCounters.key, gatewayKey));
    expect((await register(CURSOR, "192.0.2.1")).status).toBe(429);
    expect(registeredClients()).toHaveLength(21);

    // A new day, a new budget.
    vi.setSystemTime(new Date("2026-10-14T00:00:01Z"));
    expect((await register(CURSOR)).status).toBe(201);
  });

  it("gives the hosted gateway larger registration budgets", async () => {
    hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "hosted";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    expect((await register(CURSOR)).status).toBe(201);
    const counters = await db.select().from(rateLimitCounters);
    const gatewayKey = "oauth-register:gateway:2026-10-13";
    const addressKey = counters.find((row) => row.key !== gatewayKey)!.key;
    const spend = (key: string, count: number) =>
      db
        .update(rateLimitCounters)
        .set({ count })
        .where(eq(rateLimitCounters.key, key));

    // Past a self-hosted gateway's 20 an address and 200 a day...
    await spend(addressKey, 20);
    await spend(gatewayKey, 200);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await register(CURSOR)).status).toBe(201);
    // ...up to 200 an address and 20,000 a day.
    await spend(addressKey, 200);
    expect((await register(CURSOR)).status).toBe(429);
    await spend(gatewayKey, 20_000);
    expect((await register(CURSOR, "198.51.100.1")).status).toBe(429);
  });

  it("registers no client when the deployment mode is invalid", async () => {
    delete hoisted.env["GATEWAY_DEPLOYMENT_MODE"];
    const response = await register(CURSOR);
    expect(response.status).toBe(429);
    expect(registeredClients()).toEqual([]);
  });

  it("is off with MCP_DCR_ENABLED=false; clients registered before keep working", async () => {
    const client = await registerClient();
    hoisted.env["MCP_DCR_ENABLED"] = "false";
    const metadata = (await (
      await send("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("registration_endpoint");
    expect(metadata["client_id_metadata_document_supported"]).toBe(true);
    expect((await register(CURSOR)).status).toBe(404);

    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    expect(await toolNames(tokens.access_token)).toContain("todo_create_todo");
  });
});

describe("a CIMD client (claude.ai-style)", () => {
  /** Claude's metadata documents, and Claude Code's (loopback, any port). */
  function stubClaudeMetadata() {
    const documents: Record<string, Record<string, unknown>> = {
      [CLAUDE_CIMD]: {
        client_name: "Claude",
        client_uri: "https://claude.ai",
        redirect_uris: [CLAUDE_REDIRECT, "http://localhost/callback"],
      },
      [CLAUDE_CODE_CIMD]: {
        client_name: "Claude Code",
        redirect_uris: [
          "http://localhost/callback",
          "http://127.0.0.1/callback",
        ],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      const document = documents[url];
      if (!document) return new Response("not found", { status: 404 });
      return Response.json({
        client_id: url,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...document,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("shows its verified domain and grants read-only access to chosen apps", async () => {
    const fetchMock = stubClaudeMetadata();
    const { tokens, context, callback } = await connect({
      clientId: CLAUDE_CIMD,
      redirectUri: CLAUDE_REDIRECT,
      userId: memberId,
      choices: { app_mode: "selected", app_ids: [todoRowId], access: "read" },
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(context.client).toEqual({
      id: CLAUDE_CIMD,
      name: "Claude",
      domain: "claude.ai",
      redirectUri: CLAUDE_REDIRECT,
      redirectHost: "claude.ai",
    });
    // The member was never given the notes app.
    expect(context.organizations[0]!.apps.map((app) => app.slug)).toEqual([
      "todo",
    ]);
    expect(callback.origin + callback.pathname).toBe(CLAUDE_REDIRECT);
    expect(tokens.scope.split(" ").sort()).toEqual([
      "mcp:read",
      "offline_access",
    ]);

    // Read only, one app: no write tools, no other app.
    expect(await toolNames(tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "todo_list_todos",
    ]);
    const write = await callTool(tokens.access_token, "todo_create_todo", {
      title: "x",
    });
    expect(write.body.error).toEqual({
      code: -32602,
      message: "Unknown tool: todo_create_todo",
    });
    const whoami = await callTool(tokens.access_token, "everyapp_whoami");
    expect(whoami.body.result!.structuredContent).toEqual({
      user: { email: "member@example.com", role: "member" },
      organization: { id: orgId, name: "acme" },
      connection: { kind: "oauth", access: "read only", client: "Claude" },
      apps: ["todo"],
    });
    const [connection] = await db.select().from(mcpConnections);
    expect(connection).toMatchObject({
      clientDomain: "claude.ai",
      appScope: "selected",
      access: "read",
    });
    expect(
      await db
        .select({ appRowId: mcpConnectionApps.appRowId })
        .from(mcpConnectionApps),
    ).toEqual([{ appRowId: todoRowId }]);
  });

  it("replaces a connection only from the same installation (redirect URI)", async () => {
    stubClaudeMetadata();
    const web = await connect({
      clientId: CLAUDE_CIMD,
      redirectUri: CLAUDE_REDIRECT,
    });
    // One client id serves every installation; another redirect URI is
    // another installation, which keeps its own connection. An app on the
    // user's computer is one installation whatever port it listens on.
    const local = await connect({
      clientId: CLAUDE_CIMD,
      redirectUri: loopbackRedirect(51001),
    });
    const localAgain = await connect({
      clientId: CLAUDE_CIMD,
      redirectUri: loopbackRedirect(52002),
    });
    const webAgain = await connect({
      clientId: CLAUDE_CIMD,
      redirectUri: CLAUDE_REDIRECT,
    });

    const rows = await db
      .select({
        redirectUri: mcpConnections.redirectUri,
        revokedReason: mcpConnections.revokedReason,
      })
      .from(mcpConnections)
      .orderBy(mcpConnections.createdAt);
    expect(rows).toEqual([
      { redirectUri: CLAUDE_REDIRECT, revokedReason: "superseded" },
      { redirectUri: loopbackRedirect(51001), revokedReason: "superseded" },
      { redirectUri: loopbackRedirect(52002), revokedReason: null },
      { redirectUri: CLAUDE_REDIRECT, revokedReason: null },
    ]);
    for (const replaced of [web, local]) {
      expect(
        (await mcp(replaced.tokens.access_token, "tools/list")).status,
      ).toBe(401);
    }
    for (const current of [localAgain, webAgain]) {
      expect(await toolNames(current.tokens.access_token)).toContain(
        "todo_create_todo",
      );
    }
  });

  it("replaces Claude Code's connection when it reconnects on another port", async () => {
    stubClaudeMetadata();
    const first = await connect({
      clientId: CLAUDE_CODE_CIMD,
      redirectUri: loopbackRedirect(51001),
    });
    expect(first.context.client).toMatchObject({
      name: "Claude Code",
      domain: "claude.ai",
      redirectHost: "localhost",
    });
    // Reconnected to step down to read only, on a new port.
    const second = await connect({
      clientId: CLAUDE_CODE_CIMD,
      redirectUri: loopbackRedirect(51999),
      choices: { access: "read" },
    });

    const rows = await db
      .select({
        access: mcpConnections.access,
        revokedReason: mcpConnections.revokedReason,
      })
      .from(mcpConnections)
      .orderBy(mcpConnections.createdAt);
    expect(rows).toEqual([
      { access: "write", revokedReason: "superseded" },
      { access: "read", revokedReason: null },
    ]);
    // The read & write connection is gone, tokens, grant and all.
    expect((await mcp(first.tokens.access_token, "tools/list")).status).toBe(
      401,
    );
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.tokens.refresh_token,
      client_id: CLAUDE_CODE_CIMD,
    });
    expect(refreshed.status).toBe(400);
    await expect(refreshed.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(await toolNames(second.tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_list_notes",
      "todo_list_todos",
    ]);
    expect(
      (await McpConnectionService.listForUser(ownerId)).connections.map(
        (connection) => connection.access,
      ),
    ).toEqual(["read"]);

    // 127.0.0.1 is another host, so another installation.
    const other = await connect({
      clientId: CLAUDE_CODE_CIMD,
      redirectUri: "http://127.0.0.1:53000/callback",
    });
    expect(await toolNames(second.tokens.access_token)).toContain(
      "todo_list_todos",
    );
    expect(await toolNames(other.tokens.access_token)).toContain(
      "todo_create_todo",
    );
  });

  it("keeps the earlier connection when a new one can't be completed", async () => {
    stubClaudeMetadata();
    const first = await connect({
      clientId: CLAUDE_CIMD,
      redirectUri: CLAUDE_REDIRECT,
    });
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      CLAUDE_CIMD,
      CLAUDE_REDIRECT,
    );
    // The decision reads the document twice: to describe the client, then
    // to complete the authorization. The second read fails.
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads += 1;
        return reads === 1
          ? Response.json({
              client_id: CLAUDE_CIMD,
              client_name: "Claude",
              redirect_uris: [CLAUDE_REDIRECT],
              token_endpoint_auth_method: "none",
            })
          : new Response("down", { status: 503 });
      }),
    );
    const failed = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context),
    );
    expect(failed.status).toBe(400);

    const rows = await db
      .select({ revokedReason: mcpConnections.revokedReason })
      .from(mcpConnections)
      .orderBy(mcpConnections.createdAt);
    expect(rows).toEqual([
      { revokedReason: null },
      { revokedReason: "failed" },
    ]);
    expect(await toolNames(first.tokens.access_token)).toContain(
      "todo_create_todo",
    );
  });

  it("refuses apps the user can't use, before spending the consent", async () => {
    stubClaudeMetadata();
    const browser = new Browser(memberId);
    const { context } = await openConsent(
      browser,
      CLAUDE_CIMD,
      CLAUDE_REDIRECT,
    );
    for (const appIds of [[notesRowId], []]) {
      const refused = await browser.postForm(
        "/oauth/consent/decision",
        approvalForm(context, { app_mode: "selected", app_ids: appIds }),
      );
      expect(refused.status).toBe(400);
    }
    // Still usable: the same page can be submitted with a valid choice.
    const approved = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context, { app_mode: "selected", app_ids: [todoRowId] }),
    );
    expect(approved.status).toBe(302);
  });

  it("never fetches a metadata document from the gateway's own domain", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { challenge } = pkce();
    const clientId = "https://todo-acme.gateway.example.com/hooks/client.json";
    const response = await new Browser(ownerId).get(
      `/oauth/authorize?${authorizeQuery(clientId, CLAUDE_REDIRECT, challenge)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("gateway&#39;s own domain");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nor from APP_BASE_DOMAIN when apps live apart from the gateway", async () => {
    hoisted.env["APP_BASE_DOMAIN"] = "apps.example.net";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { challenge } = pkce();
    const clientId = "https://todo.apps.example.net/hooks/client.json";
    const response = await new Browser(ownerId).get(
      `/oauth/authorize?${authorizeQuery(clientId, CLAUDE_REDIRECT, challenge)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("gateway&#39;s own domain");
    expect(fetchMock).not.toHaveBeenCalled();

    const redirectUri = "https://todo.apps.example.net/callback";
    const client = await registerClient({ redirect_uris: [redirectUri] });
    const redirected = await new Browser(ownerId).get(
      `/oauth/authorize?${authorizeQuery(client.client_id, redirectUri, challenge)}`,
    );
    expect(redirected.status).toBe(400);
    expect(await redirected.text()).toContain("gateway&#39;s own domain");
    expect(await db.select().from(mcpConnections)).toEqual([]);
  });

  it("nor for the consent page or the token endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const clientId = "https://todo-acme.gateway.example.com/hooks/client.json";
    const segment = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const assertion = `${segment({ alg: "RS256" })}.${segment({ iss: clientId, sub: clientId })}.c2ln`;

    // Anonymous token and revocation requests, however they name the client.
    for (const [params, headers] of [
      [
        {
          grant_type: "refresh_token",
          refresh_token: "a:b:c",
          client_id: clientId,
        },
        {},
      ],
      [
        { grant_type: "refresh_token", refresh_token: "a:b:c" },
        {
          authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:secret`)}`,
        },
      ],
      [
        {
          grant_type: "refresh_token",
          refresh_token: "a:b:c",
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
        {},
      ],
      [{ token: "a:b:c", client_id: `${GATEWAY}/client.json` }, {}],
    ] as const) {
      const response = await send("/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(params),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_client",
      });
    }

    // The consent page's context, for a client or a redirect URI there.
    const { challenge } = pkce();
    for (const [client, redirectUri] of [
      [clientId, CLAUDE_REDIRECT],
      [CLAUDE_CIMD, "https://todo-acme.gateway.example.com/hooks/callback"],
    ] as const) {
      const query = authorizeQuery(client, redirectUri, challenge);
      query.set("handle", "anything");
      const context = await buildConsentContext(
        getMcpAuth(env)!,
        env,
        `?${query}`,
        {
          id: ownerId,
          email: "owner@example.com",
          activeOrganizationId: orgId,
        },
      );
      expect(context).toEqual({
        ok: false,
        message: expect.stringContaining("gateway's own domain"),
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a metadata document that can't be fetched, without redirecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const { challenge } = pkce();
    const response = await new Browser(ownerId).get(
      `/oauth/authorize?${authorizeQuery(CLAUDE_CIMD, CLAUDE_REDIRECT, challenge)}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain(
      "This app couldn&#39;t be verified",
    );
  });
});

describe("a CIMD client that signs its token requests (ChatGPT-style)", () => {
  const CHATGPT_CIMD = "https://chatgpt.com/oauth/client.json";
  const CHATGPT_REDIRECT =
    "https://chatgpt.com/connector_platform_oauth_redirect";
  const KID = "chatgpt-key-1";
  const ASSERTION_TYPE =
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

  function stubChatGptMetadata(publicKeyPem: string) {
    const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== CHATGPT_CIMD) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          client_id: CHATGPT_CIMD,
          client_name: "ChatGPT",
          redirect_uris: [CHATGPT_REDIRECT],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          // Both, preferring signed requests, as ChatGPT's document does.
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
          token_endpoint_auth_signing_alg: "RS256",
          jwks: { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] },
        });
      }),
    );
  }

  /** An RFC 7523 client assertion, signed RS256. */
  function assertion(
    privateKeyPem: string,
    jti = randomBytes(16).toString("hex"),
  ) {
    const now = Math.floor(Date.now() / 1000);
    const segment = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = [
      segment({ alg: "RS256", kid: KID, typ: "JWT" }),
      segment({
        iss: CHATGPT_CIMD,
        sub: CHATGPT_CIMD,
        aud: `${GATEWAY}/oauth/token`,
        iat: now,
        exp: now + 300,
        jti,
      }),
    ].join(".");
    const signature = sign("RSA-SHA256", Buffer.from(signed), privateKeyPem);
    return `${signed}.${signature.toString("base64url")}`;
  }

  it("exchanges and refreshes with a client assertion through the capped token body", async () => {
    stubChatGptMetadata(keys.publicKeyPem);
    const browser = new Browser(ownerId);
    const { context, verifier } = await openConsent(
      browser,
      CHATGPT_CIMD,
      CHATGPT_REDIRECT,
    );
    expect(context.client).toMatchObject({
      name: "ChatGPT",
      domain: "chatgpt.com",
      redirectHost: "chatgpt.com",
    });
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context),
    );
    expect(decision.status).toBe(302);
    const code = new URL(decision.headers.get("location")!).searchParams.get(
      "code",
    )!;

    // The assertion and its type are what the gateway read (capped) and
    // handed on: the library verifies the signature, issuer, audience and
    // single-use jti from them.
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
      client_id: CHATGPT_CIMD,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion(keys.privateKeyPem),
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as Tokens;
    expect(await toolNames(tokens.access_token)).toContain("todo_create_todo");

    // A refresh names the client only by the assertion's issuer.
    const replayed = assertion(keys.privateKeyPem, "jti-once");
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: replayed,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Tokens;
    expect(await toolNames(next.access_token)).toContain("todo_create_todo");

    // An assertion is single use, and must be signed with the client's key.
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    for (const bad of [replayed, assertion(other.privateKey)]) {
      const refused = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: next.refresh_token,
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: bad,
      });
      expect(refused.status).toBe(401);
      await expect(refused.json()).resolves.toMatchObject({
        error: "invalid_client",
      });
    }
  });
});

describe("the consent page and decision", () => {
  it("binds the consent to the browser, forbids framing and caching", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { authorize, location } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    expect(authorize.headers.get("cache-control")).toBe("no-store");
    expect(authorize.headers.get("x-frame-options")).toBe("DENY");
    expect(authorize.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(authorize.headers.get("referrer-policy")).toBe("no-referrer");
    const binding = authorize.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("__Host-everyapp-oauth-consent-"));
    expect(binding).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    expect(location.searchParams.get("handle")).toBeTruthy();

    // The page itself: served by TanStack, under the same headers.
    const page = await browser.get(`/oauth/consent${location.search}`);
    expect(hoisted.controlPlane).toHaveBeenCalled();
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses a decision from another site, another browser, or twice", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    const form = approvalForm(context);

    // Another site, with the user's cookies: the control-plane guard.
    const crossSite = await browser.postForm("/oauth/consent/decision", form, {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    // A sibling app on the same site.
    const sameSite = await browser.postForm("/oauth/consent/decision", form, {
      origin: "https://todo-acme.gateway.example.com",
      "sec-fetch-site": "same-site",
    });
    expect(sameSite.status).toBe(403);
    // A browser without Fetch Metadata must name the gateway's origin.
    for (const origin of ["null", "https://evil.example"]) {
      const legacy = await browser.postForm("/oauth/consent/decision", form, {
        origin,
      });
      expect(legacy.status, origin).toBe(403);
    }
    // The same user, in a browser that didn't start this authorization.
    const elsewhere = await new Browser(ownerId).postForm(
      "/oauth/consent/decision",
      form,
    );
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain("not started in this browser");
    // Signed out.
    const signedOut = new Browser();
    for (const [name, value] of browser.cookies) {
      if (name.startsWith("__Host-")) signedOut.cookies.set(name, value);
    }
    expect(
      (await signedOut.postForm("/oauth/consent/decision", form)).status,
    ).toBe(401);
    // A page showing one app can't approve another.
    expect(
      (
        await browser.postForm("/oauth/consent/decision", {
          ...form,
          redirect_uri: "http://localhost:9999/callback",
        })
      ).status,
    ).toBe(400);
    expect(await db.select().from(mcpConnections)).toEqual([]);

    // Fresh page, approved once; the handle can't be replayed.
    const again = await openConsent(browser, client.client_id, CODEX_REDIRECT);
    const approved = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(again.context),
    );
    expect(approved.status).toBe(302);
    const replay = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(again.context),
    );
    expect(replay.status).toBe(400);
    expect(await db.select().from(mcpConnections)).toHaveLength(1);
  });

  it("approves a consent once, even when the library lets its handle through twice", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context, verifier } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    // The library spends a handle with a KV get, then a delete that another
    // request (or another location's read) may not see yet.
    const store = kv.store;
    vi.spyOn(kv.kv, "delete").mockImplementation(async (key: string) => {
      if (!key.startsWith("transaction:")) store.delete(key);
    });
    // A double-clicked Allow: both requests carry the browser's binding
    // cookie, and both get past the library.
    const answers = await Promise.all([
      browser.postForm("/oauth/consent/decision", approvalForm(context)),
      browser.postForm("/oauth/consent/decision", approvalForm(context)),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([302, 409]);
    const refused = answers.find((answer) => answer.status === 409)!;
    expect(await refused.text()).toContain("already answered");
    expect(await db.select().from(mcpConnections)).toHaveLength(1);
    expect(
      [...store.keys()].filter((key) => key.startsWith("grant:")),
    ).toHaveLength(1);

    const approved = answers.find((answer) => answer.status === 302)!;
    const exchange = await tokenRequest({
      grant_type: "authorization_code",
      code: new URL(approved.headers.get("location")!).searchParams.get(
        "code",
      )!,
      redirect_uri: CODEX_REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(exchange.status).toBe(200);
  });

  it("only grants organizations the user belongs to", async () => {
    const otherOrg = await seedOrganization(db, "other");
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    const refused = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context, { organization_id: otherOrg }),
    );
    expect(refused.status).toBe(403);
  });
});

describe("limits and failures", () => {
  /** A chunked body (no Content-Length) that would run to 4 MiB. */
  function chunkedBody() {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 64) return controller.close();
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    });
    return { body, pulled: () => pulled };
  }

  it("refuses an oversized body without reading all of it", async () => {
    for (const [path, contentType] of [
      ["/oauth/token", "application/x-www-form-urlencoded"],
      ["/oauth/register", "application/json"],
    ]) {
      const { body, pulled } = chunkedBody();
      const response = await send(path, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
        duplex: "half",
      } as RequestInit);
      expect(response.status, path).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_request",
      });
      expect(pulled(), path).toBeLessThan(64);
    }

    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    const { body, pulled } = chunkedBody();
    const decision = await send("/oauth/consent/decision", {
      method: "POST",
      headers: {
        cookie: browser.cookieHeader(),
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        "sec-fetch-site": "same-origin",
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect(decision.status).toBe(413);
    expect(pulled()).toBeLessThan(64);
    // The consent wasn't spent.
    expect(
      (await browser.postForm("/oauth/consent/decision", approvalForm(context)))
        .status,
    ).toBe(302);
  });

  it("keeps a grant whose refresh can't be checked just now", async () => {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    vi.spyOn(
      McpConnectionRepository,
      "findActiveWithMembership",
    ).mockRejectedValueOnce(new Error("D1_ERROR: unavailable"));
    const failed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      error: "temporarily_unavailable",
    });

    const retried = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(retried.status).toBe(200);
  });

  it("answers a failure with a page or an error its caller reads", async () => {
    const client = await registerClient();
    const browser = new Browser(ownerId);
    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    vi.spyOn(McpConnectionRepository, "create").mockRejectedValueOnce(
      new Error("D1_ERROR: unavailable"),
    );
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context),
    );
    expect(decision.status).toBe(503);
    expect(decision.headers.get("content-type")).toContain("text/html");
    expect(await decision.text()).toContain("Something went wrong");

    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    vi.spyOn(
      McpConnectionRepository,
      "findActiveWithMembership",
    ).mockRejectedValueOnce(new Error("D1_ERROR: unavailable"));
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(503);
  });
});

describe("every request re-checks the connection", () => {
  async function connected(userId = ownerId) {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
      userId,
    });
    const [connection] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, userId));
    return { client, tokens, connectionId: connection!.id };
  }

  it("stops a revoked connection at once, and its refresh", async () => {
    const { client, tokens, connectionId } = await connected();
    expect(await McpConnectionService.listForUser(ownerId)).toMatchObject({
      connections: [
        { id: connectionId, clientName: "Codex", apps: "all", access: "write" },
      ],
    });

    await McpConnectionService.revokeForUser(ownerId, connectionId);

    const response = await mcp(tokens.access_token, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
    expect(
      [...kv.store.keys()].filter((key) => key.startsWith("grant:")),
    ).toEqual([]);
    expect(await McpConnectionService.listForUser(ownerId)).toEqual({
      connections: [],
    });
    await expect(
      McpConnectionService.revokeForUser(ownerId, connectionId),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });

  it("drops a connection from the list once its client revoked the grant", async () => {
    const { client, tokens, connectionId } = await connected();
    const revoked = await tokenRequest({
      token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(revoked.status).toBe(200);
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);

    // Just made: listed until the grant can be trusted to show in KV lists.
    expect(
      (await McpConnectionService.listForUser(ownerId)).connections,
    ).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await McpConnectionService.listForUser(ownerId)).toEqual({
      connections: [],
    });
    const [row] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    expect(row?.revokedReason).toBe("ended");
  });

  it("refuses another user's connection", async () => {
    const { connectionId } = await connected();
    await expect(
      McpConnectionService.revokeForUser(memberId, connectionId),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });

  it("stops a member who was removed from the organization", async () => {
    const { tokens, connectionId } = await connected(memberId);
    await AdminService.deleteUser(
      { orgId, userId: ownerId, role: "owner" },
      memberId,
    );
    await settle();
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
    // The member was in no other organization, so the account is gone and
    // the connection with it; the grant went first.
    expect(
      await db
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.id, connectionId)),
    ).toEqual([]);
    expect([...kv.store.keys()].some((key) => key.startsWith("grant:"))).toBe(
      false,
    );
  });

  it("marks a connection whose member is gone, however that happened", async () => {
    const { tokens, connectionId } = await connected(memberId);
    // A removal that skipped the service (an old gateway, a manual fix).
    await db.run(
      sql`DELETE FROM members WHERE user_id = ${memberId} AND organization_id = ${orgId}`,
    );
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
    await settle();
    const [row] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    expect(row?.revokedReason).toBe("member_removed");
  });

  it("stops a connection from before the member left and was invited back", async () => {
    const { tokens, connectionId } = await connected(memberId);
    const [connection] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    // Leaving (Better Auth's own endpoint) deletes the membership without
    // the gateway's hooks; an invitation then makes a new one.
    await db.run(
      sql`DELETE FROM members WHERE user_id = ${memberId} AND organization_id = ${orgId}`,
    );
    await db.insert(members).values({
      id: "member-again",
      organizationId: orgId,
      userId: memberId,
      role: "member",
      createdAt: new Date(connection!.createdAt.getTime() + 1),
    });
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
    await settle();
    const [row] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    expect(row?.revokedReason).toBe("member_removed");

    // A connection made since works.
    const again = await connected(memberId);
    expect((await mcp(again.tokens.access_token, "tools/list")).status).toBe(
      200,
    );
  });

  it("two orgs, two connections for the same client", async () => {
    const otherOrg = await seedOrganization(db, "other");
    await db.insert(members).values({
      id: "member-other",
      organizationId: otherOrg,
      userId: memberId,
      role: "member",
      createdAt: new Date(),
    });
    const acme = await connected(memberId);
    const other = await connect({
      clientId: acme.client.client_id,
      redirectUri: CODEX_REDIRECT,
      userId: memberId,
      choices: { organization_id: otherOrg },
    });
    await settle();
    // Connecting the client to the other organization leaves acme's working.
    expect((await mcp(acme.tokens.access_token, "tools/list")).status).toBe(
      200,
    );
    expect((await mcp(other.tokens.access_token, "tools/list")).status).toBe(
      200,
    );

    // Connecting it to acme again replaces acme's connection alone.
    const again = await connect({
      clientId: acme.client.client_id,
      redirectUri: CODEX_REDIRECT,
      userId: memberId,
    });
    await settle();
    expect((await mcp(acme.tokens.access_token, "tools/list")).status).toBe(
      401,
    );
    expect((await mcp(other.tokens.access_token, "tools/list")).status).toBe(
      200,
    );
    expect((await mcp(again.tokens.access_token, "tools/list")).status).toBe(
      200,
    );
    const rows = await db
      .select({
        organizationId: mcpConnections.organizationId,
        revokedReason: mcpConnections.revokedReason,
      })
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, memberId))
      .orderBy(mcpConnections.createdAt);
    expect(rows).toEqual([
      { organizationId: orgId, revokedReason: "superseded" },
      { organizationId: otherOrg, revokedReason: null },
      { organizationId: orgId, revokedReason: null },
    ]);
    const grants = await getMcpAuth(env)!
      .authorizationServer.getOAuthApi(env)
      .listUserGrants(memberId);
    expect(
      grants.items
        .map(
          (grant) =>
            (grant.metadata as { organizationId: string }).organizationId,
        )
        .sort(),
    ).toEqual([orgId, otherOrg].sort());
  });

  it("revokes only the removed organization's connections of a member of two", async () => {
    const otherOrg = await seedOrganization(db, "other");
    await db.insert(members).values({
      id: "member-other",
      organizationId: otherOrg,
      userId: memberId,
      role: "member",
      createdAt: new Date(),
    });
    const acme = await connected(memberId);
    const browser = new Browser(memberId);
    const other = await openConsent(
      browser,
      acme.client.client_id,
      CODEX_REDIRECT,
    );
    // The same client again, for the other organization: a connection of
    // its own, beside the first.
    await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(other.context, { organization_id: otherOrg }),
    );
    await settle();
    const client = await registerClient();
    const second = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
      userId: memberId,
    });

    await AdminService.deleteUser(
      { orgId, userId: ownerId, role: "owner" },
      memberId,
    );
    await settle();

    const rows = await db
      .select({
        organizationId: mcpConnections.organizationId,
        revokedReason: mcpConnections.revokedReason,
      })
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, memberId))
      .orderBy(mcpConnections.createdAt);
    expect(rows).toEqual([
      { organizationId: orgId, revokedReason: "member_removed" },
      { organizationId: otherOrg, revokedReason: null },
      { organizationId: orgId, revokedReason: "member_removed" },
    ]);
    expect((await mcp(second.tokens.access_token, "tools/list")).status).toBe(
      401,
    );
    // The other organization's grant is untouched.
    const grants = await getMcpAuth(env)!
      .authorizationServer.getOAuthApi(env)
      .listUserGrants(memberId);
    expect(
      grants.items.map(
        (grant) =>
          (grant.metadata as { organizationId: string }).organizationId,
      ),
    ).toEqual([otherOrg]);
  });

  it("revokes every connection of a user who is deactivated", async () => {
    const { tokens, connectionId } = await connected(memberId);
    await MembershipService.deactivate(
      { orgId, userId: ownerId, role: "owner" },
      memberId,
    );
    await settle();
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
    const [row] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId));
    expect(row?.revokedReason).toBe("user_deactivated");
    expect([...kv.store.keys()].some((key) => key.startsWith("grant:"))).toBe(
      false,
    );
  });

  it("stops a deactivated user", async () => {
    const { tokens } = await connected(memberId);
    await db.update(users).set({ banned: true }).where(eq(users.id, memberId));
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
  });

  it("tells a held subscriptions/listen stream when an app goes, and ends it when the connection is revoked", async () => {
    listenIntervalsForTests.pollMs = 20;
    listenIntervalsForTests.maxMs = 10_000;
    resetAppHostMcpForTests();
    try {
      const { tokens, connectionId } = await connected(memberId);
      const discover = (await (
        await mcp(tokens.access_token, "server/discover")
      ).json()) as { result: { capabilities: object } };
      expect(discover.result.capabilities).toEqual({
        tools: { listChanged: true },
      });

      const listen = await mcp(tokens.access_token, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      });
      expect(listen.status).toBe(200);
      expect(listen.headers.get("content-type")).toBe("text/event-stream");
      const reader = listen.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const next = async (method: string): Promise<void> => {
        while (!text.includes(method)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${method}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await next("notifications/subscriptions/acknowledged");
      // Polls without a change write keep-alives, nothing else.
      await next(": keepalive");
      expect(text).not.toContain("list_changed");

      await AppAccessService.updateAccessForApp(
        { orgId, userId: ownerId, role: "owner" },
        todoRowId,
        [ownerId],
      );
      await next("notifications/tools/list_changed");

      await McpConnectionService.revokeForUser(memberId, connectionId);
      await next('"resultType":"complete"');
      expect((await reader.read()).done).toBe(true);
    } finally {
      delete listenIntervalsForTests.pollMs;
      delete listenIntervalsForTests.maxMs;
      resetAppHostMcpForTests();
    }
  });

  it("drops an app whose access was taken away, or that was deleted", async () => {
    const { tokens } = await connected(memberId);
    expect(await toolNames(tokens.access_token)).toContain("todo_list_todos");

    await AppAccessService.updateAccessForApp(
      { orgId, userId: ownerId, role: "owner" },
      todoRowId,
      [ownerId],
    );
    expect(await toolNames(tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
    ]);
    const call = await callTool(tokens.access_token, "todo_list_todos");
    expect(call.body.error?.code).toBe(-32602);

    const owner = await connected(ownerId);
    await AppService.delete(
      { orgId, userId: ownerId, role: "owner" },
      todoRowId,
    );
    expect(await toolNames(owner.tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_add_note",
      "notes_list_notes",
    ]);
  });
});

describe("personal access tokens on the gateway's /mcp", () => {
  it("ends a held subscriptions/listen stream once the token is revoked", async () => {
    listenIntervalsForTests.pollMs = 20;
    listenIntervalsForTests.maxMs = 10_000;
    resetAppHostMcpForTests();
    try {
      const token = await pat();
      const listen = await mcp(token, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      });
      expect(listen.headers.get("content-type")).toBe("text/event-stream");
      const reader = listen.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const next = async (marker: string): Promise<void> => {
        while (!text.includes(marker)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${marker}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await next("notifications/subscriptions/acknowledged");
      await next(": keepalive");

      const [row] = (
        await UserPatService.listForUser(ownerId, orgId)
      ).tokens.filter((candidate) => candidate.name === "claude code");
      await UserPatService.revoke(row!.id, ownerId);
      await next('"resultType":"complete"');
      expect((await reader.read()).done).toBe(true);
    } finally {
      delete listenIntervalsForTests.pollMs;
      delete listenIntervalsForTests.maxMs;
      resetAppHostMcpForTests();
    }
  });

  async function pat(
    scopes?: string[],
    appRowId: string | null = null,
  ): Promise<string> {
    const { plaintext } = await UserPatService.create({
      userId: ownerId,
      organizationId: orgId,
      name: "claude code",
      scopes,
      appRowId,
    });
    return plaintext;
  }

  it("serves every app a full token reaches, and audits it as the token", async () => {
    const token = await pat();
    expect(await toolNames(token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_add_note",
      "notes_list_notes",
      "todo_create_todo",
      "todo_list_todos",
    ]);
    await callTool(token, "notes_add_note");
    const [audit] = await db.select().from(mcpToolCalls);
    expect(audit).toMatchObject({
      credentialKind: "pat",
      surface: "gateway",
      toolName: "notes_add_note",
      outcome: "ok",
    });
  });

  it("reads only with mcp:read, sees only its app, and refuses non-MCP tokens", async () => {
    expect(await toolNames(await pat(["mcp:read"]))).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_list_notes",
      "todo_list_todos",
    ]);
    expect(await toolNames(await pat(undefined, notesRowId))).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "notes_add_note",
      "notes_list_notes",
    ]);
    const refused = await mcp(await pat(["api:read"]), "tools/list");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "forbidden",
      reason: "token_scope",
    });
  });
});

describe("the consent page's tool states", () => {
  it("fetches the snapshots it is missing while the page loads", async () => {
    // As for apps deployed before the gateway took snapshots.
    await db.delete(appTools);
    await db.delete(appToolCatalogs);
    const client = await registerClient();

    const { context } = await openConsent(
      new Browser(ownerId),
      client.client_id,
      CODEX_REDIRECT,
    );
    expect(toolStates(context)).toEqual({ notes: "ready", todo: "ready" });
    const rows = await db.select().from(appToolCatalogs);
    expect(rows.map((row) => row.status)).toEqual(["ok", "ok"]);
    expect(listCalls(todoBinding)).toBe(1);
    expect(listCalls(notesBinding)).toBe(1);
  });

  it("greys out an app that reported no tools, and doesn't ask it again", async () => {
    const blank = await deployAnotherApp("blank", blankApp(keys.publicKeyPem));
    const legacy = await deployAnotherApp(
      "legacy",
      pingApp("legacy", keys.publicKeyPem),
      { legacy: true },
    );
    const client = await registerClient();
    const browser = new Browser(ownerId);

    const first = await openConsent(browser, client.client_id, CODEX_REDIRECT);
    expect(toolStates(first.context)).toEqual({
      blank: "none",
      legacy: "none",
      notes: "ready",
      todo: "ready",
    });
    expect((await catalogRow(blank.rowId))?.status).toBe("empty");
    expect((await catalogRow(legacy.rowId))?.status).toBe("unsupported");

    // Another page load, past this isolate's claim window.
    clearCatalogSyncClaimsForTests();
    const second = await openConsent(browser, client.client_id, CODEX_REDIRECT);
    expect(toolStates(second.context)).toEqual(toolStates(first.context));
    expect(listCalls(blank.binding)).toBe(1);
    expect(listCalls(legacy.binding)).toBe(1);
  });

  it(
    "gives a slow app a few seconds, shows it as unknown, and finishes after the page",
    { timeout: 15_000 },
    async () => {
      const hold = gate();
      const slow = await deployAnotherApp(
        "slow",
        pingApp("slow", keys.publicKeyPem),
        { heldUntil: hold.opened },
      );
      const client = await registerClient();

      const started = Date.now();
      const { context } = await openConsent(
        new Browser(ownerId),
        client.client_id,
        CODEX_REDIRECT,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
      expect(toolStates(context)).toEqual({
        notes: "ready",
        slow: "unknown",
        todo: "ready",
      });
      expect(await catalogRow(slow.rowId)).toBeUndefined();

      hold.release();
      await settle();
      expect(await catalogRow(slow.rowId)).toMatchObject({
        status: "ok",
        toolCount: 1,
      });
      expect(listCalls(slow.binding)).toBe(1);
    },
  );

  it("lets a failing app be chosen, and doesn't ask it again for five minutes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = await deployAnotherApp(
      "broken",
      pingApp("broken", keys.publicKeyPem),
      { failing: true },
    );
    const client = await registerClient();
    const browser = new Browser(ownerId);

    const { context } = await openConsent(
      browser,
      client.client_id,
      CODEX_REDIRECT,
    );
    expect(toolStates(context)["broken"]).toBe("unknown");
    expect(await catalogRow(broken.rowId)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("500"),
    });
    const decision = await browser.postForm(
      "/oauth/consent/decision",
      approvalForm(context, { app_mode: "selected", app_ids: [broken.rowId] }),
    );
    expect(decision.status).toBe(302);

    clearCatalogSyncClaimsForTests();
    await openConsent(new Browser(ownerId), client.client_id, CODEX_REDIRECT);
    expect(listCalls(broken.binding)).toBe(1);
  });
});

describe("apps with no tool snapshot yet", () => {
  it("lists an app it never fetched on a new connection's very first tools/list", async () => {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    // Deployed after the connection was made, and never used since.
    const chef = await deployAnotherApp(
      "chef",
      pingApp("chef", keys.publicKeyPem),
    );

    expect(await toolNames(tokens.access_token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "chef_ping",
      "notes_add_note",
      "notes_list_notes",
      "todo_create_todo",
      "todo_list_todos",
    ]);
    expect(listCalls(chef.binding)).toBe(1);
  });

  it(
    "answers without a slow app's tools after the budget, then lists them",
    { timeout: 15_000 },
    async () => {
      const client = await registerClient();
      const { tokens } = await connect({
        clientId: client.client_id,
        redirectUri: CODEX_REDIRECT,
      });
      const hold = gate();
      const slow = await deployAnotherApp(
        "slow",
        pingApp("slow", keys.publicKeyPem),
        { heldUntil: hold.opened },
      );

      const started = Date.now();
      const names = await listedNames(
        await mcp(tokens.access_token, "tools/list"),
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
      expect(names).not.toContain("slow_ping");
      expect(listCalls(slow.binding)).toBe(1);

      hold.release();
      await settle();
      expect(await toolNames(tokens.access_token)).toContain("slow_ping");
      expect(listCalls(slow.binding)).toBe(1);
    },
  );

  it("doesn't wait for an app whose last sync failed, and retries it after the answer", async () => {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    const hold = gate();
    const flaky = await deployAnotherApp(
      "flaky",
      pingApp("flaky", keys.publicKeyPem),
      { heldUntil: hold.opened },
    );
    // Its last sync failed, over five minutes ago.
    await AppToolRepository.recordError({
      appRowId: flaky.rowId,
      organizationId: orgId,
      versionId: "flaky-version",
      message: "the app answered 500",
    });
    await db
      .update(appToolCatalogs)
      .set({ fetchedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(appToolCatalogs.appRowId, flaky.rowId));

    const started = Date.now();
    const names = await listedNames(
      await mcp(tokens.access_token, "tools/list"),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(names).not.toContain("flaky_ping");
    // The retry reaches the app after the answer.
    await vi.waitFor(() => expect(listCalls(flaky.binding)).toBe(1));

    hold.release();
    await settle();
    expect(await toolNames(tokens.access_token)).toContain("flaky_ping");
    expect(listCalls(flaky.binding)).toBe(1);
  });

  it("keeps serving a snapshot whose newer version can't be fetched, and retries after the answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    const listTodoTools = async () => {
      const started = Date.now();
      const names = await listedNames(
        await mcp(tokens.access_token, "tools/list"),
      );
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(names).toContain("todo_create_todo");
    };

    // Redeployed with a catalog that breaks: tried once within the request,
    // and the old snapshot keeps serving, marked with the failure.
    bindApp(todoBinding, todoApp(keys.publicKeyPem), { failing: true });
    await db
      .update(apps)
      .set({ versionId: "todo-version-2" })
      .where(eq(apps.id, todoRowId));
    await listTodoTools();
    await settle();
    expect(listCalls(todoBinding)).toBe(1);
    expect(await catalogRow(todoRowId)).toMatchObject({
      status: "ok",
      versionId: "todo-version",
      lastError: expect.stringContaining("500"),
    });

    // From then on the new version is tried after the answer: neither the
    // consent page nor /mcp waits for it, even when it hangs.
    const hold = gate();
    bindApp(todoBinding, todoApp(keys.publicKeyPem), {
      heldUntil: hold.opened,
    });
    clearCatalogSyncClaimsForTests();
    const started = Date.now();
    const { context } = await openConsent(
      new Browser(ownerId),
      client.client_id,
      CODEX_REDIRECT,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(toolStates(context)["todo"]).toBe("ready");
    await vi.waitFor(() => expect(listCalls(todoBinding)).toBe(1));

    clearCatalogSyncClaimsForTests();
    await listTodoTools();
    await vi.waitFor(() => expect(listCalls(todoBinding)).toBe(2));

    hold.release();
    await settle();
    expect(await catalogRow(todoRowId)).toMatchObject({
      status: "ok",
      versionId: "todo-version-2",
      lastError: null,
    });
  });

  it("re-syncs an app within the request once it runs a newer version", async () => {
    await db
      .update(apps)
      .set({ versionId: "todo-version-2" })
      .where(eq(apps.id, todoRowId));
    const { plaintext: token } = await UserPatService.create({
      userId: ownerId,
      organizationId: orgId,
      name: "claude code",
    });

    expect(await toolNames(token)).toContain("todo_create_todo");
    expect((await catalogRow(todoRowId))?.versionId).toBe("todo-version-2");
    expect(listCalls(todoBinding)).toBe(1);
  });
});

describe("snapshots taken at deploy time", () => {
  it("snapshots an app when its first request activates it", async () => {
    const manifest = { id: "chef", name: "Chef" };
    const { app } = await registerApp(db, {
      organizationId: orgId,
      deployerUserId: ownerId,
      appBaseDomain: HOST,
      isInstallOrganization: false,
      appSlug: "chef",
      name: "Chef",
      description: "Chef",
      manifest,
    });
    await markAppDeployed(db, app.id, { versionId: "chef-version", manifest });
    const binding = `APP__${app.workerName}`;
    bindApp(binding, pingApp("chef", keys.publicKeyPem));

    // The CLI's live wait: the first request over the new binding.
    await openAppHost(app.hostname!);
    const [row] = await db.select().from(apps).where(eq(apps.id, app.id));
    expect(row?.status).toBe("active");
    await settle();
    expect(await catalogRow(app.id)).toMatchObject({
      status: "ok",
      versionId: "chef-version",
      toolCount: 1,
    });
    expect(await storedToolNames(app.id)).toEqual(["ping"]);
    expect(listCalls(binding)).toBe(1);
  });

  it("follows a self-host redeploy from the app host's next request, once", async () => {
    // `everyapp deploy` again: new code behind the binding, the new version
    // in the row, and the gateway told nothing.
    bindApp(todoBinding, todoApp(keys.publicKeyPem, true));
    await db
      .update(apps)
      .set({ versionId: "todo-version-2" })
      .where(eq(apps.id, todoRowId));
    clearHostnameCacheForTests();

    await openAppHost(todoHost);
    await settle();
    expect(await catalogRow(todoRowId)).toMatchObject({
      status: "ok",
      versionId: "todo-version-2",
      toolCount: 4,
    });
    expect(await storedToolNames(todoRowId)).toContain("archive_todos");
    expect(listCalls(todoBinding)).toBe(1);

    await openAppHost(todoHost);
    await settle();
    expect(listCalls(todoBinding)).toBe(1);
  });
});

describe("a deleted app", () => {
  it("leaves the connections that chose it, so a later deploy can't rejoin them", async () => {
    await McpConnectionRepository.create({
      id: "mcpc_chosen",
      userId: ownerId,
      organizationId: orgId,
      clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      clientName: "Claude",
      clientDomain: "claude.ai",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      redirectHost: "claude.ai",
      appScope: "selected",
      appRowIds: [todoRowId, notesRowId],
      access: "write",
      createdAt: new Date(),
    });

    await AppService.delete(
      { orgId, userId: ownerId, role: "owner" },
      todoRowId,
    );

    expect(
      await db
        .select({ appRowId: mcpConnectionApps.appRowId })
        .from(mcpConnectionApps)
        .where(eq(mcpConnectionApps.connectionId, "mcpc_chosen")),
    ).toEqual([{ appRowId: notesRowId }]);
  });
});

describe("browser callers", () => {
  it("serves only the gateway's origin and MCP_ALLOWED_ORIGINS", async () => {
    hoisted.env["MCP_ALLOWED_ORIGINS"] = "http://localhost:6274, not-a-url";
    const { plaintext } = await UserPatService.create({
      userId: ownerId,
      organizationId: orgId,
      name: "inspector",
    });

    const preflight = await send("/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:6274",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:6274",
    );

    const inspector = await mcp(
      plaintext,
      "tools/list",
      {},
      {
        origin: "http://localhost:6274",
      },
    );
    expect(inspector.status).toBe(200);
    expect(inspector.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:6274",
    );
    expect(
      (await mcp(plaintext, "tools/list", {}, { origin: GATEWAY })).status,
    ).toBe(200);
    for (const origin of ["https://evil.example", "http://localhost:6275"]) {
      const refused = await mcp(plaintext, "tools/list", {}, { origin });
      expect(refused.status, origin).toBe(403);
    }
  });
});

describe("with MCP_OAUTH_ENABLED off", () => {
  it("takes personal tokens only and names no authorization server", async () => {
    const client = await registerClient();
    const { tokens } = await connect({
      clientId: client.client_id,
      redirectUri: CODEX_REDIRECT,
    });
    hoisted.env["MCP_OAUTH_ENABLED"] = "false";

    const oauth = await mcp(tokens.access_token, "tools/list");
    expect(oauth.status).toBe(401);
    expect(oauth.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app", error="invalid_token"',
    );
    const { plaintext } = await UserPatService.create({
      userId: ownerId,
      organizationId: orgId,
      name: "cli",
    });
    expect(await toolNames(plaintext)).toContain("todo_create_todo");
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
      "/oauth/register",
    ]) {
      expect((await send(path)).status).toBe(404);
    }
  });
});

describe("housekeeping", () => {
  it("prunes old tool calls, expires idle connections, and sweeps OAuth storage from a cursor", async () => {
    const client = await registerClient();
    await connect({ clientId: client.client_id, redirectUri: CODEX_REDIRECT });
    await db.insert(mcpToolCalls).values([
      {
        id: "old",
        createdAt: new Date(Date.now() - 91 * 86_400_000),
        organizationId: orgId,
        userId: ownerId,
        credentialKind: "pat",
        credentialId: "pat_1",
        surface: "gateway",
        toolName: "todo_list_todos",
        decision: "allowed",
        outcome: "ok",
      },
      {
        id: "recent",
        createdAt: new Date(Date.now() - 89 * 86_400_000),
        organizationId: orgId,
        userId: ownerId,
        credentialKind: "pat",
        credentialId: "pat_1",
        surface: "gateway",
        toolName: "todo_list_todos",
        decision: "allowed",
        outcome: "ok",
      },
    ]);

    const purge = vi.spyOn(
      getMcpAuth(env)!.authorizationServer,
      "purgeExpiredData",
    );
    purge.mockResolvedValueOnce({
      grantsChecked: 50,
      grantsPurged: 3,
      tokensChecked: 0,
      tokensPurged: 0,
      done: false,
      cursor: "next-page",
    });
    await runMcpMaintenance(env);
    expect(
      (await db.select({ id: mcpToolCalls.id }).from(mcpToolCalls)).map(
        (row) => row.id,
      ),
    ).toEqual(["recent"]);
    expect(purge).toHaveBeenLastCalledWith(env, {
      batchSize: 50,
      cursor: undefined,
    });
    expect(await kv.kv.get("purge-cursor", "json")).toEqual({
      cursor: "next-page",
      failures: 0,
    });

    // A month later the connection, unused, has lapsed; the sweep resumes
    // and finishes.
    purge.mockResolvedValueOnce({
      grantsChecked: 40,
      grantsPurged: 0,
      tokensChecked: 10,
      tokensPurged: 1,
      done: true,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 32 * 86_400_000);
    await runMcpMaintenance(env);
    expect(purge).toHaveBeenLastCalledWith(env, {
      batchSize: 50,
      cursor: "next-page",
    });
    expect(await kv.kv.get("purge-cursor")).toBeNull();
    const [connection] = await db.select().from(mcpConnections);
    expect(connection?.revokedReason).toBe("expired");
  });

  it("starts a new sweep when a saved cursor is refused", async () => {
    await kv.kv.put(
      "purge-cursor",
      JSON.stringify({ cursor: "from-an-older-version", failures: 0 }),
    );
    await runMcpMaintenance(env);
    expect(await kv.kv.get("purge-cursor")).toBeNull();
    await runMcpMaintenance(env);
    expect(await kv.kv.get("purge-cursor")).toBeNull();
  });

  it("resumes from its cursor after another failure, three times at most", async () => {
    const saved = { cursor: "grants:page-2", failures: 0 };
    await kv.kv.put("purge-cursor", JSON.stringify(saved));
    const purge = vi
      .spyOn(getMcpAuth(env)!.authorizationServer, "purgeExpiredData")
      .mockRejectedValue(new Error("KV GET failed: 503"));
    await runMcpMaintenance(env);
    expect(await kv.kv.get("purge-cursor", "json")).toEqual({
      ...saved,
      failures: 1,
    });
    await runMcpMaintenance(env);
    expect(purge).toHaveBeenLastCalledWith(env, {
      batchSize: 50,
      cursor: "grants:page-2",
    });
    await runMcpMaintenance(env);
    expect(await kv.kv.get("purge-cursor")).toBeNull();
  });

  it("says so when a run leaves rows past the retention", async () => {
    vi.spyOn(
      McpToolCallRepository,
      "deleteRecordedBefore",
    ).mockResolvedValueOnce({ deleted: 20_000, done: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runMcpMaintenance(env);
    const line = warn.mock.calls
      .map(
        ([message]) => JSON.parse(String(message)) as Record<string, unknown>,
      )
      .find((entry) => entry["evt"] === "mcp.maintenance");
    expect(line).toMatchObject({ audit_deleted: 20_000, audit_behind: true });
  });

  it("deletes rate limit counters whose window ended", async () => {
    await db.insert(rateLimitCounters).values([
      {
        key: "oauth-register:gateway:2026-10-12",
        count: 7,
        expiresAt: new Date(Date.now() - 1000),
      },
      {
        key: "oauth-register:gateway:2026-10-13",
        count: 3,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runMcpMaintenance(env);
    expect(
      (await db.select().from(rateLimitCounters)).map((row) => row.key),
    ).toEqual(["oauth-register:gateway:2026-10-13"]);
    const line = log.mock.calls
      .map(
        ([message]) => JSON.parse(String(message)) as Record<string, unknown>,
      )
      .find((entry) => entry["evt"] === "mcp.maintenance");
    expect(line).toMatchObject({ rate_limit_counters_deleted: 1 });
  });

  it("keeps a configured number of days", async () => {
    hoisted.env["MCP_AUDIT_RETENTION_DAYS"] = "7";
    await db.insert(mcpToolCalls).values({
      id: "eight-days",
      createdAt: new Date(Date.now() - 8 * 86_400_000),
      organizationId: orgId,
      userId: ownerId,
      credentialKind: "pat",
      credentialId: "pat_1",
      surface: "app",
      toolName: "list_todos",
      decision: "allowed",
      outcome: "ok",
    });
    await runMcpMaintenance(env);
    expect(await db.select().from(mcpToolCalls)).toEqual([]);
  });
});
