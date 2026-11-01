/** RFC 8252 §7.3 loopback: `localhost`, 127.0.0.0/8 and `::1`. */
function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "[::1]") {
    return true;
  }
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  return ipv4 !== null && ipv4.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Whether a Client ID Metadata Document client's domain covers where it
 * sends access: that host, a subdomain of it, or an app on this computer.
 * Only then is "Published by <domain>" shown as verified. A metadata
 * document is just a file on that domain, and plenty of big domains host
 * anyone's files (a gist, a storage bucket): its domain mustn't vouch for
 * access sent to a site of the uploader's choosing.
 */
export function domainCoversRedirect(
  domain: string,
  redirectHost: string,
): boolean {
  const site = domain.toLowerCase();
  const host = redirectHost.toLowerCase();
  return host === site || host.endsWith(`.${site}`) || isLoopbackHost(host);
}
