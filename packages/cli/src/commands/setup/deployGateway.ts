/**
 * Installing or upgrading the Gateway for `everyapp setup` (and `deploy`,
 * when it installs one): where it goes, then the release this checkout
 * builds, deployed through lib/gateway/apply.ts, and the new hostnames'
 * certificates.
 */
import { version as cliVersion } from "../../../package.json";
import { cfD1Database } from "@/lib/cf/d1";
import { waitForCertificates } from "@/lib/domains/certWait";
import { resolveZone, type Zone } from "@/lib/domains/zones";
import { EveryAppError } from "@/lib/errors";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import {
  applyGateway,
  type ApplyGatewayOptions,
  type ApplyGatewayResult,
} from "@/lib/gateway/apply";
import type { InstallRecord } from "@/lib/gateway/install";
import type { GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
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
        `This gateway is installed at ${install.gatewayHost}; moving it to ${domain} isn't supported.`,
      );
    }
    return {
      domain,
      zone: { id: install.zoneId, name: install.zoneName },
      appBaseDomain: install.appBaseDomain,
    };
  }
  const zone = await resolveZone(cf, domain, accountId);
  warnIfZoneApex(domain, zone, out);
  return { domain, zone, appBaseDomain: domain };
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
  ...options
}: {
  cf: CfRunner;
  out: EventSink;
  reason: "deploy" | "upgrade";
  release: GatewayRelease;
  accountId: string;
  target: GatewayTarget;
  interactive: boolean;
} & Pick<
  ApplyGatewayOptions,
  | "forceDns"
  | "allowDowngrade"
  | "allowDowngradeFlag"
  | "confirm"
  | "sleep"
  | "leaseWaitMs"
> & {
    certificates?: Pick<
      Parameters<typeof waitForCertificates>[0],
      "isReady" | "sleep" | "maxWaitMs"
    >;
  }): Promise<{ result: ApplyGatewayResult; db: D1Database }> {
  const { certificates, ...applyOptions } = options;
  const resources = await ensureGatewayResources(cf);
  out.emit({
    type: "step",
    step: "gateway.resources",
    status: "ok",
    message: resources.created.length
      ? `Created ${resources.created.join(", ")}.`
      : "The gateway's D1 database and KV namespaces are ready.",
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
    message: `The gateway will serve at ${zone.name} itself, so its sign-in cookie covers every subdomain of ${zone.name}, and apps take names directly below it. Unless ${zone.name} is only for Every App, install on a subdomain instead: --domain apps.${zone.name}.`,
  });
}
