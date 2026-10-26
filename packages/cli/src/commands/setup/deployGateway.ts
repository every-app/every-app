/**
 * Installing or upgrading the Gateway for `everyapp setup` (and `deploy`,
 * when it installs one): where it goes, then the release this checkout
 * builds, deployed through lib/gateway/apply.ts, and the new hostnames'
 * certificates.
 */
import { cliVersion } from "@/lib/version";
import { cfD1Database } from "@/lib/cf/d1";
import { waitForCertificates } from "@/lib/domains/certWait";
import {
  findZone,
  listZones,
  registerDomainUrl,
  zoneUrl,
  type Zone,
} from "@/lib/domains/zones";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import {
  applyGateway,
  type ApplyGatewayOptions,
  type ApplyGatewayResult,
} from "@/lib/gateway/apply";
import type { InstallRecord } from "@/lib/gateway/install";
import type { GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources, existingGatewayResources } from "@/lib/gateway/resources";
import { CLI, thisCommandWithout } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";

/** Where a deploy goes: the install's own settings, or a new install's. */
interface GatewayTarget {
  domain: string;
  zone: Zone;
  appBaseDomain: string;
}

export async function gatewayTarget({
  cf,
  accountId,
  install,
  domain,
  out,
}: {
  cf: CfRunner;
  accountId: string;
  install: InstallRecord | null;
  domain: string;
  out: EventSink;
}): Promise<GatewayTarget> {
  // An install that never finished its first upload can still go elsewhere.
  if (install && (install.liveVersionId !== null || install.gatewayHost === domain)) {
    if (install.gatewayHost !== domain) {
      throw new EveryAppError(
        "DOMAIN_CHANGE_UNSUPPORTED",
        `The Gateway can't move to ${domain}\nIt's installed at ${install.gatewayHost}, and moving an installed Gateway isn't supported.`,
        {
          rerun: thisCommandWithout("--domain"),
          rerunNote: "(without --domain) to update it where it is",
        },
      );
    }
    return {
      domain,
      zone: { id: install.zoneId, name: install.zoneName },
      appBaseDomain: install.appBaseDomain,
    };
  }
  const zone = await gatewayZone(cf, domain, accountId);
  warnIfZoneApex(domain, zone, out);
  return { domain, zone, appBaseDomain: domain };
}

/**
 * The active zone `domain` is in. None: the account's domains to choose
 * from. One whose nameservers aren't Cloudflare's yet: finishing that is
 * the person's to do (`add_domain`), then the same command.
 */
async function gatewayZone(cf: CfRunner, domain: string, accountId: string): Promise<Zone> {
  const zone = await findZone(cf, domain, accountId);
  if (!zone) {
    const active = (await listZones(cf, accountId))
      .filter((listed) => !listed.status || listed.status === "active")
      .map((listed) => listed.name);
    throw new EveryAppError(
      "ZONE_NOT_FOUND",
      `${domain} isn't under a domain in this Cloudflare account${
        active.length > 0 ? `\nThis account's domains: ${active.join(", ")}` : ""
      }`,
      {
        fix:
          active.length > 0
            ? `use a name under one of them, or add ${domain}'s domain to Cloudflare`
            : `add ${domain}'s domain to Cloudflare`,
        data: { url: registerDomainUrl(accountId), zones: active },
      },
    );
  }
  if (zone.status && zone.status !== "active") {
    throw new ActionRequiredError(
      "add_domain",
      `Finish activating ${zone.name} on Cloudflare\nIts nameservers don't point at Cloudflare yet.`,
      zoneUrl(accountId, zone.name),
      { data: { zone: zone.name, status: zone.status } },
    );
  }
  return { id: zone.id, name: zone.name };
}

/**
 * Deploy `release` to `target`: the gateway's resources, the deploy pipeline
 * (lib/gateway/apply.ts), then the new hostnames' certificates.
 */
export async function deployGatewayRelease({
  cf,
  out,
  reason,
  release,
  accountId,
  target,
  interactive,
  existing,
  ...options
}: {
  cf: CfRunner;
  out: EventSink;
  reason: "deploy" | "upgrade";
  release: GatewayRelease;
  accountId: string;
  target: GatewayTarget;
  interactive: boolean;
  /**
   * `update`: the Gateway database discovery found. Its resources must
   * still be there, that same database; nothing is created, so an update
   * never installs a Gateway (GATEWAY_NOT_FOUND otherwise).
   */
  existing?: { databaseId: string };
} & Pick<
  ApplyGatewayOptions,
  | "forceDns"
  | "allowDowngrade"
  | "allowDowngradeFlag"
  | "confirm"
  | "sleep"
  | "leaseWaitMs"
  | "deploymentMode"
  | "checkedDomains"
> & {
    certificates?: Pick<
      Parameters<typeof waitForCertificates>[0],
      "probe" | "sleep" | "maxWaitMs"
    >;
  }): Promise<{ result: ApplyGatewayResult; db: D1Database }> {
  const { certificates, ...applyOptions } = options;
  const resources = existing ? await existingGatewayResources(cf) : await ensureGatewayResources(cf);
  if (!resources || (existing && resources.d1Id !== existing.databaseId)) {
    throw new EveryAppError(
      "GATEWAY_NOT_FOUND",
      `The Gateway at ${target.domain} is gone\nIts ${resources ? "database was replaced" : "database or KV namespace was deleted"} after this run found it. An update never installs a Gateway, so nothing was changed.`,
      {
        rerun: `${CLI} setup --domain ${target.domain}`,
        rerunNote: "to install one",
        data: { accounts: [{ id: accountId, name: null }], host: target.domain },
      },
    );
  }
  out.emit({
    type: "step",
    step: "gateway.resources",
    status: "ok",
    message: resources.created.length
      ? `Created ${resources.created.join(", ")}`
      : "The Gateway's database and KV namespace are there",
  });
  const db = cfD1Database(cf, resources.d1Id);
  const result = await applyGateway({
    cf,
    out,
    reason,
    release,
    accountId,
    gatewayHost: target.domain,
    zone: target.zone,
    appBaseDomain: target.appBaseDomain,
    resources,
    db,
    interactive,
    cliVersion,
    ...applyOptions,
  });

  await waitForCertificates({
    hosts: result.newHosts,
    out,
    step: "gateway.tls",
    ...certificates,
  });
  return { result, db };
}

/**
 * The session cookie covers the app base domain and everything below it:
 * at a zone's apex, that is every subdomain of the company's domain.
 */
function warnIfZoneApex(domain: string, zone: Zone, out: EventSink): void {
  if (domain !== zone.name) return;
  out.emit({
    type: "warning",
    code: "GATEWAY_AT_ZONE_APEX",
    message: `The Gateway's sign-in cookie will cover every subdomain of ${zone.name}\nApps take names directly below it too. Unless the domain is only for EveryApp,\ninstall on a subdomain instead, e.g. --domain apps.${zone.name}`,
    data: { suggestedDomain: `apps.${zone.name}` },
  });
}
