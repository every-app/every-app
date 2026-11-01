/**
 * The outer ring: Cloudflare Access in front of the gateway's hostnames.
 * Access adds a signed `Cf-Access-Jwt-Assertion` to every request it lets
 * through (and browsers send its `CF_Authorization` cookie, even on paths
 * Access lets through without a login). The gateway never trusts either as
 * such: it verifies the JWT (team JWKS, AUD, issuer, expiry, an application
 * token) every time, and it reads it only to sign the person in to Better
 * Auth (plugin.ts) or to check that a session belongs to them. Apps never see
 * it: the perimeter strips every `cf-access-*` header and the cookie header
 * before proxying.
 *
 * Two kinds of AUD: an assertion for the Access application on the gateway's
 * own host may sign someone in; one for the apps' application (a separate
 * application, as the runbook recommends) only vouches for a session. So an
 * app host's Access token, should it ever leak, is never a gateway login.
 *
 * A browser sends the same assertion on every request for as long as it
 * lasts, and a page load is many requests, so a verified assertion's
 * identity is kept per isolate for a minute (never past the token's own
 * `exp`): the first request on an isolate fetches the team's keys and
 * checks the signature, and the ones after read the result. Only a
 * verification that succeeded is kept, and only once it has: requests
 * verifying the same token at the same moment each run the check (the
 * JWKS client shares one fetch between them, each with a timeout of its
 * own), so nobody waits on a promise rooted in another request, which in
 * Workers dies with it. A token that fails to verify, or whose check
 * throws, is never kept. The check itself is unchanged: what counts as a
 * vouch is still exactly a token this code verified, under this
 * configuration, within its lifetime.
 */
import type { AccessOuterRingConfig } from "./config";
import {
  jwksClientFor,
  readAccessAssertion,
  verifyAccessJwt,
  type AccessIdentity,
} from "./jwt";

interface OuterRingIdentity extends AccessIdentity {
  /** Issued for the gateway's own Access application: may sign them in. */
  maySignIn: boolean;
}

/** How long a verified assertion's identity is kept, at most. */
const VOUCH_TTL_MS = 60 * 1000;
const VOUCH_MAX_ENTRIES = 1000;

interface Vouch {
  identity: OuterRingIdentity;
  expiresAtMs: number;
}

// Per isolate, by configuration and token.
const vouches = new Map<string, Vouch>();

export function clearOuterRingVouchesForTests(): void {
  vouches.clear();
}

function vouchKey(token: string, outerRing: AccessOuterRingConfig): string {
  return `${outerRing.certsUrl}\0${outerRing.issuer}\0${outerRing.audiences.join(",")}\0${outerRing.signInAudiences.join(",")}\0${outerRing.idpIds.join(",")}\0${token}`;
}

function remember(key: string, vouch: Vouch): void {
  vouches.delete(key);
  vouches.set(key, vouch);
  if (vouches.size > VOUCH_MAX_ENTRIES) {
    const oldest = vouches.keys().next().value;
    if (oldest !== undefined) vouches.delete(oldest);
  }
}

async function verify(
  token: string,
  outerRing: AccessOuterRingConfig,
): Promise<OuterRingIdentity | null> {
  const identity = await verifyAccessJwt(token, {
    jwks: jwksClientFor(outerRing.certsUrl),
    issuer: outerRing.issuer,
    audience: outerRing.audiences,
    idpIds: outerRing.idpIds,
  });
  // An application's token. Access's organization token (`type: "org"`, the
  // team domain's own session) is never sent to an application, and is no
  // vouch for one.
  if (!identity || identity.claims.type !== "app") return null;
  const aud = identity.claims.aud;
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
  return {
    ...identity,
    maySignIn: audiences.some((value) =>
      outerRing.signInAudiences.includes(value),
    ),
  };
}

/** The verified outer-ring identity a request carries, if any. */
export async function verifyOuterRingAssertion(
  headers: Headers,
  outerRing: AccessOuterRingConfig,
  nowMs = Date.now(),
): Promise<OuterRingIdentity | null> {
  const token = readAccessAssertion(headers);
  if (!token) return null;
  const key = vouchKey(token, outerRing);
  const kept = vouches.get(key);
  if (kept && kept.expiresAtMs > nowMs) return kept.identity;
  if (kept) vouches.delete(key);

  const identity = await verify(token, outerRing);
  if (!identity) return null;
  // Never past the token's own expiry (verifyAccessJwt required one).
  const exp = identity.claims.exp;
  const expiresAtMs = Math.min(
    nowMs + VOUCH_TTL_MS,
    typeof exp === "number" ? exp * 1000 : Number.POSITIVE_INFINITY,
  );
  remember(key, { identity, expiresAtMs });
  return identity;
}
