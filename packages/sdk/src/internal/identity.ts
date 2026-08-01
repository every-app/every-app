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
  IDENTITY_ALG,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  IDENTITY_KEY_ID,
  ISSUER_ENV,
  PUBLIC_HEADER,
  PUBLIC_KEYS_ENV,
  PUBLIC_MARKER_SUB,
  assertPublicMarkerClaims,
  identityClaimsToEveryAppUser,
  ProtocolClaimsError,
  type EveryAppUser,
  type IdentityChannel,
  type IdentityTokenType,
} from "./protocol.js";

export {
  APP_ID_ENV,
  DEV_ENV,
  IDENTITY_ALG,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  IDENTITY_KEY_ID,
  ISSUER_ENV,
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
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
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
   * production.
   */
  allowDevIdentities?: boolean;
  /** Override for tests. */
  now?: number;
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
  const payload = await verifyPinnedJwt(token, options, "user");
  try {
    return identityClaimsToEveryAppUser(payload);
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
  if (expectedTyp === "user" && !options.issuer) {
    throw new IdentityError(
      `${ISSUER_ENV} not configured — deploy with the Every App CLI or provide an explicit issuer.`,
    );
  }

  const verifyOpts = {
    algorithms: [IDENTITY_ALG],
    audience: options.audience,
    requiredClaims: ["exp"],
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
}

export interface RequestIdentityOptions {
  audience: string;
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
 * Resolve identity for an incoming proxied request. Public routes carry a
 * gateway-SIGNED marker in `x-everyapp-public` and resolve to
 * `{ user: null, isPublic: true }` only after the marker verifies. Everything
 * else requires a valid identity JWT. Throws {@link IdentityError} on any
 * problem — including a bare/forged public header — so a re-exposed worker
 * fails closed.
 */
export async function getIdentityFromRequest(
  request: Request,
  options: RequestIdentityOptions,
): Promise<IdentityResult> {
  const publicKeys =
    options.publicKeys ??
    parsePublicKeys(
      (options.env?.[options.keysEnvVar ?? PUBLIC_KEYS_ENV] as string) ?? null,
    );
  // Dev identities are accepted only when the worker env opts in (everyapp dev
  // sets EVERYAPP_DEV in .dev.vars). Production never sets it.
  const devEnv = options.env?.[DEV_ENV];
  const allowDevIdentities =
    options.allowDevIdentities ??
    (typeof devEnv === "string" &&
      (devEnv === "1" || devEnv.toLowerCase() === "true"));
  const verifyOptions = {
    publicKeys,
    audience: options.audience,
    issuer:
      options.issuer ??
      ((options.env?.[ISSUER_ENV] as string | undefined) || undefined),
    allowDevIdentities,
    now: options.now,
  };

  const publicMarker = request.headers.get(PUBLIC_HEADER);
  if (publicMarker) {
    await verifyPublicMarkerJwt(publicMarker, verifyOptions);
    return { user: null, isPublic: true };
  }

  const token = request.headers.get(IDENTITY_HEADER);
  if (!token) {
    throw new IdentityError(
      "request reached the app without an identity token (not proxied through the gateway?)",
    );
  }
  const user = await verifyIdentityJwt(token, verifyOptions);
  return { user, isPublic: false };
}
