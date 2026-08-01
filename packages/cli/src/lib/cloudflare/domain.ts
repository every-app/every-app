import chalk from "chalk";
import {
  isCloudflareAuthError,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare/auth";

interface Zone {
  id: string;
  name: string;
}

interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

interface VerifiedZone {
  id: string;
  name: string;
}

export async function verifyZoneOnAccount({
  accountId,
  domain,
}: {
  accountId: string;
  domain: string;
}): Promise<VerifiedZone> {
  const zones = await makeCloudflareAPIRequest<Zone[]>(
    `/zones?name=${encodeURIComponent(domain)}&account.id=${encodeURIComponent(accountId)}&per_page=50`,
  );
  const zone = zones.find((candidate) => candidate.name === domain);
  if (!zone) {
    throw new Error(
      `Cloudflare zone "${domain}" was not found on the authenticated account. Add the zone to this account or pass a different --domain.`,
    );
  }
  return zone;
}

type WildcardDnsResult = "exists" | "created" | "unauthorized";

interface DnsOverHttpsResponse {
  Status?: number;
  Answer?: unknown[];
}

/**
 * Ensure a proxied wildcard record exists so `*.<domain>` resolves through
 * Cloudflare and hits the gateway's wildcard route.
 *
 * The CLI's wrangler-style OAuth token has `zone:read` but usually NOT
 * `dns_records:*`, so a 403 here is expected on most accounts — that is
 * reported as "unauthorized" rather than thrown, and the caller prints
 * one-time manual instructions. The deploy itself (routes, worker) does not
 * depend on this call succeeding.
 */
export async function ensureProxiedWildcardDnsRecord({
  zoneId,
  domain,
}: {
  zoneId: string;
  domain: string;
}): Promise<WildcardDnsResult> {
  const wildcardName = `*.${domain}`;

  try {
    const existingRecords = await makeCloudflareAPIRequest<DnsRecord[]>(
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(wildcardName)}&per_page=100`,
    );

    // Any proxied wildcard record routes through Cloudflare — A, AAAA, or
    // CNAME with any target all work for Workers routes.
    const existing = existingRecords.find(
      (record) =>
        record.name === wildcardName &&
        ["A", "AAAA", "CNAME"].includes(record.type) &&
        record.proxied === true,
    );
    if (existing) {
      return "exists";
    }

    // A proxied CNAME to the apex: "any subdomain goes where the domain
    // goes". The record's target is never dialed — the Cloudflare proxy
    // intercepts and the wildcard Workers route handles the request. (This is
    // the documented pattern for wildcard→Worker routing; wildcard Custom
    // Domains don't exist: cloudflare/workers-sdk#5568.)
    await makeCloudflareAPIRequest<DnsRecord>(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: "*",
        content: domain,
        proxied: true,
        ttl: 1,
      }),
    });

    return "created";
  } catch (error) {
    if (isCloudflareAuthError(error)) {
      // The token can't read or write DNS records — check the EFFECT instead
      // of the record: if an arbitrary label under the wildcard resolves
      // through Cloudflare, the record is already in place and no manual
      // instructions are needed.
      if (
        await resolvesThroughCloudflare(`everyapp-wildcard-check.${domain}`)
      ) {
        return "exists";
      }
      return "unauthorized";
    }
    throw error;
  }
}

export async function resolvesThroughCloudflare(
  hostname: string,
): Promise<boolean> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", "A");

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/dns-json",
      },
    });
    if (!response.ok) {
      throw new Error(`Cloudflare DoH returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as DnsOverHttpsResponse;
    return (
      data.Status === 0 &&
      Array.isArray(data.Answer) &&
      data.Answer.length > 0
    );
  } catch (error) {
    console.log(
      chalk.dim(
        `  Could not verify DNS through Cloudflare DoH (${error instanceof Error ? error.message : String(error)}).`,
      ),
    );
    return false;
  }
}
