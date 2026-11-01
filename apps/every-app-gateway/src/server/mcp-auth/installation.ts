/** RFC 8252 §7.3 loopback: `localhost`, 127.0.0.0/8 and `::1`. */
function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return ipv4 !== null && ipv4.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Whether two redirect URIs of a Client ID Metadata Document client (one
 * client id for every installation) come from the same installation. An app
 * on the user's computer (a loopback redirect, RFC 8252 §7.3) listens on a
 * new port each time it connects (Claude Code does), so the port doesn't
 * count: scheme, host, path and query must match, as when the library
 * matches a loopback redirect to a registered one. Any other redirect URI
 * must match exactly.
 */
export function sameInstallation(a: string, b: string): boolean {
  if (a === b) return true;
  let first: URL;
  let second: URL;
  try {
    first = new URL(a);
    second = new URL(b);
  } catch {
    return false;
  }
  return (
    isLoopbackUrl(first) &&
    isLoopbackUrl(second) &&
    first.protocol === second.protocol &&
    first.hostname === second.hostname &&
    first.pathname === second.pathname &&
    first.search === second.search
  );
}
