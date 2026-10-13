/**
 * Verifying the JWTs Cloudflare Access signs: the `Cf-Access-Jwt-Assertion`
 * it adds to every request it lets through (the outer ring), and the ID token
 * its OIDC endpoint (Access for SaaS) returns at sign-in.
 *
 * Nothing here trusts a header or a token on sight. A token passes only with
 * an RS256 signature by a key in the team's published JWKS, the configured
 * issuer and audience, an expiry, and a non-empty email; anything else
 * (another algorithm, `alg: none`, an HS256 token keyed with the public key,
 * an unknown key id, a service token, which has no email) is refused. When
 * the JWKS can't be fetched, verification fails closed: keys are never used
 * past their cache lifetime, and nobody waits on a fetch longer than its
 * timeout.
 */
import { logEvent } from "@every-app/perimeter";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

/** Access tokens are signed with RS256 and nothing else. */
const ALGORITHM = "RS256";
/** How long a fetched JWKS is used before it is fetched again. */
const JWKS_TTL_MS = 10 * 60 * 1000;
/**
 * A token with a key id the cached JWKS lacks makes it refetch (Access rotates
 * its keys), but at most this often, so random key ids can't make every
 * request a JWKS fetch.
 */
const UNKNOWN_KID_REFETCH_MS = 30 * 1000;
/** How long a JWKS fetch may take, and how long anyone waits for one. */
const JWKS_FETCH_TIMEOUT_MS = 5000;
/** Leeway on `exp`, `nbf` and `iat` for clocks a little apart. */
const CLOCK_TOLERANCE_SECONDS = 60;

/** The `Cf-Access-Jwt-Assertion` header, and the cookie it mirrors. */
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const ACCESS_COOKIE = "CF_Authorization";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface JwksClientOptions {
  fetch?: Fetch;
  now?: () => number;
  /** How long a fetch may take before nobody waits for it (tests). */
  fetchTimeoutMs?: number;
}

/** A fetch of the key set, shared by the verifications waiting for it. */
interface Refresh {
  done: Promise<void>;
  startedAt: number;
}

/** `promise`, or nothing once `ms` have passed, whichever comes first. */
function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Signing keys published at one JWKS URL, cached per isolate. */
export class JwksClient {
  readonly url: string;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private keys: ReturnType<typeof createLocalJWKSet> | null = null;
  private kids = new Set<string>();
  private fetchedAt = 0;
  private lastUnknownKidFetch = Number.NEGATIVE_INFINITY;
  private inflight: Refresh | null = null;

  constructor(url: string, options: JwksClientOptions = {}) {
    this.url = url;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
  }

  private isFresh(): boolean {
    return this.keys !== null && this.now() - this.fetchedAt < JWKS_TTL_MS;
  }

  /**
   * The key set to verify a token with `kid` against, or null when the JWKS
   * can't be had (fetch failed with nothing fresh cached) or lacks the key.
   */
  async keysFor(
    kid: string,
  ): Promise<ReturnType<typeof createLocalJWKSet> | null> {
    if (this.isFresh() && this.kids.has(kid)) return this.keys;
    if (this.isFresh()) {
      // A fresh set without this key: refetch once in a while, for a key
      // Access has just rotated in.
      if (this.now() - this.lastUnknownKidFetch < UNKNOWN_KID_REFETCH_MS) {
        return null;
      }
      this.lastUnknownKidFetch = this.now();
    }
    await this.refresh();
    return this.isFresh() && this.kids.has(kid) ? this.keys : null;
  }

  /**
   * Fetch the key set, or join a fetch already under way. In Workers a fetch
   * belongs to the request that started it: if that request is cancelled
   * (its client went away), the fetch and its timeout die with it and never
   * settle. So nobody waits on a fetch for longer than the timeout, and one
   * older than that is replaced by a fetch of this request's own.
   */
  private refresh(): Promise<void> {
    const now = this.now();
    if (
      !this.inflight ||
      now - this.inflight.startedAt >= this.fetchTimeoutMs
    ) {
      const refresh: Refresh = { done: Promise.resolve(), startedAt: now };
      refresh.done = this.load().finally(() => {
        if (this.inflight === refresh) this.inflight = null;
      });
      this.inflight = refresh;
    }
    return waitAtMost(this.inflight.done, this.fetchTimeoutMs);
  }

  private async load(): Promise<void> {
    let jwks: JSONWebKeySet;
    try {
      const response = await this.fetchImpl(this.url, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      jwks = signingKeys(await response.json());
    } catch (error) {
      // Fail closed: a set that has outlived its TTL is dropped, never used.
      if (!this.isFresh()) {
        this.keys = null;
        this.kids = new Set();
      }
      logEvent(
        "access.jwks_fetch_failed",
        {
          url: this.url,
          reason: error instanceof Error ? error.message : String(error),
        },
        "error",
      );
      return;
    }
    this.keys = createLocalJWKSet(jwks);
    this.kids = new Set(jwks.keys.map((key) => key.kid!));
    this.fetchedAt = this.now();
  }
}

/** The RS256 signing keys of a JWKS document, each with a key id. */
function signingKeys(document: unknown): JSONWebKeySet {
  const keys = (document as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new Error("not a JWKS document");
  return {
    keys: keys.filter(
      (key): key is JSONWebKeySet["keys"][number] =>
        typeof key === "object" &&
        key !== null &&
        key.kty === "RSA" &&
        typeof key.kid === "string" &&
        key.kid.length > 0 &&
        (key.use === undefined || key.use === "sig") &&
        (key.alg === undefined || key.alg === ALGORITHM),
    ),
  };
}

const clients = new Map<string, JwksClient>();

/** The isolate's shared client for a JWKS URL. */
export function jwksClientFor(url: string): JwksClient {
  let client = clients.get(url);
  if (!client) {
    client = new JwksClient(url);
    clients.set(url, client);
  }
  return client;
}

/** Forget every cached JWKS (tests). */
export function clearJwksClientsForTests(): void {
  clients.clear();
}

/** Who a verified Access token says the user is. */
export interface AccessIdentity {
  /** Lowercased; Access verified it. */
  email: string;
  name: string | null;
  claims: JWTPayload;
}

export interface VerifyAccessJwtOptions {
  jwks: JwksClient;
  issuer: string;
  /** Accepted `aud` values: the Access application's AUD tag(s), or the OIDC client id. */
  audience: string | string[];
  now?: Date;
}

/**
 * The identity in an Access-signed token, or null for any token that isn't
 * one (see the file comment). Never throws.
 */
export async function verifyAccessJwt(
  token: string,
  options: VerifyAccessJwtOptions,
): Promise<AccessIdentity | null> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== ALGORITHM || typeof header.kid !== "string") return null;
  if (!header.kid) return null;

  const keys = await options.jwks.keysFor(header.kid);
  if (!keys) return null;

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: [ALGORITHM],
      issuer: options.issuer,
      audience: options.audience,
      requiredClaims: ["exp"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      ...(options.now ? { currentDate: options.now } : {}),
    }));
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) throw error;
    return null;
  }

  // A service token carries no email: it is a machine, never a user.
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email || !email.includes("@") || /\s/.test(email)) return null;
  // Access vouches for the email it puts in a token; if the token itself
  // says the email isn't verified, believe that.
  if (payload.email_verified === false) return null;

  return {
    email: email.toLowerCase(),
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim()
        : null,
    claims: payload,
  };
}

/**
 * The Access assertion a request carries: the `Cf-Access-Jwt-Assertion`
 * header Access adds, else its `CF_Authorization` cookie (Cloudflare's docs
 * prefer the header; the cookie isn't always sent). Unverified.
 */
export function readAccessAssertion(headers: Headers): string | null {
  const header = headers.get(ACCESS_ASSERTION_HEADER)?.trim();
  if (header) return header;
  const cookies = headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === ACCESS_COOKIE) {
      const value = part.slice(separator + 1).trim();
      return value || null;
    }
  }
  return null;
}
