/**
 * Per-host sessions for third-party app hosts (hostRoutes.ts).
 *
 * Third-party apps live on a separate registrable domain, so the gateway's
 * Better Auth cookie never reaches them, and each app host keeps a session
 * of its own instead, started by a handoff with the control plane:
 *
 *  1. An unauthenticated page navigation on the app host gets a random
 *     nonce in a host-only `__Host-everyapp_n` cookie and a redirect to the
 *     control plane's `/app-session` with the page's URL and the nonce's
 *     hash.
 *  2. The control plane, signed in, checks the registry, the person's
 *     membership and their access to the app (`POST /app-session/start`),
 *     and sends them back with a code: a MAC token naming their gateway
 *     session, the app row, the host and the nonce's hash, good for 60
 *     seconds.
 *  3. The app host's perimeter exchanges the code at `/__everyapp/session`:
 *     once only, before it expires, on that host, for that app, and only in
 *     the browser holding the nonce (so nobody can sign a victim in to their
 *     own account by sending them a code). It sets `__Host-everyapp_s`, a MAC
 *     token bound to the gateway session id and the app row.
 *  4. Every request on the host verifies that token and re-checks, live, that
 *     the gateway session still exists and the person is still a member with
 *     access: signing out of the gateway, or losing the membership or the
 *     app, ends the host session too.
 *
 * `__Host-` cookies are host-only, Secure and Path=/, so a sibling app on
 * the same domain can neither read nor plant them; the perimeter also strips
 * any `__Host-everyapp_*` cookie an app tries to set, and credentialed CORS,
 * from app responses (stripThirdPartyAppHeaders).
 */

import { stripSetCookieDomains } from "./headers";

export const HOST_SESSION_COOKIE = "__Host-everyapp_s";
export const HOST_NONCE_COOKIE = "__Host-everyapp_n";
/** Where the app host's perimeter exchanges a handoff code. */
export const HOST_SESSION_PATH = "/__everyapp/session";
export const HANDOFF_CODE_TTL_SECONDS = 60;
/**
 * How long a host session cookie lives. Revocation doesn't wait for it:
 * every request re-checks the gateway session and the membership. It only
 * bounds how often a browser goes through the handoff again.
 */
export const HOST_SESSION_TTL_SECONDS = 24 * 60 * 60;
/** How long a started handoff may take, sign-in included. */
export const HOST_NONCE_TTL_SECONDS = 10 * 60;

/** Cookie names the perimeter reserves on third-party hosts (any case). */
const RESERVED_COOKIE_PREFIX = "__host-everyapp_";

/** What the control plane signs into a handoff code. */
export interface HandoffCodeClaims {
  typ: "code";
  /** The gateway (Better Auth) session id. */
  sid: string;
  /** The user id. */
  sub: string;
  /** The app's registry row id. */
  app: string;
  host: string;
  /** base64url SHA-256 of the nonce in the app host's nonce cookie. */
  nh: string;
  /** Path and query to land on after the exchange. */
  rt: string;
  /** Single-use id. */
  jti: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** What the app host's session cookie holds. */
export interface HostSessionClaims {
  typ: "session";
  sid: string;
  sub: string;
  app: string;
  host: string;
  iat: number;
  exp: number;
}

type HostTokenClaims = HandoffCodeClaims | HostSessionClaims;

/** The MAC key ({@link importHostSessionKey}); a WebCrypto key. */
export type HostSessionKey = Awaited<
  ReturnType<typeof crypto.subtle.deriveKey>
>;

const TOKEN_VERSION = "v1";
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The MAC key for codes and host sessions, derived from the gateway's
 * secret (BETTER_AUTH_SECRET) with HKDF under its own label, so it is
 * neither the secret itself nor any other key derived from it.
 */
export async function importHostSessionKey(
  secret: string,
): Promise<HostSessionKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("everyapp host session v1"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signHostToken(
  key: HostSessionKey,
  claims: HostTokenClaims,
): Promise<string> {
  const body = `${TOKEN_VERSION}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(mac))}`;
}

/**
 * The claims of a token this key signed, of the expected type and not
 * expired; null for anything else. A code is never a session, nor the
 * reverse.
 */
export async function verifyHostToken<T extends HostTokenClaims["typ"]>(
  key: HostSessionKey,
  token: string | null,
  typ: T,
  nowMs = Date.now(),
): Promise<Extract<HostTokenClaims, { typ: T }> | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const payload = fromBase64url(parts[1]!);
  const mac = fromBase64url(parts[2]!);
  if (!payload || !mac) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    (claims as { typ?: unknown }).typ !== typ
  ) {
    return null;
  }
  const exp = (claims as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp * 1000 <= nowMs) return null;
  return claims as Extract<HostTokenClaims, { typ: T }>;
}

/** A fresh nonce for the handoff (32 random bytes, base64url). */
export function newNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A fresh single-use id for a code. */
export function newCodeId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(nonce));
  return base64url(new Uint8Array(digest));
}

/** Whether a value has the shape of a nonce or its hash (32 bytes, base64url). */
export function isNonceValue(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * A cookie's value from the Cookie header, or null. The perimeter refuses a
 * request naming a session cookie twice before reading it (cookies.ts).
 */
export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get("cookie");
  if (!header) return null;
  for (const pair of header.split(/[;,]/)) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() === name) {
      return pair.slice(equals + 1).trim() || null;
    }
  }
  return null;
}

/**
 * A `__Host-` cookie: host-only, Secure, Path=/, HttpOnly. Lax, so it rides
 * the top-level navigation back from the control plane.
 */
export function hostCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/**
 * Where a handoff returns to on the app host: the page's path and query,
 * never the exchange path itself, and never a path starting `//`, which as
 * a Location would name another host.
 */
export function handoffReturnPath(url: URL): string {
  if (url.pathname === HOST_SESSION_PATH || url.pathname.startsWith("//")) {
    return "/";
  }
  return `${url.pathname}${url.search}`;
}

function isReservedSetCookie(cookie: string): boolean {
  return cookie.trimStart().toLowerCase().startsWith(RESERVED_COOKIE_PREFIX);
}

/**
 * What a third-party app may not say to the browser: credentialed CORS (a
 * sibling app on the same site could otherwise read this one's pages with
 * the visitor's host session), and the perimeter's own `__Host-everyapp_*`
 * cookies (the session and nonce, which only the perimeter sets).
 */
export function stripThirdPartyAppHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("access-control-allow-credentials");
  const setCookies = headers.getSetCookie();
  if (setCookies.some(isReservedSetCookie)) {
    headers.delete("set-cookie");
    for (const cookie of setCookies) {
      if (!isReservedSetCookie(cookie)) headers.append("set-cookie", cookie);
    }
  }
  // Browsers honour a WebSocket handshake's Set-Cookie too; rebuilt around
  // the same socket, as a 101 can't be rebuilt from its body. It never
  // reaches withSecurityHeaders, so its cookies lose `Domain` here: a
  // sibling app on the third-party domain would otherwise receive them.
  if (response.status === 101) {
    stripSetCookieDomains(headers);
    // Typed loosely: the CLI compiles this file without the Workers types.
    const { webSocket } = response as Response & { webSocket?: unknown };
    return new Response(null, {
      status: 101,
      statusText: response.statusText,
      webSocket,
      headers,
    } as ResponseInit);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
