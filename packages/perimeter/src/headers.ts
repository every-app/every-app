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
 * Return a new Headers with the inbound Cookie and *all* `x-everyapp-*` headers
 * removed. The app never sees the user's session cookie, and a client cannot
 * smuggle a forged `x-everyapp-identity` past the gateway.
 */
export function stripInboundHeaders(inbound: Headers): Headers {
  const out = new Headers(inbound);
  out.delete("cookie");
  out.delete("authorization");
  for (const key of [...out.keys()]) {
    if (key.toLowerCase().startsWith(EVERYAPP_HEADER_PREFIX)) {
      out.delete(key);
    }
  }
  return out;
}

/**
 * Extract a reserved Every App bearer token, or null. This is the single
 * definition of "reserved credential" — the gateway's CSRF exemption, header
 * stripping, and the authenticator's PAT branch must all agree on it, or a
 * token one of them consumes could be forwarded or cookie-authenticated by
 * another. Scheme is case-insensitive per RFC 9110; the `epat_` prefix is
 * case-sensitive (an `EPAT_…` value is someone else's credential).
 */
export function extractEveryAppBearer(inbound: Headers): string | null {
  const token = extractBearerCredential(inbound);
  return token?.startsWith("epat_") ? token : null;
}

export function extractBearerCredential(inbound: Headers): string | null {
  const authorization = inbound.get("authorization");
  if (!authorization) return null;

  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  return token ? token : null;
}

export function hasEveryAppBearer(inbound: Headers): boolean {
  return extractEveryAppBearer(inbound) !== null;
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
 * CSP directives the gateway guarantees on every HTML response. Apps may add
 * or tighten directives, but these are always overwritten to the floor value —
 * an app returning `frame-ancestors *` must not be able to remove the
 * perimeter's framing protection.
 */
const CSP_FLOOR: Record<string, string> = {
  "frame-ancestors": "'none'",
  "base-uri": "'self'",
  "object-src": "'none'",
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
  for (const [name, value] of Object.entries(CSP_FLOOR)) {
    directives.set(name, value);
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

/**
 * Uniform security headers stamped on HTML responses. Apps may tighten the CSP
 * but the gateway guarantees this floor. Non-HTML responses (JSON/assets) get
 * the non-framing headers but not the HTML CSP.
 */
export function withSecurityHeaders(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");

  // Response headers are immutable on some platforms; clone to mutate safely.
  const headers = new Headers(response.headers);
  stripSetCookieDomains(headers);
  headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  if (isHtml) {
    const appCsp = headers.get("content-security-policy");
    headers.set(
      "Content-Security-Policy",
      appCsp ? enforceCspFloor(appCsp) : BASELINE_CSP,
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
