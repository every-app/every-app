/**
 * Which Cloudflare zone a hostname is in. The gateway can live at any name
 * a zone in the account holds (`apps.company.com` in `company.com`), so the
 * zone is the longest of the name and its parents the account has.
 */
import { listAll, runCfJson, type CfRunner } from "@/lib/cf/runner";
import { ZoneListOutput } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";
import { zoneCandidates } from "./hostnames";

export interface Zone {
  id: string;
  name: string;
}

interface ListedZone extends Zone {
  status: string | null;
}

const ZONE_PAGE_SIZE = 50;
const MAX_ZONE_PAGES = 20;

/**
 * Where to buy a domain in the Cloudflare dashboard: the account's Domains
 * page (Cloudflare Registrar). A Worker's own Domains tab sells them too,
 * but a new account has no Worker yet.
 */
export function registerDomainUrl(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/domains/overview`;
}

/**
 * The zone `host` belongs to: the longest of `host` and its parents that is
 * a zone in the account. It must be active (nameservers pointed at
 * Cloudflare), or Custom Domains can't be created in it.
 */
export async function resolveZone(
  cf: CfRunner,
  host: string,
  accountId: string,
): Promise<Zone> {
  const candidates = zoneCandidates(host);
  const zone = await findZone(cf, host, accountId);
  if (!zone) {
    throw new EveryAppError(
      "ZONE_NOT_FOUND",
      `No zone in this Cloudflare account holds ${host}\nLooked for ${candidates.join(", ")}. Buy a domain in the dashboard (Domains, ${registerDomainUrl(accountId)}), or add one you own and point its nameservers at Cloudflare.`,
      { fix: "use a domain that is on Cloudflare in this account" },
    );
  }
  if (zone.status && zone.status !== "active") {
    throw new EveryAppError(
      "ZONE_NOT_ACTIVE",
      `The Cloudflare zone ${zone.name} is ${zone.status}, not active`,
      {
        fix: `finish its nameserver setup (Cloudflare dashboard → ${zone.name} → Overview)`,
        rerun: thisCommand(),
      },
    );
  }
  return { id: zone.id, name: zone.name };
}

/** The zone `host` belongs to, whatever its status, or null when the account has none. */
export async function findZone(
  cf: CfRunner,
  host: string,
  accountId: string,
): Promise<ListedZone | null> {
  const found = await Promise.all(
    zoneCandidates(host).map(async (name) => {
      const zones = await runCfJson(
        cf,
        {
          plane: "account",
          args: ["zones", "list", "--name", name, "--account-id", accountId],
        },
        ZoneListOutput,
      );
      return zones.find((zone) => zone.name.toLowerCase() === name) ?? null;
    }),
  );
  const zone = found.find((candidate) => candidate !== null);
  return zone
    ? { id: zone.id, name: zone.name.toLowerCase(), status: zone.status ?? null }
    : null;
}

/** A zone's own page in the dashboard, where its nameservers are. */
export function zoneUrl(accountId: string, zone: string): string {
  return `https://dash.cloudflare.com/${accountId}/${zone}`;
}

/** Every zone in the account, for picking one. */
export async function listZones(
  cf: CfRunner,
  accountId: string,
): Promise<ListedZone[]> {
  const zones = await listAll(
    cf,
    ["zones", "list", "--account-id", accountId],
    ZoneListOutput,
    { perPage: ZONE_PAGE_SIZE, maxPages: MAX_ZONE_PAGES },
  );
  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name.toLowerCase(),
    status: zone.status ?? null,
  }));
}
