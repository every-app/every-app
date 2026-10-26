/**
 * `everyApp()` — the app-side identity boundary.
 *
 *   export default everyApp(handler, { tools });
 *
 * The wrapper verifies the gateway-injected identity before app code runs,
 * stores the result on the original Request, and then delegates to the
 * worker-style handler. The expected audience is the Worker's own name in
 * `env.EVERYAPP_AUDIENCE`, which `everyAppWorker()` sets at deploy (the
 * gateway stamps every token it mints for the app with it); only in
 * development, where `everyapp dev` mints for the app id, does the app id in
 * `env.EVERYAPP_APP_ID` stand in. The Worker never imports
 * `everyapp.config.ts` (the Cloudflare Vite plugin hides every file
 * `cloudflare.config.ts` imports from the Worker in dev).
 * It also answers the gateway's internal tools contract
 * (`/__everyapp/tools/*`) for the app's `defineTools()` catalog.
 *
 * Around the handler and around each tool call it opens the request
 * context (context.ts): `currentUser()` reads the user anywhere below, and
 * every call back to the Gateway is attributed to the request without a
 * `for`. A deployed Worker is pinned to its organization
 * (`EVERY_APP_ORG_ID`), and an identity for any other is refused on both
 * paths. The response leaves without `Set-Cookie`: the perimeter strips
 * every `Cookie` before a request reaches the app, so a cookie the app's
 * framework sets could never come back, and one named like the Gateway's
 * session cookie would lock the person out of the app host.
 */
import {
  APP_ID_ENV,
  AUDIENCE_ENV,
  ConfigurationError,
  DEV_ENV,
  IdentityError,
  IDENTITY_HEADER,
  ISSUER_ENV,
  ORG_ID_ENV,
  PUBLIC_KEYS_ENV,
  getIdentityFromRequest,
  isAdmin,
  type EveryAppUser,
  type IdentityResult,
  type OrgRole,
  type RequestIdentityOptions,
} from "../internal/index.js";
import { currentUser, serveRequest } from "./context.js";
import type { ToolSet } from "./tools.js";
import { handleToolsRequest } from "./toolsEndpoint.js";

export { ConfigurationError, IdentityError, isAdmin };
export type { EveryAppUser, IdentityResult, OrgRole };

/**
 * The runtime's `ExecutionContext`, which `everyApp()` passes to the handler
 * as the Worker received it, so it goes on to Hono's `app.fetch(request,
 * env, ctx)` or React Router's request handler as is. Tests that call
 * `fetch` themselves pass a stub cast to it.
 */
export type ExecutionContextLike = ExecutionContext;

export interface EveryAppManifestLike {
  id: string;
  [key: string]: unknown;
}

export interface EveryAppOptions {
  /** Optional expected issuer (gateway URL). Defaults to env.EVERYAPP_IDENTITY_ISSUER when set. */
  issuer?: string;
  /** Env var holding the public key set. Defaults to EVERYAPP_IDENTITY_PUBLIC_KEYS. */
  keysEnvVar?: string;
  /** Provide keys directly (tests / non-standard delivery). */
  publicKeys?: string[];
  /**
   * Accept dev identity tokens. Defaults to reading EVERYAPP_DEV from env.
   * Never enable this in production.
   */
  allowDevIdentities?: boolean;
  /**
   * Agent tools from `defineTools()`. The gateway snapshots them at deploy
   * and serves them to MCP clients; see `defineTools`.
   */
  tools?: ToolSet;
  /** Override for tests. */
  now?: number;
}

/**
 * The handler accepted by everyApp, with the verified user as a 4th argument.
 * `TCtx` narrows the context, e.g. to `ExecutionContext<Props>`.
 */
export type EveryAppHandler<
  TEnv = Record<string, unknown>,
  TCtx extends ExecutionContextLike = ExecutionContext,
> = (
  request: Request,
  env: TEnv,
  ctx: TCtx,
  user: EveryAppUser | null,
) => Response | Promise<Response>;

interface EveryAppExport<TEnv, TCtx extends ExecutionContextLike> {
  fetch(request: Request, env: TEnv, ctx: TCtx): Promise<Response>;
}

interface VerificationConfig {
  /** Expected audience when it can't come from env (legacy manifest argument). */
  manifestAppId?: string;
  issuer?: string;
  keysEnvVar: string;
  publicKeys?: string[];
  allowDevIdentities?: boolean;
  now?: number;
}

const requestIdentities = new WeakMap<Request | Headers, IdentityResult>();

function envValue(env: unknown, key: string): string | undefined {
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function configFrom(
  manifest: EveryAppManifestLike | undefined,
  options: EveryAppOptions = {},
): VerificationConfig {
  return {
    manifestAppId: manifest?.id,
    issuer: options.issuer,
    keysEnvVar: options.keysEnvVar ?? PUBLIC_KEYS_ENV,
    publicKeys: options.publicKeys,
    allowDevIdentities: options.allowDevIdentities,
    now: options.now,
  };
}

/**
 * The app id: EVERYAPP_APP_ID, or a manifest passed to everyApp() for
 * Workers without it; the two must agree when both are present.
 */
function appIdFor(
  env: unknown,
  config: VerificationConfig,
): string | undefined {
  const fromEnv = envValue(env, APP_ID_ENV);
  if (fromEnv && config.manifestAppId && fromEnv !== config.manifestAppId) {
    throw new ConfigurationError(
      `${APP_ID_ENV} ("${fromEnv}") does not match the manifest id ("${config.manifestAppId}").`,
    );
  }
  return fromEnv ?? config.manifestAppId;
}

function devIdentitiesAllowed(env: unknown, config: VerificationConfig) {
  const devEnv = envValue(env, DEV_ENV);
  return (
    config.allowDevIdentities ??
    (devEnv !== undefined &&
      (devEnv === "1" || devEnv.toLowerCase() === "true"))
  );
}

/**
 * The audience identity tokens must carry: this Worker's name, from
 * EVERYAPP_AUDIENCE. The gateway mints for the Worker, not the app id, so a
 * token for one organization's copy of an app never opens another's. Only
 * under the dev opt-in, where `everyapp dev` mints for the app id, does the
 * app id stand in when EVERYAPP_AUDIENCE is unset.
 */
function audienceFor(env: unknown, config: VerificationConfig): string {
  const appId = appIdFor(env, config);
  const audience = envValue(env, AUDIENCE_ENV);
  if (audience) return audience;
  if (appId && devIdentitiesAllowed(env, config)) return appId;
  throw new ConfigurationError(
    `${AUDIENCE_ENV} is not set — the app's cloudflare.config.ts must declare it (everyAppWorker() does at deploy).`,
  );
}

/**
 * The organization a deployed Worker serves ({@link ORG_ID_ENV}), which an
 * identity must name. Under the dev opt-in there is none to enforce: the
 * stub gateway's one organization is the only one, and `everyapp dev
 * --mode mirror` signs real organizations in.
 */
function pinnedOrganization(
  env: unknown,
  config: VerificationConfig,
): string | undefined {
  if (devIdentitiesAllowed(env, config)) return undefined;
  return envValue(env, ORG_ID_ENV);
}

function unauthorized(message: string): Response {
  return Response.json({ error: "unauthenticated", message }, { status: 401 });
}

function misconfigured(message: string): Response {
  return Response.json({ error: "misconfigured", message }, { status: 500 });
}

function identityOptions(
  env: unknown,
  config: VerificationConfig,
  audience: string,
): RequestIdentityOptions {
  return {
    audience,
    organizationId: pinnedOrganization(env, config),
    issuer: config.issuer ?? envValue(env, ISSUER_ENV),
    publicKeys: config.publicKeys,
    env: env as Record<string, unknown> | undefined,
    keysEnvVar: config.keysEnvVar,
    allowDevIdentities: devIdentitiesAllowed(env, config),
    now: config.now,
  };
}

async function resolveIdentity(
  request: Request | Headers,
  env: unknown,
  config: VerificationConfig,
): Promise<IdentityResult> {
  return getIdentityFromRequest(
    request,
    identityOptions(env, config, audienceFor(env, config)),
  );
}

function rememberIdentity(
  request: Request | Headers,
  identity: IdentityResult,
): void {
  requestIdentities.set(request, identity);
}

/**
 * The user the request context already verified, when `request` carries
 * the same identity token: a framework that rebuilds the request (TanStack
 * Start's `getRequest()`, a Hono context) still gets the one verification.
 */
function contextUserFor(request: Request | Headers): EveryAppUser | null {
  const headers = "headers" in request ? request.headers : request;
  const token = headers.get(IDENTITY_HEADER);
  if (!token) return null;
  const scoped = servedRequestToken();
  return scoped && scoped.token === token ? scoped.user : null;
}

/**
 * The served request's token and user, or null outside a request. Reads
 * the context without throwing (currentUser() throws outside one).
 */
function servedRequestToken(): { token: string; user: EveryAppUser } | null {
  let user: EveryAppUser | null;
  try {
    user = currentUser();
  } catch {
    return null;
  }
  if (!user) return null;
  const served = servedRequests.get(user);
  return served ? { token: served, user } : null;
}

// The identity token of each request everyApp() serves, by its user, so a
// second read of the same token answers from the context.
const servedRequests = new WeakMap<EveryAppUser, string>();

/**
 * Return the verified Every App user for this request, or null for a declared
 * public request. `request` is the inbound `Request` or just its `Headers`
 * (a framework that hands out headers alone needs no made-up Request).
 * Answers from the request context or the per-request cache first, then
 * verifies the identity headers from the audience and public keys in env.
 * Inside a handler `everyApp()` serves, `currentUser()` is the shorter way.
 */
export async function getEveryAppUser(
  request: Request | Headers,
  env: object,
): Promise<EveryAppUser | null> {
  const cached = requestIdentities.get(request);
  if (cached) return cached.user;
  const fromContext = contextUserFor(request);
  if (fromContext) return fromContext;

  const identity = await resolveIdentity(request, env, {
    keysEnvVar: PUBLIC_KEYS_ENV,
  });
  rememberIdentity(request, identity);
  return identity.user;
}

/**
 * Return the verified user, or throw the same 401 JSON Response shape as
 * everyApp() when the request is public or unauthenticated.
 */
export async function requireEveryAppUser(
  request: Request | Headers,
  env: object,
): Promise<EveryAppUser> {
  try {
    const user = await getEveryAppUser(request, env);
    if (!user) {
      throw new IdentityError(
        "this request does not have an authenticated user",
      );
    }
    return user;
  } catch (error) {
    if (error instanceof IdentityError) {
      throw unauthorized(error.message);
    }
    throw error;
  }
}

/**
 * The user of the request being served (`currentUser()`), or throw the
 * same 401 JSON Response as `requireEveryAppUser()` on a public route.
 * Outside a request (`withOrganization()` work, a handler not under
 * `everyApp()`) it throws `RequestContextError`, as `currentUser()` does.
 */
export function requireCurrentUser(): EveryAppUser {
  const user = currentUser();
  if (!user) {
    throw unauthorized("this request does not have an authenticated user");
  }
  return user;
}

/**
 * `response` without `Set-Cookie`: the perimeter strips every `Cookie`
 * before a request reaches the app, so no cookie the app sets ever comes
 * back, and one named like the Gateway's session cookie locks the person
 * out of the app host (the perimeter refuses a session cookie sent twice).
 * A WebSocket handshake (101) passes as it is: it can't be rebuilt from
 * its body, and the perimeter drops its cookies' `Domain`.
 */
function withoutCookies(response: Response): Response {
  if (response.status === 101 || !response.headers.has("set-cookie")) {
    return response;
  }
  console.warn(
    "[everyapp] Dropped a Set-Cookie header: the Gateway never sends an app's cookies back to it.",
  );
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function hasScope(user: EveryAppUser, scope: string): boolean {
  return user.scopes.includes("*") || user.scopes.includes(scope);
}

function isManifest(value: unknown): value is EveryAppManifestLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/** Wrap a Worker fetch handler with Every App identity verification. */
export function everyApp<
  TEnv = Record<string, unknown>,
  TCtx extends ExecutionContextLike = ExecutionContext,
>(
  handler: EveryAppHandler<TEnv, TCtx>,
  options?: EveryAppOptions,
): EveryAppExport<TEnv, TCtx>;
/**
 * @deprecated Drop the manifest: the app id now comes from
 *   `env.EVERYAPP_APP_ID` and the audience from `env.EVERYAPP_AUDIENCE`.
 *   When passed, it must match the app id.
 */
export function everyApp<
  TEnv = Record<string, unknown>,
  TCtx extends ExecutionContextLike = ExecutionContext,
>(
  handler: EveryAppHandler<TEnv, TCtx>,
  manifest: EveryAppManifestLike | undefined,
  options?: EveryAppOptions,
): EveryAppExport<TEnv, TCtx>;
export function everyApp<
  TEnv = Record<string, unknown>,
  TCtx extends ExecutionContextLike = ExecutionContext,
>(
  handler: EveryAppHandler<TEnv, TCtx>,
  manifestOrOptions?: EveryAppManifestLike | EveryAppOptions,
  legacyOptions: EveryAppOptions = {},
): EveryAppExport<TEnv, TCtx> {
  const manifest = isManifest(manifestOrOptions)
    ? manifestOrOptions
    : undefined;
  const options =
    manifest || manifestOrOptions === undefined
      ? legacyOptions
      : (manifestOrOptions as EveryAppOptions);
  const config = configFrom(manifest, options);

  return {
    async fetch(request: Request, env: TEnv, ctx: TCtx) {
      let audience: string;
      let appId: string;
      try {
        audience = audienceFor(env, config);
        appId = appIdFor(env, config) ?? audience;
      } catch (err) {
        if (err instanceof ConfigurationError) {
          console.error(err);
          return misconfigured(err.message);
        }
        throw err;
      }

      // The reserved tools contract carries its own gateway-minted tokens and
      // never reaches the app's handler.
      const toolsResponse = await handleToolsRequest(request, env, ctx, {
        toolSet: options.tools,
        appId,
        identity: identityOptions(env, config, audience),
      });
      if (toolsResponse) return toolsResponse;

      let identity: IdentityResult;
      try {
        identity = await getIdentityFromRequest(
          request,
          identityOptions(env, config, audience),
        );
        rememberIdentity(request, identity);
      } catch (err) {
        if (err instanceof ConfigurationError) {
          console.error(err);
          return misconfigured(err.message);
        }
        if (err instanceof IdentityError) return unauthorized(err.message);
        throw err;
      }

      const { user, expiresAt } = identity;
      if (user) {
        servedRequests.set(user, request.headers.get(IDENTITY_HEADER) ?? "");
      }
      const response = await serveRequest({ request, user, expiresAt }, () =>
        handler(request, env, ctx, user),
      );
      return withoutCookies(response);
    },
  };
}
