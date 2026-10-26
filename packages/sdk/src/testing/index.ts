/**
 * @every-app/sdk/testing — an app's tests, without a Gateway: a signed-in
 * person for a request, and the tools called the way the Gateway calls them.
 *
 *   import { callTool, testContext, testEnv, testRequest } from "@every-app/sdk/testing";
 *
 *   const worker = everyApp(handler, { tools });
 *   const response = await worker.fetch(
 *     await testRequest("https://todo.test/api/todos", { user: { id: "ana" } }),
 *     testEnv(),
 *     testContext(),
 *   );
 *   const result = await callTool(worker, "list_todos", {}, { user: { id: "ana" } });
 *
 * Identities are signed with the well-known dev keypair, which `everyApp()`
 * trusts only with `EVERYAPP_DEV` set, as {@link testEnv} sets it: never in a
 * deployed Worker. For tests only; a Worker never imports this module.
 */
import {
  DEV_ISSUER,
  DEV_PRIVATE_KEY_PEM,
  DEV_PUBLIC_KEY_PEM,
} from "../dev/keypair.js";
import {
  APP_ID_ENV,
  AUDIENCE_ENV,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  MCP_DESTRUCTIVE_SCOPE,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  SYSTEM_HEADER,
  TOOLS_CALL_PATH,
  TOOLS_LIST_PATH,
  mintIdentityJwt,
  mintSystemJwt,
  type IdentityChannel,
  type ToolCallResultV1,
  type ToolsCallResponseV1,
  type ToolsListResponseV1,
} from "../internal/index.js";
import { everyApp } from "../server/everyApp.js";
import type { ToolSet } from "../server/tools.js";

export { IDENTITY_HEADER };
export type {
  ToolCallResultV1 as ToolCallResult,
  ToolsCallResponseV1 as ToolCallResponse,
  ToolsListResponseV1 as ToolsListResponse,
};

/** The person a test signs in; each field left out takes {@link TEST_USER}'s. */
export interface TestUser {
  id?: string;
  email?: string;
  orgId?: string;
  /** `owner`, `admin` or `member`, as the Gateway signs it. */
  orgRole?: string;
}

/** The person a test signs in by default: the owner of `org_test`. */
export const TEST_USER: Readonly<Required<TestUser>> = Object.freeze({
  id: "user_test",
  email: "test@example.com",
  orgId: "org_test",
  orgRole: "owner",
});

/** The app id {@link testEnv} uses when none is given. */
export const TEST_APP_ID = "test-app";

/** What an identity is minted for, beside the person. */
export interface TestIdentityOptions {
  user?: TestUser;
  /** The app the identity is for (the token's audience). Default: {@link TEST_APP_ID}. */
  appId?: string;
  /** Default `["*"]`: a browser session, which holds every scope. */
  scopes?: string[];
  /** Default `"web"`. */
  channel?: IdentityChannel;
}

/**
 * The Worker env `everyApp()` needs to trust test identities: the app id,
 * the dev issuer and key, `EVERYAPP_DEV`, and a `GATEWAY_URL`. `overrides`
 * adds the app's own bindings (a fake `DB`, a secret) or replaces any of
 * these.
 */
export function testEnv<T extends object = Record<never, never>>(
  overrides: { appId?: string } & T = {} as { appId?: string } & T,
): {
  EVERYAPP_APP_ID: string;
  EVERYAPP_DEV: string;
  EVERYAPP_IDENTITY_ISSUER: string;
  EVERYAPP_IDENTITY_PUBLIC_KEYS: string;
  GATEWAY_URL: string;
} & Omit<T, "appId"> {
  const { appId = TEST_APP_ID, ...rest } = overrides;
  return {
    EVERYAPP_APP_ID: appId,
    EVERYAPP_DEV: "1",
    EVERYAPP_IDENTITY_ISSUER: DEV_ISSUER,
    EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
    GATEWAY_URL: "https://gateway.test",
    ...(rest as Omit<T, "appId">),
  };
}

/**
 * An `ExecutionContext` for calling a Worker's `fetch` in a test:
 * `waitUntil` keeps each promise in `waited`, so a test can await them.
 */
export function testContext(): ExecutionContext & {
  waited: Promise<unknown>[];
} {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    waitUntil: (promise: Promise<unknown>) => void waited.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext & { waited: Promise<unknown>[] };
}

/** An identity token for `user`, as the Gateway sends in the identity header. */
export async function mintTestIdentity(
  options: TestIdentityOptions & {
    toolCall?: { id: string; name: string };
  } = {},
): Promise<string> {
  const user = { ...TEST_USER, ...options.user };
  return mintIdentityJwt(DEV_PRIVATE_KEY_PEM, {
    subject: {
      sub: user.id,
      email: user.email,
      orgId: user.orgId,
      orgRole: user.orgRole,
    },
    audience: options.appId ?? TEST_APP_ID,
    issuer: DEV_ISSUER,
    keyId: IDENTITY_DEV_KEY_ID,
    channel: options.channel,
    scopes: options.scopes,
    toolCall: options.toolCall,
  });
}

/**
 * A request as the Gateway forwards it: `user` signed in (the default
 * person when left out), or nobody with `user: null`, as on a public route.
 */
export async function testRequest(
  input: string | URL,
  init: RequestInit &
    Omit<TestIdentityOptions, "user"> & { user?: TestUser | null } = {},
): Promise<Request> {
  const { user, appId, scopes, channel, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  if (user !== null) {
    headers.set(
      IDENTITY_HEADER,
      await mintTestIdentity({ user, appId, scopes, channel }),
    );
  }
  return new Request(input, { ...requestInit, headers });
}

/** A Worker as `everyApp()` returns it. */
export interface TestWorker {
  fetch(
    request: Request,
    env: never,
    ctx: ExecutionContext,
  ): Response | Promise<Response>;
}

export interface CallToolOptions {
  user?: TestUser;
  /**
   * The caller's scopes. Default: `mcp:read`, `mcp:write` and
   * `mcp:destructive`, so every tool may be called; pass fewer to test a
   * refusal.
   */
  scopes?: string[];
  /** Default: {@link testEnv}() for the worker's app. */
  env?: object;
  ctx?: ExecutionContext;
}

/**
 * Call one tool as the Gateway does for an AI client: a `chan: "mcp"`
 * identity minted for this call, through the app's tools endpoint, so the
 * SDK checks the scope, validates input and output and maps errors as it
 * does deployed. `app` is the Worker `everyApp()` returned, or the
 * `defineTools()` set alone. The answer is `{ result }`, or `{ error }`
 * when the SDK refused the call.
 */
export async function callTool(
  app: TestWorker | ToolSet,
  name: string,
  args: Record<string, unknown> = {},
  options: CallToolOptions = {},
): Promise<ToolsCallResponseV1> {
  const env = options.env ?? testEnv();
  const callId = crypto.randomUUID();
  const identity = await mintTestIdentity({
    user: options.user,
    appId: audienceOf(env),
    channel: "mcp",
    scopes: options.scopes ?? [
      MCP_READ_SCOPE,
      MCP_WRITE_SCOPE,
      MCP_DESTRUCTIVE_SCOPE,
    ],
    toolCall: { id: callId, name },
  });
  const response = await workerOf(app).fetch(
    new Request(`https://app.test${TOOLS_CALL_PATH}`, {
      method: "POST",
      headers: { [IDENTITY_HEADER]: identity },
      body: JSON.stringify({ v: 1, name, arguments: args, callId }),
    }),
    env as never,
    options.ctx ?? testContext(),
  );
  return (await response.json()) as ToolsCallResponseV1;
}

/** The tool catalog, read as the Gateway reads it when the app deploys. */
export async function listTools(
  app: TestWorker | ToolSet,
  options: { env?: object; ctx?: ExecutionContext } = {},
): Promise<ToolsListResponseV1> {
  const env = options.env ?? testEnv();
  const token = await mintSystemJwt(DEV_PRIVATE_KEY_PEM, {
    audience: audienceOf(env),
    issuer: DEV_ISSUER,
    purpose: "tools.list",
    keyId: IDENTITY_DEV_KEY_ID,
  });
  const response = await workerOf(app).fetch(
    new Request(`https://app.test${TOOLS_LIST_PATH}`, {
      method: "POST",
      headers: { [SYSTEM_HEADER]: token },
      body: JSON.stringify({ v: 1 }),
    }),
    env as never,
    options.ctx ?? testContext(),
  );
  if (!response.ok) {
    throw new Error(
      `the tools list answered ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as ToolsListResponseV1;
}

/** Who the app's identities are minted for: the deployed audience, else the app id. */
function audienceOf(env: object): string {
  const values = env as Record<string, unknown>;
  for (const key of [AUDIENCE_ENV, APP_ID_ENV]) {
    const value = values[key];
    if (typeof value === "string" && value) return value;
  }
  return TEST_APP_ID;
}

function workerOf(app: TestWorker | ToolSet): TestWorker {
  if ("fetch" in app) return app;
  return everyApp(() => new Response("Not found", { status: 404 }), {
    tools: app,
  }) as TestWorker;
}
