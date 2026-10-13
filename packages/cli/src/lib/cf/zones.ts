import { EveryAppError } from "@/lib/errors";
import { runCfJson, type CfRunner } from "./runner";
import { ZoneListOutput } from "./schemas";

interface Zone {
  id: string;
  name: string;
}

/**
 * The account's Cloudflare zone for `domain`. The gateway serves at the
 * zone's apex for now, with apps one label below it.
 */
export async function findZone(
  cf: CfRunner,
  domain: string,
  accountId: string,
): Promise<Zone> {
  const zones = await runCfJson(
    cf,
    {
      plane: "account",
      args: ["zones", "list", "--name", domain, "--account-id", accountId],
    },
    ZoneListOutput,
  );
  const zone = zones.find((candidate) => candidate.name === domain);
  if (!zone) {
    throw new EveryAppError(
      "ZONE_NOT_FOUND",
      `Cloudflare zone "${domain}" isn't in this account. Add the domain to the account, or pass a different --domain.`,
    );
  }
  if (zone.status && zone.status !== "active") {
    throw new EveryAppError(
      "ZONE_NOT_ACTIVE",
      `Cloudflare zone "${domain}" is ${zone.status}. Finish its nameserver setup first.`,
    );
  }
  return { id: zone.id, name: zone.name };
}
