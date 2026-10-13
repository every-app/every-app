/**
 * Which Cloudflare zone a hostname is in. The gateway can live at any name
 * a zone in the account holds (`apps.company.com` in `company.com`), so the
 * zone is the longest of the name and its parents the account has.
 */
import { runCfJson, type CfRunner } from "@/lib/cf/runner";
import { ZoneListOutput } from "@/lib/cf/schemas";
import { EveryAppError } from "@/lib/errors";
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
  const found = await Promise.all(
    candidates.map(async (name) => {
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
  if (!zone) {
    throw new EveryAppError(
      "ZONE_NOT_FOUND",
      `No zone in this Cloudflare account holds ${host} (looked for ${candidates.join(", ")}). Use a domain that is on Cloudflare in this account: buy one in the dashboard (Domains, ${registerDomainUrl(accountId)}), or add one you own and point its nameservers at Cloudflare.`,
    );
  }
  if (zone.status && zone.status !== "active") {
    throw new EveryAppError(
      "ZONE_NOT_ACTIVE",
      `The Cloudflare zone ${zone.name} is ${zone.status}. Finish its nameserver setup first (Cloudflare dashboard → ${zone.name} → Overview), then run this again.`,
    );
  }
  return { id: zone.id, name: zone.name.toLowerCase() };
}

/** Every zone in the account, for picking one. */
export async function listZones(
  cf: CfRunner,
  accountId: string,
): Promise<ListedZone[]> {
  const zones: ListedZone[] = [];
  for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [
          "zones",
          "list",
          "--account-id",
          accountId,
          "--per-page",
          String(ZONE_PAGE_SIZE),
          "--page",
          String(page),
        ],
      },
      ZoneListOutput,
    );
    zones.push(
      ...batch.map((zone) => ({
        id: zone.id,
        name: zone.name.toLowerCase(),
        status: zone.status ?? null,
      })),
    );
    if (batch.length < ZONE_PAGE_SIZE) break;
  }
  return zones;
}
