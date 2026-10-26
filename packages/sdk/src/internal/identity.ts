/**
 * Every App identity JWT verification (the app side of the trust boundary).
 *
 * The gateway injects a short-lived RS256 JWT as `x-everyapp-identity`. This
 * module verifies it **fail-closed**: the algorithm and key id are pinned,
 * `none` is rejected, the audience must equal this app, and the verification
 * key set arrives from an env var (current + next public keys) — never a
 * runtime JWKS fetch. A bare header is never a trust source; only a token that
 * survives verification produces a user.
 */
import {
  importSPKI,
  jwtVerify,
  decodeProtectedHeader,
  type JWTPayload,
} from "jose";
import {
  APP_ID_ENV,
  DEV_ENV,
  DEV_ISSUER,
  IDENTITY_ALG,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  IDENTITY_KEY_ID,
  ISSUER_ENV,
  ORG_ID_ENV,
  PUBLIC_HEADER,
  PUBLIC_KEYS_ENV,
  PUBLIC_MARKER_SUB,
  assertPublicMarkerClaims,
  assertSystemClaims,
  identityClaimsToEveryAppUser,
  ProtocolClaimsError,
  type EveryAppUser,
  type IdentityChannel,
  type IdentityTokenType,
  type SystemClaims,
  type SystemTokenPurpose,
} from "./protocol.js";

export {
  APP_ID_ENV,
  DEV_ENV,
  DEV_ISSUER,
  IDENTITY_ALG,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  IDENTITY_KEY_ID,
  ISSUER_ENV,
  ORG_ID_ENV,
  PUBLIC_HEADER,
  PUBLIC_KEYS_ENV,
  PUBLIC_MARKER_SUB,
  type EveryAppUser,
  type IdentityChannel,
};

export class IdentityError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export class ConfigurationError extends Error {
  readonly status = 500;
  /**
   * The Gateway refusal code the same gap gets once deployed
   * (`ai_provider_not_configured`, `ai_default_not_configured`), when the
   * error is "not set up" rather than a mistake in the code.
   */
  readonly code: string | undefined;
  /** The settings that would close the gap (`.dev.vars` names in local dev). */
  readonly settings: readonly string[];
  constructor(
    message: string,
    setup?: { code: string; settings?: readonly string[] },
  ) {
    super(message);
    this.name = "ConfigurationError";
    this.code = setup?.code;
    this.settings = setup?.settings ?? [];
  }
}

/**
 * Parse the public key set from an env var value. Accepts a JSON array of PEM
 * strings, or a single PEM string. Returns at least one key or throws.
 */
export function parsePublicKeys(envValue: string | undefined | null): string[] {
  if (!envValue || envValue.trim().length === 0) {
    throw new ConfigurationError(
      `${PUBLIC_KEYS_ENV} is not set — the gateway must inject the identity public key set.`,
    );
  }
  const trimmed = envValue.trim();
  let keys: string[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ConfigurationError(
        `${PUBLIC_KEYS_ENV} must be a JSON array of PEM strings: ${(error as Error).message}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((k) => typeof k !== "string")) {
      throw new ConfigurationError(
        `${PUBLIC_KEYS_ENV} must be a JSON array of PEM strings.`,
      );
    }
    keys = parsed.map((k) => (k as string).replace(/\\n/g, "\n"));
  } else {
    keys = [trimmed.replace(/\\n/g, "\n")];
  }
  if (keys.length === 0) {
    throw new ConfigurationError(`${PUBLIC_KEYS_ENV} contained no keys.`);
  }
  return keys;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function importKey(pem: string): Promise<CryptoKey> {
  let cached = keyCache.get(pem);
  if (!cached) {
    cached = importSPKI(pem, IDENTITY_ALG);
    keyCache.set(pem, cached);
  }
  return cached;
}

export interface VerifyOptions {
  /** SPKI PEM public keys (current + next). */
  publicKeys: string[];
  /** Expected `aud` — this app's id. */
  audience: string;
  /** Expected issuer (the gateway URL). Required for user identities. */
  issuer?: string;
  /**
   * Accept the dev identity kid ({@link IDENTITY_DEV_KEY_ID}). Set ONLY in
   * local dev (driven by the {@link DEV_ENV} worker env var). Never true in
   * production. Requires `issuer` to be {@link DEV_ISSUER}.
   */
  allowDevIdentities?: boolean;
  /** Override for tests. */
  now?: number;
}

/**
 * The dev keypair is public (`@every-app/sdk/dev`), so the dev opt-in holds
 * only for the dev issuer: a dev-kid token that names a real gateway as its
 * issuer never verifies, whatever the env says.
 */
function assertDevIssuer(options: VerifyOptions): void {
  if (options.allowDevIdentities && options.issuer !== DEV_ISSUER) {
    throw new ConfigurationError(
      `Dev identities are accepted only from the dev issuer ${DEV_ISSUER}, not ${options.issuer ? `"${options.issuer}"` : "an unset issuer"}. ${DEV_ENV} is for \`everyapp dev\` alone.`,
    );
  }
}

/**
 * Verify an identity JWT fail-closed. Throws {@link IdentityError} on any
 * problem (bad alg/kid, `none`, wrong key, expired, wrong audience, missing
 * claims).
 */
export async function verifyIdentityJwt(
  token: string,
  options: VerifyOptions,
): Promise<EveryAppUser> {
  return (await verifyIdentity(token, options)).user;
}

/** A verified identity, with when it stops being one. */
export interface VerifiedIdentity {
  user: EveryAppUser;
  /** The token's `exp`, in epoch milliseconds. */
  expiresAt: number;
}

/**
 * {@link verifyIdentityJwt}, keeping the token's expiry: the SDK's request
 * context stops forwarding an identity shortly before it, and goes on as
 * the organization's background work.
 */
export async function verifyIdentity(
  token: string,
  options: VerifyOptions,
): Promise<VerifiedIdentity> {
  const payload = await verifyPinnedJwt(token, options, "user");
  try {
    const user = identityClaimsToEveryAppUser(payload);
    // `exp` is a required claim (verifyPinnedJwt); jose checked it.
    return { user, expiresAt: (payload.exp as number) * 1000 };
  } catch (error) {
    if (error instanceof ProtocolClaimsError) {
      throw new IdentityError(error.message);
    }
    throw error;
  }
}

/**
 * The organization pin: a deployed Worker serves one organization
 * (`EVERY_APP_ORG_ID`), and an identity for any other is refused, whatever
 * its audience says. Throws {@link IdentityError} on a mismatch; a Worker
 * with no pin (a shared app's) accepts every organization.
 */
export function assertOrganizationPin(
  user: EveryAppUser,
  organizationId: string | undefined,
): void {
  if (organizationId && user.orgId !== organizationId) {
    throw new IdentityError(
      `identity is for organization "${user.orgId}", and this Worker serves organization "${organizationId}" (${ORG_ID_ENV})`,
    );
  }
}

/**
 * Verify the gateway's system token (the value of `x-everyapp-system`)
 * fail-closed, for exactly one purpose. A user identity or public marker is
 * never a system token, and a system token is never an identity.
 */
export async function verifySystemJwt(
  token: string,
  options: VerifyOptions & { purpose: SystemTokenPurpose },
): Promise<SystemClaims> {
  const payload = await verifyPinnedJwt(token, options, "system");
  try {
    return assertSystemClaims(payload, options.purpose);
  } catch (error) {
    if (error instanceof ProtocolClaimsError) {
      throw new IdentityError(error.message);
    }
    throw error;
  }
}

/**
 * The shared fail-closed verification core: pinned alg/kid, `none` rejected,
 * `aud` checked, multi-key (current + next). Returns the verified payload.
 */
async function verifyPinnedJwt(
  token: string,
  options: VerifyOptions,
  expectedTyp: IdentityTokenType,
): Promise<JWTPayload> {
  assertDevIssuer(options);
  if (!token) throw new IdentityError("no identity token");

  // Pin the header BEFORE attempting any signature work. This is what defeats
  // `alg: none` and algorithm-confusion (e.g. an HS256 token forged with the
  // public key as the HMAC secret).
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new IdentityError("malformed identity token");
  }
  if (header.alg !== IDENTITY_ALG) {
    throw new IdentityError(
      `unexpected alg "${header.alg}" (expected ${IDENTITY_ALG})`,
    );
  }
  const allowedKids = options.allowDevIdentities
    ? [IDENTITY_KEY_ID, IDENTITY_DEV_KEY_ID]
    : [IDENTITY_KEY_ID];
  if (!header.kid || !allowedKids.includes(header.kid)) {
    throw new IdentityError(`unexpected kid "${header.kid}"`);
  }
  if (expectedTyp !== "public" && !options.issuer) {
    throw new IdentityError(
      `${ISSUER_ENV} not configured — deploy with the EveryApp CLI or provide an explicit issuer.`,
    );
  }

  const verifyOpts = {
    algorithms: [IDENTITY_ALG],
    audience: options.audience,
    requiredClaims: expectedTyp === "system" ? ["exp", "iat"] : ["exp"],
    ...(options.issuer ? { issuer: options.issuer } : {}),
    ...(options.now ? { currentDate: new Date(options.now) } : {}),
  };

  let lastErr: unknown;
  for (const pem of options.publicKeys) {
    try {
      const key = await importKey(pem);
      const { payload } = await jwtVerify(token, key, verifyOpts);
      if (payload.typ !== expectedTyp) {
        throw new IdentityError(
          `unexpected token typ "${payload.typ}" (expected ${expectedTyp})`,
        );
      }
      return payload;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new IdentityError(
    `identity verification failed: ${(lastErr as Error)?.message ?? "no matching key"}`,
  );
}

/**
 * Verify a public-route marker (the value of `x-everyapp-public`). The marker
 * is a gateway-signed, app-scoped JWT with `pub: true` and `typ: "public"` —
 * a bare header is NEVER a trust source, so a re-exposed app worker cannot be
 * flipped into public mode by anyone who can type a header. Throws on any
 * problem.
 */
export async function verifyPublicMarkerJwt(
  token: string,
  options: VerifyOptions,
): Promise<void> {
  const payload = await verifyPinnedJwt(token, options, "public");
  try {
    assertPublicMarkerClaims(payload);
  } catch (error) {
    if (error instanceof ProtocolClaimsError) {
      throw new IdentityError(error.message);
    }
    throw error;
  }
}

export interface IdentityResult {
  /** The verified user, or null for a declared public route. */
  user: EveryAppUser | null;
  /** True when the gateway marked this request as a public route. */
  isPublic: boolean;
  /** When the identity expires (epoch ms); null on a public route. */
  expiresAt: number | null;
}

export interface RequestIdentityOptions {
  audience: string;
  /**
   * The organization this Worker is pinned to ({@link ORG_ID_ENV}): an
   * identity for another is refused. Undefined accepts every organization.
   */
  organizationId?: string;
  /** Provide keys directly, or let {@link getIdentityFromRequest} read env. */
  publicKeys?: string[];
  /** Env bag to read {@link PUBLIC_KEYS_ENV} / {@link DEV_ENV} from. */
  env?: Record<string, unknown>;
  keysEnvVar?: string;
  issuer?: string;
  /** Force dev-kid acceptance. Defaults to reading {@link DEV_ENV} from env. */
  allowDevIdentities?: boolean;
  now?: number;
}

/**
 * The verification options for a request: keys from options or env, the
 * expected issuer, and the dev-kid opt-in. Throws {@link ConfigurationError}
 * when no key set is configured, or when the dev opt-in meets an issuer other
 * than {@link DEV_ISSUER}.
 */
export function resolveVerifyOptions(
  options: RequestIdentityOptions,
): VerifyOptions {
  const publicKeys =
    options.publicKeys ??
    parsePublicKeys(
      (options.env?.[options.keysEnvVar ?? PUBLIC_KEYS_ENV] as string) ?? null,
    );
  // Dev identities are accepted only when the worker env opts in
  // (everyAppWorker() sets EVERYAPP_DEV in development). A deploy never does.
  const devEnv = options.env?.[DEV_ENV];
  const allowDevIdentities =
    options.allowDevIdentities ??
    (typeof devEnv === "string" &&
      (devEnv === "1" || devEnv.toLowerCase() === "true"));
  const resolved: VerifyOptions = {
    publicKeys,
    audience: options.audience,
    issuer:
      options.issuer ??
      ((options.env?.[ISSUER_ENV] as string | undefined) || undefined),
    allowDevIdentities,
    now: options.now,
  };
  assertDevIssuer(resolved);
  return resolved;
}

/**
 * Resolve identity for an incoming proxied request. Public routes carry a
 * gateway-SIGNED marker in `x-everyapp-public` and resolve to
 * `{ user: null, isPublic: true }` only after the marker verifies. Everything
 * else requires a valid identity JWT. Throws {@link IdentityError} on any
 * problem — including a bare/forged public header — so a re-exposed worker
 * fails closed.
 */
export async function getIdentityFromRequest(
  request: Request | Headers,
  options: RequestIdentityOptions,
): Promise<IdentityResult> {
  const verifyOptions = resolveVerifyOptions(options);

  const headers = isRequestLike(request) ? request.headers : request;
  const publicMarker = headers.get(PUBLIC_HEADER);
  if (publicMarker) {
    await verifyPublicMarkerJwt(publicMarker, verifyOptions);
    return { user: null, isPublic: true, expiresAt: null };
  }

  const token = headers.get(IDENTITY_HEADER);
  if (!token) {
    throw new IdentityError(
      "request reached the app without an identity token (not proxied through the gateway?)",
    );
  }
  const { user, expiresAt } = await verifyIdentity(token, verifyOptions);
  assertOrganizationPin(user, options.organizationId);
  return { user, isPublic: false, expiresAt };
}

// Duck-typed: a Request from another realm (a test runner, a polyfill) still
// carries its headers the same way.
function isRequestLike(value: Request | Headers): value is Request {
  return "headers" in value && typeof value.headers?.get === "function";
}
