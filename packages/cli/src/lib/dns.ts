/**
 * Whether a hostname resolves through Cloudflare, asked of Cloudflare's
 * public DNS-over-HTTPS resolver (no Cloudflare credentials involved).
 */
export async function resolvesThroughCloudflare(
  hostname: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", "A");
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as {
      Status?: number;
      Answer?: unknown[];
    };
    return (
      data.Status === 0 && Array.isArray(data.Answer) && data.Answer.length > 0
    );
  } catch {
    return false;
  }
}
