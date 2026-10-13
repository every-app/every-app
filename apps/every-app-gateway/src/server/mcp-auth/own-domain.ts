/**
 * Client ids and redirect URIs on the gateway's own domain (its host, or an
 * app host under it) are refused wherever a client id is read: the
 * authorization endpoint, the consent page and the token endpoint, before
 * the library can fetch one as a Client ID Metadata Document.
 *
 * The `global_fetch_strictly_public` compatibility flag doesn't keep such a
 * fetch out: it sends a request for this zone out through Cloudflare's
 * front door like any request from the internet (never straight to an
 * origin behind it), and the front door is this gateway. A metadata
 * document served from an app's public route would then pass for a
 * verified client that looks like part of Every App.
 */

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3})$/;

export const ON_GATEWAY_DOMAIN =
  "This app uses an address on this gateway's own domain, which only Every App itself may use.";

/**
 * Whether a URL is on the gateway's own host or an app host under it. A
 * loopback gateway (local testing) is exempt: its local clients share
 * `localhost`.
 */
export function onGatewayDomain(value: string, issuer: string): boolean {
  const gateway = new URL(issuer).hostname;
  if (LOOPBACK_HOST.test(gateway)) return false;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === gateway || host.endsWith(`.${gateway}`);
}

/** A JWT's `iss`, read without verifying anything. */
function unverifiedIssuer(jwt: string): string | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const iss = (JSON.parse(json) as { iss?: unknown }).iss;
    return typeof iss === "string" ? iss : null;
  } catch {
    return null;
  }
}

/** HTTP Basic's user name, as sent and form-decoded (RFC 6749 §2.3.1). */
function basicUserNames(authorization: string | null): string[] {
  const credentials = /^basic\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!credentials) return [];
  let userName: string;
  try {
    userName = atob(credentials).split(":")[0] ?? "";
  } catch {
    return [];
  }
  try {
    return [userName, decodeURIComponent(userName.replace(/\+/g, " "))];
  } catch {
    return [userName];
  }
}

/**
 * Every client id a token (or revocation) request names, however it
 * authenticates: its `client_id` fields, HTTP Basic's user name, and a
 * client assertion's issuer, which identifies a `private_key_jwt` client
 * that omits `client_id`. The assertion is read, not verified: this only
 * decides what is never fetched.
 */
export function tokenRequestClientIds(
  headers: Headers,
  body: Uint8Array,
): string[] {
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const assertionIssuers = form
    .getAll("client_assertion")
    .map(unverifiedIssuer)
    .filter((iss): iss is string => iss !== null);
  return [
    ...form.getAll("client_id"),
    ...basicUserNames(headers.get("authorization")),
    ...assertionIssuers,
  ];
}
