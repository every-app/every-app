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

/** The verified outer-ring identity a request carries, if any. */
export async function verifyOuterRingAssertion(
  headers: Headers,
  outerRing: AccessOuterRingConfig,
): Promise<OuterRingIdentity | null> {
  const token = readAccessAssertion(headers);
  if (!token) return null;
  const identity = await verifyAccessJwt(token, {
    jwks: jwksClientFor(outerRing.certsUrl),
    issuer: outerRing.issuer,
    audience: outerRing.audiences,
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
