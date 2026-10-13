/**
 * Checks before a deploy publishes new Workers Custom Domains on the gateway.
 *
 * cf publishes a Worker's Custom Domains as one list, and when nobody is at
 * a terminal it replaces any DNS record that holds a hostname, and moves a
 * hostname another Worker serves to this one, without asking. So before a
 * deploy adds a hostname:
 *   1. no A, AAAA, CNAME or NS record may exist at it (unless --force-dns):
 *      cf would replace it, and with it whatever the record served (mail
 *      and TXT records stay, next to the Custom Domain). A name with no
 *      records of its own that a wildcard (`*.<parent>`) answers gets a
 *      warning: publishing it takes the name from whatever the wildcard
 *      serves, which keeps answering every other name;
 *   2. CAA records must let Cloudflare's CAs issue its certificate
 *      (./caa.ts), or the hostname never gets one; records that allow them
 *      only for one ACME account or validation method get a warning;
 *   3. the zone must have room: Cloudflare allows 100 Custom Domains in a
 *      zone.
 * cf can't list which Worker holds a Custom Domain: at a terminal cf asks
 * before moving one, and an unattended run says it can't check.
 */
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { caaFixHint, checkCaa, dohCaaLookup, type CaaLookup } from "./caa";
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
  /** Replace DNS records at new hostnames, and publish past a CAA block. */
  forceDns?: boolean;
  /** A person is at a terminal, where cf asks before taking a hostname. */
  interactive: boolean;
  lookupCaa?: CaaLookup;
}

/**
 * Check the hostnames `domains` adds to `liveDomains`; returns them. Throws
 * DNS_RECORD_CONFLICT, CAA_BLOCKS_ISSUANCE or ZONE_CUSTOM_DOMAIN_LIMIT.
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
      `This would put ${total} Workers Custom Domains in ${zone.name}; Cloudflare allows ${ZONE_CUSTOM_DOMAIN_LIMIT} per zone. Delete apps you no longer use (everyapp app delete), or install a second gateway on another domain.`,
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

  const withRecords = await checkDnsRecords(options, added);
  await checkCertificateAuthorities(options, added, withRecords);

  if (!options.interactive) {
    out.emit({
      type: "warning",
      code: "CUSTOM_DOMAIN_OWNER_UNCHECKED",
      step,
      message: `Publishing ${added.join(", ")} on the gateway. cf can't list which Worker holds a Custom Domain, and unattended it moves one to the gateway without asking: if another Worker in this account serves ${added.length === 1 ? "this hostname" : "one of these"}, it stops serving it. A run in a terminal asks first.`,
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
 * Refuse new hostnames that hold records a Custom Domain would replace,
 * and say which ones a wildcard answers now; returns those that hold any
 * record at all.
 */
async function checkDnsRecords(
  options: DomainPreflightOptions,
  added: string[],
): Promise<Set<string>> {
  const { out, step, zone, forceDns } = options;
  const conflicts: string[] = [];
  const withRecords = new Set<string>();
  const answering = (records: Array<{ type: string }>) =>
    records.filter((r) => CONFLICTING_TYPES.has(r.type.toUpperCase()));
  // Each wildcard is read once: app hosts share their parent.
  const wildcards = new Map<string, ReturnType<typeof recordsAt>>();
  const underWildcard: string[] = [];
  const wildcardHosts: string[] = [];
  for (const host of added) {
    const records = await recordsAt(options, host);
    if (records.length > 0) withRecords.add(host);
    const conflicting = answering(records);
    if (conflicting.length > 0) {
      conflicts.push(`${host} (${conflicting.map(describeRecord).join(", ")})`);
    }
    // A name with no records of its own is answered by the wildcard over
    // it (the zone's apex has none over it in the zone).
    if (records.length === 0 && host !== zone.name) {
      const name = wildcardOver(host);
      if (!wildcards.has(name)) wildcards.set(name, recordsAt(options, name));
      const covering = answering(await wildcards.get(name)!);
      if (covering.length > 0) {
        underWildcard.push(
          `${host} (${name}: ${covering.map(describeRecord).join(", ")})`,
        );
        wildcardHosts.push(host);
      }
    }
  }
  if (underWildcard.length > 0) {
    const one = wildcardHosts.length === 1;
    out.emit({
      type: "warning",
      code: "DNS_WILDCARD_ANSWERS",
      step,
      message: `${one ? "A hostname the gateway is about to serve is answered now by a wildcard record" : "Hostnames the gateway is about to serve are answered now by wildcard records"}: ${underWildcard.join("; ")}. Publishing ${one ? "it" : "them"} on the gateway takes ${one ? "that name" : "those names"} from whatever the wildcard serves; it keeps answering every other name.`,
      data: { hosts: wildcardHosts },
    });
  }
  if (conflicts.length === 0) return withRecords;
  const which = `${conflicts.length === 1 ? "A hostname the gateway is about to serve already has a DNS record" : "Hostnames the gateway is about to serve already have DNS records"}: ${conflicts.join("; ")}.`;
  if (forceDns) {
    out.emit({
      type: "warning",
      code: "DNS_RECORD_REPLACED",
      step,
      message: `${which} --force-dns: Cloudflare replaces ${conflicts.length === 1 ? "it" : "them"} with the gateway's Custom Domain.`,
    });
    return withRecords;
  }
  throw new EveryAppError(
    "DNS_RECORD_CONFLICT",
    `${which} Publishing the gateway there would replace ${conflicts.length === 1 ? "it" : "them"}, and whatever ${conflicts.length === 1 ? "it serves" : "they serve"}. Remove ${conflicts.length === 1 ? "the record" : "the records"} (Cloudflare dashboard → ${zone.name} → DNS), choose another name, or pass --force-dns to replace ${conflicts.length === 1 ? "it" : "them"}.`,
  );
}

async function checkCertificateAuthorities(
  { out, step, zone, forceDns, lookupCaa }: DomainPreflightOptions,
  added: string[],
  withRecords: Set<string>,
): Promise<void> {
  const lookup = cachedLookup(lookupCaa ?? dohCaaLookup());
  const blocked: string[] = [];
  const narrowed: string[] = [];
  const narrowedHosts: string[] = [];
  const unchecked: string[] = [];
  let fix = "";
  let narrowedFix = "";
  for (const host of added) {
    // A hostname with no record in the zone has no CAA record either, and
    // asking a public resolver about it would have it remember "no such
    // name" for up to the zone's negative TTL, right before it goes live.
    const result = await checkCaa(host, lookup, {
      fromParent: !withRecords.has(host) && host !== zone.name,
    });
    if (result.status === "unknown") unchecked.push(host);
    if (result.status === "blocked") {
      blocked.push(
        `${host} (CAA at ${result.at} allows ${result.issuers.length ? result.issuers.join(", ") : "no certificate authority Cloudflare uses"})`,
      );
      fix ||= caaFixHint(result.at);
    }
    if (result.status === "narrowed") {
      narrowed.push(
        `${host} (CAA at ${result.at} allows ${result.issuers.join(", ")} only with ${result.parameters.join(" and ")})`,
      );
      narrowedHosts.push(host);
      narrowedFix ||= caaFixHint(result.at);
    }
  }
  if (unchecked.length > 0) {
    out.emit({
      type: "warning",
      code: "CAA_UNCHECKED",
      step,
      message: `Couldn't read the CAA records for ${unchecked.join(", ")} (DNS-over-HTTPS unreachable). If the zone restricts certificate authorities, allow Cloudflare's, or the certificate won't be issued.`,
    });
  }
  if (narrowed.length > 0) {
    out.emit({
      type: "warning",
      code: "CAA_MAY_BLOCK_ISSUANCE",
      step,
      message: `Cloudflare may not get a certificate for ${narrowed.join("; ")}: those parameters allow only one ACME account or some validation methods, which may not be the ones Cloudflare's certificate authority uses. If the certificate doesn't come, ${narrowedFix}, without them.`,
      data: { hosts: narrowedHosts },
    });
  }
  if (blocked.length === 0) return;
  const message = `Cloudflare can't issue a certificate for ${blocked.join("; ")}. To fix it, ${fix}.`;
  if (forceDns) {
    out.emit({ type: "warning", code: "CAA_BLOCKS_ISSUANCE", step, message });
    return;
  }
  throw new EveryAppError(
    "CAA_BLOCKS_ISSUANCE",
    `${message} Or pass --force-dns to publish anyway.`,
  );
}

/** One lookup per name for the whole preflight (hostnames share parents). */
function cachedLookup(lookup: CaaLookup): CaaLookup {
  const known = new Map<string, ReturnType<CaaLookup>>();
  return (name) => {
    let records = known.get(name);
    if (!records) {
      records = lookup(name);
      known.set(name, records);
    }
    return records;
  };
}
