/**
 * Header hygiene for the gateway perimeter.
 *
 * Two responsibilities:
 *  1. Strip every credential / spoofable trust header off the *inbound* request
 *     before it is proxied to an app (the app must only ever trust the identity
 *     JWT the gateway injects, never a bare header a client could forge).
 *  2. Stamp uniform security headers onto HTML responses on the way out.
 */

import { IDENTITY_HEADER, PUBLIC_HEADER } from "@every-app/sdk/internal";

export { IDENTITY_HEADER, PUBLIC_HEADER };

/** Prefix for all gateway-injected trust headers. Stripped inbound, set fresh. */
export const EVERYAPP_HEADER_PREFIX = "x-everyapp-";

/**
 * Cloudflare Access's headers: the signed `Cf-Access-Jwt-Assertion` and the
 * plain `Cf-Access-Authenticated-User-Email` it adds to requests it lets
 * through, and the `Cf-Access-Client-Id`/`-Secret` service-token
 * credentials clients send it. The gateway verifies the assertion itself and
 * turns it into a session; apps trust only the identity JWT, so none of
 * these reaches them (a forged email header on a host Access doesn't cover
 * would otherwise look like one).
 */
export const CF_ACCESS_HEADER_PREFIX = "cf-access-";

/**
 * Cloudflare routes a request carrying this header to the named Worker
 * version, so a client could pin its request to an old (unpatched) build of
 * an app. Only the gateway may ever choose an app version.
 */
export const VERSION_OVERRIDES_HEADER = "cloudflare-workers-version-overrides";

/**
 * Return a new Headers with the inbound Cookie, Authorization, the Worker
 * version override, and *all* `x-everyapp-*` and `cf-access-*` headers
 * removed. The app never sees the user's session cookie (or Access's
 * `CF_Authorization` cookie), a client cannot smuggle a forged
 * `x-everyapp-identity` or Access identity past the gateway, and a client
 * cannot pick which deployed version of the app answers.
 */
export function stripInboundHeaders(inbound: Headers): Headers {
  const out = new Headers(inbound);
  out.delete("cookie");
  out.delete("authorization");
  out.delete(VERSION_OVERRIDES_HEADER);
  for (const key of [...out.keys()]) {
    const name = key.toLowerCase();
    if (
      name.startsWith(EVERYAPP_HEADER_PREFIX) ||
      name.startsWith(CF_ACCESS_HEADER_PREFIX)
    ) {
      out.delete(key);
    }
  }
  return out;
}

/**
 * Extract an Every App personal access token (`epat_…`) bearer, or null.
 * The authenticator's PAT branch reads it and the gateway's reserved
 * credential check (`hasEveryAppBearer`) builds on it, so a token one of
 * them consumes is never forwarded or cookie-authenticated by the other.
 * Scheme is case-insensitive per RFC 9110; the `epat_` prefix is
 * case-sensitive (an `EPAT_…` value is someone else's credential).
 */
export function extractEveryAppBearer(inbound: Headers): string | null {
  const token = extractBearerCredential(inbound);
  return token?.startsWith("epat_") ? token : null;
}

const OAUTH_GRANT_ID = /^[A-Za-z0-9_-]{16}$/;
const OAUTH_TOKEN_SECRET = /^[A-Za-z0-9_-]{32}$/;

/**
 * Whether a bearer has the shape of a token the gateway's OAuth server
 * (@cloudflare/workers-oauth-provider) issues: `{userId}:{grantId}:{secret}`,
 * a 16-character grant id and a 32-character secret, read from the right
 * (a user id may hold `:`). Those tokens are for the gateway's own /mcp: an
 * app host accepts none, and forwards none to an app.
 */
export function isGatewayOauthToken(token: string): boolean {
  const parts = token.split(":");
  if (parts.length < 3) return false;
  return (
    parts.slice(0, -2).join(":").length > 0 &&
    OAUTH_GRANT_ID.test(parts[parts.length - 2]!) &&
    OAUTH_TOKEN_SECRET.test(parts[parts.length - 1]!)
  );
}

export function extractBearerCredential(inbound: Headers): string | null {
  const authorization = inbound.get("authorization");
  if (!authorization) return null;

  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  return token ? token : null;
}

/**
 * Whether the request carries a reserved Every App bearer: a personal access
 * token, or a token of the gateway's OAuth server. A reserved bearer is
 * never forwarded to an app, even on a public route, and never falls back
 * to anonymous access: it authenticates, or the request fails closed.
 */
export function hasEveryAppBearer(inbound: Headers): boolean {
  const token = extractBearerCredential(inbound);
  return (
    token !== null && (token.startsWith("epat_") || isGatewayOauthToken(token))
  );
}

export function hasBearerCredential(inbound: Headers): boolean {
  return extractBearerCredential(inbound) !== null;
}

/** Apply inbound trust stripping, optionally retaining app-owned bearer auth. */
export function prepareOutboundHeaders(
  inbound: Headers,
  forwardAuthorization: boolean,
  stripConsumedAuthorization = false,
): Headers {
  const out = stripInboundHeaders(inbound);
  if (forwardAuthorization && !stripConsumedAuthorization) {
    const authorization = inbound.get("authorization");
    if (authorization) out.set("authorization", authorization);
  }
  return out;
}

// The floor and nothing more: `default-src` is deliberately absent — apps
// (TanStack SSR hydration, analytics beacons) legitimately use inline
// scripts and external resources, and a perimeter that breaks every app gets
// turned off. Apps that want a stricter CSP set their own; the floor
// directives below are enforced either way.
const BASELINE_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/**
 * CSP directives the gateway guarantees on every HTML response, each with
 * the values an app may choose instead. Anything else an app sends is
 * overwritten to the floor value — an app returning `frame-ancestors *` must
 * not be able to remove the perimeter's framing protection. An app may frame
 * its own pages (`frame-ancestors 'self'`): every app has its own origin, so
 * that admits neither the gateway nor another app.
 */
const CSP_FLOOR: Record<string, { floor: string; allowed: string[] }> = {
  "frame-ancestors": { floor: "'none'", allowed: ["'none'", "'self'"] },
  "base-uri": { floor: "'self'", allowed: ["'none'", "'self'"] },
  "object-src": { floor: "'none'", allowed: ["'none'"] },
};

/** Merge an app-supplied CSP with the non-negotiable floor directives. */
export function enforceCspFloor(appCsp: string): string {
  const directives = new Map<string, string>();
  for (const raw of appCsp.split(";")) {
    const part = raw.trim();
    if (!part) continue;
    const space = part.indexOf(" ");
    const name = (space === -1 ? part : part.slice(0, space)).toLowerCase();
    const value = space === -1 ? "" : part.slice(space + 1).trim();
    directives.set(name, value);
  }
  for (const [name, { floor, allowed }] of Object.entries(CSP_FLOOR)) {
    const chosen = directives.get(name)?.toLowerCase();
    directives.set(name, chosen && allowed.includes(chosen) ? chosen : floor);
  }
  return [...directives.entries()]
    .map(([name, value]) => (value ? `${name} ${value}` : name))
    .join("; ");
}

/** Remove cross-subdomain scope from app cookies before they leave the proxy. */
export function stripSetCookieDomains(headers: Headers): void {
  const setCookies = headers.getSetCookie();
  if (setCookies.length === 0) return;

  headers.delete("set-cookie");
  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/gi, ""));
  }
}

// Two years, every subdomain, preload-eligible: right for an app host, whose
// subdomains are its own.
const DEFAULT_HSTS = "max-age=63072000; includeSubDomains; preload";

export interface SecurityHeaderOptions {
  /** Defaults to `strict-origin-when-cross-origin`. */
  referrerPolicy?: string;
  /**
   * The Strict-Transport-Security value. Defaults to two years with
   * `includeSubDomains; preload`. The control plane sends a plain `max-age`:
   * the gateway's host is often the customer's apex domain, and
   * includeSubDomains there would force HTTPS on every subdomain of it.
   */
  hsts?: string;
  /**
   * Strip `Domain=` from Set-Cookie (the default), so an app can never set a
   * cookie its sibling apps or the gateway would receive. The control plane
   * turns this off: it owns the session cookie, whose domain must span the
   * app subdomains.
   */
  stripCookieDomains?: boolean;
  /** Add `Cache-Control: no-store` (pages showing secrets or consent). */
  noStore?: boolean;
}

/**
 * Uniform security headers stamped on HTML responses. Apps may tighten the CSP
 * but the gateway guarantees this floor. Non-HTML responses (JSON/assets) get
 * the non-framing headers but not the HTML CSP.
 *
 * Every response also says `X-Robots-Tag: noindex, nofollow`: a gateway and
 * its apps are private applications, never pages for a search engine. It is
 * a header rather than a robots.txt Disallow so a crawler can still fetch a
 * page, see it, and drop a listing it already has.
 */
export function withSecurityHeaders(
  response: Response,
  options: SecurityHeaderOptions = {},
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");

  // Response headers are immutable on some platforms; clone to mutate safely.
  const headers = new Headers(response.headers);
  if (options.stripCookieDomains !== false) {
    stripSetCookieDomains(headers);
  }
  headers.set("Strict-Transport-Security", options.hsts ?? DEFAULT_HSTS);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set(
    "Referrer-Policy",
    options.referrerPolicy ?? "strict-origin-when-cross-origin",
  );
  if (options.noStore) {
    headers.set("Cache-Control", "no-store");
  }

  if (isHtml) {
    const appCsp = headers.get("content-security-policy");
    const csp = appCsp ? enforceCspFloor(appCsp) : BASELINE_CSP;
    headers.set("Content-Security-Policy", csp);
    if (/(^|;\s*)frame-ancestors 'self'(;|$)/.test(csp)) {
      headers.set("X-Frame-Options", "SAMEORIGIN");
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
