/**
 * Checks before a deploy publishes new Workers Custom Domains on the gateway.
 *
 * cf publishes a Worker's Custom Domains as one list, and when nobody is at
 * a terminal it replaces any DNS record that holds a hostname, and moves a
 * hostname another Worker serves to this one, without asking. So before a
 * deploy adds a hostname:
 *   1. no A, AAAA, CNAME or NS record may answer it (unless --force-dns):
 *      not one at the name, which cf would replace along with whatever it
 *      served (mail and TXT records stay, next to the Custom Domain), and
 *      not a wildcard (`*.<parent>`) over a name with no records of its
 *      own, whose answer for that name publishing takes over;
 *   2. the zone must have room: Cloudflare allows 100 Custom Domains in a
 *      zone.
 * cf can't list which Worker holds a Custom Domain: attached to a terminal
 * (--verbose) cf asks before moving one, and otherwise this warns.
 */
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { describeRecord, dnsRecordsAt, wildcardOver } from "./records";
import type { Zone } from "./zones";

/** Records a Custom Domain replaces, or (NS: a delegation) can't live next to. */
const CONFLICTING_TYPES = new Set(["A", "AAAA", "CNAME", "NS"]);

const ZONE_CUSTOM_DOMAIN_LIMIT = 100;
const ZONE_CUSTOM_DOMAIN_WARN_AT = 95;

interface DomainPreflightOptions {
  cf: CfRunner;
  out: EventSink;
  step: string;
  zone: Zone;
  /**
   * Every hostname the gateway is published under after the deploy (the
   * whole list: cf removes the rest).
   */
  domains: readonly string[];
  /** Hostnames already published on the gateway, or checked: never a conflict. */
  liveDomains: readonly string[];
  /** Publish new hostnames over the DNS records that answer them. */
  forceDns?: boolean;
  /** cf runs attached to a person's terminal, where it asks before taking a hostname. */
  cfAsks: boolean;
}

/**
 * Check the hostnames `domains` adds to `liveDomains`; returns them. Throws
 * DNS_RECORD_CONFLICT or ZONE_CUSTOM_DOMAIN_LIMIT.
 */
export async function preflightDomains(
  options: DomainPreflightOptions,
): Promise<string[]> {
  const live = new Set(options.liveDomains);
  const added = [...new Set(options.domains)].filter((host) => !live.has(host));
  if (added.length === 0) return [];
  const { out, step, zone } = options;

  // Other Workers' Custom Domains in the zone count too, but can't be listed.
  const total = new Set(options.domains).size;
  if (total > ZONE_CUSTOM_DOMAIN_LIMIT) {
    throw new EveryAppError(
      "ZONE_CUSTOM_DOMAIN_LIMIT",
      `This would put ${total} Workers Custom Domains in ${zone.name}; Cloudflare allows ${ZONE_CUSTOM_DOMAIN_LIMIT} per zone. Delete apps you no longer use (${CLI} delete <id>), or install a second gateway on another domain.`,
    );
  }
  if (total >= ZONE_CUSTOM_DOMAIN_WARN_AT) {
    out.emit({
      type: "warning",
      code: "ZONE_CUSTOM_DOMAIN_LIMIT_NEAR",
      step,
      message: `${zone.name} will hold at least ${total} of the ${ZONE_CUSTOM_DOMAIN_LIMIT} Workers Custom Domains Cloudflare allows in a zone (other Workers' domains there count too).`,
    });
  }

  await checkDnsRecords(options, added);

  if (!options.cfAsks) {
    out.emit({
      type: "warning",
      code: "CUSTOM_DOMAIN_OWNER_UNCHECKED",
      step,
      message: `If another Worker already serves ${added.length === 1 ? added[0] : `any of ${added.join(", ")}`}, it will be replaced by this deployment.`,
      data: { hosts: added },
    });
  }
  return added;
}

/** The records at `host` in the zone, through the Cloudflare API. */
async function recordsAt(
  { cf, zone, forceDns }: DomainPreflightOptions,
  host: string,
) {
  try {
    return await dnsRecordsAt(cf, zone.id, host);
  } catch (error) {
    if (!(error instanceof CfError && error.kind === "auth")) throw error;
    if (forceDns) return [];
    throw new EveryAppError(
      "DNS_UNREADABLE",
      `Can't read ${zone.name}'s DNS records with this Cloudflare login, so can't tell whether publishing ${host} would replace one. Give the API token Zone → DNS → Read, or pass --force-dns to publish without checking.`,
    );
  }
}

/**
 * Refuse new hostnames that a record answers, at the name itself or as the
 * wildcard over a name with no records of its own.
 */
async function checkDnsRecords(
  options: DomainPreflightOptions,
  added: string[],
): Promise<void> {
  const { out, step, zone, forceDns } = options;
  // Each hostname a record answers, and the records that answer it.
  const conflicts: Array<{ host: string; records: string }> = [];
  let viaWildcard = false;
  const answering = (records: Array<{ type: string }>) =>
    records.filter((r) => CONFLICTING_TYPES.has(r.type.toUpperCase()));
  // Each wildcard is read once: app hosts share their parent.
  const wildcards = new Map<string, ReturnType<typeof recordsAt>>();
  for (const host of added) {
    const records = await recordsAt(options, host);
    const conflicting = answering(records);
    if (conflicting.length > 0) {
      conflicts.push({ host, records: conflicting.map(describeRecord).join(", ") });
    }
    // A name with no records of its own is answered by the wildcard over
    // it (the zone's apex has none over it in the zone).
    if (records.length === 0 && host !== zone.name) {
      const name = wildcardOver(host);
      if (!wildcards.has(name)) wildcards.set(name, recordsAt(options, name));
      const covering = answering(await wildcards.get(name)!);
      if (covering.length > 0) {
        conflicts.push({ host, records: `${covering.map(describeRecord).join(", ")}, through ${name}` });
        viaWildcard = true;
      }
    }
  }
  if (conflicts.length === 0) return;
  const one = conflicts.length === 1;
  const which = one
    ? `${conflicts[0]!.host} already points somewhere else`
    : `${conflicts.length} hostnames already point somewhere else`;
  const records = one
    ? `Its DNS record: ${conflicts[0]!.records}.`
    : `${conflicts.map((c) => `${c.host} (${c.records})`).join("; ")}.`;
  const wildcardStays = viaWildcard
    ? " A wildcard record stays, and keeps answering every other name."
    : "";
  if (forceDns) {
    out.emit({
      type: "warning",
      code: "DNS_RECORD_REPLACED",
      step,
      message: `${which}\n${records} --force-dns: the Gateway's Custom Domain${one ? " takes it" : "s take them"} over.${wildcardStays}`,
    });
    return;
  }
  throw new EveryAppError(
    "DNS_RECORD_CONFLICT",
    `${which}\n${records} Publishing ${one ? "it replaces the record" : "them replaces those records"}.${wildcardStays}`,
    {
      data: {
        fix: `delete ${one ? "the record" : "the records"} in Cloudflare (${zone.name} → DNS), or use another name`,
      },
    },
  );
}
