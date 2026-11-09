/** `scheme://host[:port][/path]` with the default port dropped and no trailing slash, for comparing
 * origins and issuers (HelperCore OAuthClient.normalized). Unparseable input comes back trimmed. */
export function normalized(input: string | URL): string {
  let s = String(input).trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  let path = u.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  // WHATWG URL already lowercases scheme and host and drops default ports.
  return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`;
}

/** scheme://host[:port], no path: what `resource` and the API base are made of. */
export function originOf(input: string | URL): string | undefined {
  try {
    const u = new URL(String(input));
    if (!u.host || (u.protocol !== "https:" && u.protocol !== "http:")) return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** What a person types as the app URL: adds https:// when there's no scheme and wants a host.
 * Plain http only for local development. Returns the origin. */
export function typedAppUrl(text: string): string | undefined {
  let s = text.trim();
  if (!s) return undefined;
  if (!s.includes("://")) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (!u.hostname) return undefined;
  if (u.protocol === "http:" && !LOCAL_HOSTS.has(u.hostname) && !u.hostname.endsWith(".localhost")) return undefined;
  return `${u.protocol}//${u.host}`;
}

/** A URL the sign-in may send a person or a secret to: https, or plain http only on the local
 * hosts typedAppUrl allows (development). A Gateway's advertised endpoints and the endpoints kept in
 * a stored grant are checked with it, so a hostile app can't point the browser at another scheme or
 * have the code and verifier posted in the clear. */
export function isSignInEndpoint(input: string | undefined): boolean {
  if (!input) return false;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (!u.hostname) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost"));
}

/** RFC 8414 §3.1: the well-known segment goes between the host and the issuer's path. */
export function authorizationServerMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  let path = u.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol}//${u.host}/.well-known/oauth-authorization-server${path}`;
}
