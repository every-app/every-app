/**
 * `everyApp()` — the app-side identity boundary.
 *
 *   export default everyApp(handler);
 *
 * The wrapper verifies the gateway-injected identity before app code runs,
 * stores the result on the original Request, and then delegates to the
 * worker-style handler. The expected audience is the app id in
 * `env.EVERYAPP_APP_ID`, which `everyAppWorker()` sets from the manifest, so
 * the Worker never imports `everyapp.config.ts` (the Cloudflare Vite plugin
 * hides every file `cloudflare.config.ts` imports from the Worker in dev).
 */
import {
  APP_ID_ENV,
  ConfigurationError,
  DEV_ENV,
  IdentityError,
  ISSUER_ENV,
  PUBLIC_KEYS_ENV,
  getIdentityFromRequest,
  type EveryAppUser,
  type IdentityResult,
} from "../internal/index.js";

export { ConfigurationError, IdentityError };
export type { EveryAppUser, IdentityResult };

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

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
  /** Override for tests. */
  now?: number;
}

/** The handler accepted by everyApp, with the verified user as a 4th argument. */
export type EveryAppHandler<TEnv = Record<string, unknown>> = (
  request: Request,
  env: TEnv,
  ctx: ExecutionContextLike,
  user: EveryAppUser | null,
) => Response | Promise<Response>;

interface EveryAppExport<TEnv> {
  fetch(
    request: Request,
    env: TEnv,
    ctx: ExecutionContextLike,
  ): Promise<Response>;
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

const requestIdentities = new WeakMap<Request, IdentityResult>();

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
 * The app id identity tokens must be scoped to. EVERYAPP_APP_ID wins; a
 * manifest passed to everyApp() is only a fallback for Workers deployed
 * without it, and must agree with it when both are present.
 */
function audienceFor(env: unknown, config: VerificationConfig): string {
  const fromEnv = envValue(env, APP_ID_ENV);
  if (fromEnv && config.manifestAppId && fromEnv !== config.manifestAppId) {
    throw new ConfigurationError(
      `${APP_ID_ENV} ("${fromEnv}") does not match the manifest id ("${config.manifestAppId}").`,
    );
  }
  const audience = fromEnv ?? config.manifestAppId;
  if (!audience) {
    throw new ConfigurationError(
      `${APP_ID_ENV} is not set — the app's cloudflare.config.ts must declare it (everyAppWorker() does).`,
    );
  }
  return audience;
}

function unauthorized(message: string): Response {
  return Response.json({ error: "unauthenticated", message }, { status: 401 });
}

function misconfigured(message: string): Response {
  return Response.json({ error: "misconfigured", message }, { status: 500 });
}

async function resolveIdentity(
  request: Request,
  env: unknown,
  config: VerificationConfig,
): Promise<IdentityResult> {
  const devEnv =
    env && typeof env === "object"
      ? (env as Record<string, unknown>)[DEV_ENV]
      : undefined;
  return getIdentityFromRequest(request, {
    audience: audienceFor(env, config),
    issuer: config.issuer ?? envValue(env, ISSUER_ENV),
    publicKeys: config.publicKeys,
    env: env as Record<string, unknown> | undefined,
    keysEnvVar: config.keysEnvVar,
    allowDevIdentities:
      config.allowDevIdentities ??
      (typeof devEnv === "string" &&
        (devEnv === "1" || devEnv.toLowerCase() === "true")),
    now: config.now,
  });
}

function rememberIdentity(request: Request, identity: IdentityResult): void {
  requestIdentities.set(request, identity);
}

/**
 * Return the verified Every App user for this request, or null for a declared
 * public request. Uses the request cache first, then verifies the identity
 * headers from the app id and public keys configured in env.
 */
export async function getEveryAppUser(
  request: Request,
  env: object,
): Promise<EveryAppUser | null> {
  const cached = requestIdentities.get(request);
  if (cached) return cached.user;

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
  request: Request,
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

export function hasScope(user: EveryAppUser, scope: string): boolean {
  return user.scopes.includes("*") || user.scopes.includes(scope);
}

/**
 * Wrap a Worker fetch handler with Every App identity verification.
 *
 * @param manifest Deprecated: the app id now comes from `env.EVERYAPP_APP_ID`.
 *   When passed, it must match that value.
 */
export function everyApp<TEnv = Record<string, unknown>>(
  handler: EveryAppHandler<TEnv>,
  manifest?: EveryAppManifestLike,
  options: EveryAppOptions = {},
): EveryAppExport<TEnv> {
  const config = configFrom(manifest, options);

  return {
    async fetch(request: Request, env: TEnv, ctx: ExecutionContextLike) {
      let identity: IdentityResult;
      try {
        identity = await resolveIdentity(request, env, config);
        rememberIdentity(request, identity);
      } catch (err) {
        if (err instanceof ConfigurationError) {
          console.error(err);
          return misconfigured(err.message);
        }
        if (err instanceof IdentityError) return unauthorized(err.message);
        throw err;
      }

      return handler(request, env, ctx, identity.user);
    },
  };
}
