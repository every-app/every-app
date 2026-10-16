/**
 * `everyapp gateway deploy` and `upgrade`: deploy a release built from this
 * checkout. Deploy also installs a new gateway; upgrade needs one that this
 * CLI deployed before and does nothing when it already runs this release.
 * Neither moves a gateway to an older release without --allow-downgrade.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { cfD1Database } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { waitForCertificates } from "@/lib/domains/certWait";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { resolveZone, type Zone } from "@/lib/domains/zones";
import { EveryAppError } from "@/lib/errors";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import {
  applyGateway,
  downgradeRefused,
  notDeployedByEveryapp,
  olderThanInstalled,
  type ApplyGatewayOptions,
  type ApplyGatewayResult,
} from "@/lib/gateway/apply";
import { readInstall, type InstallRecord } from "@/lib/gateway/install";
import { compareVersions, type GatewayRelease } from "@/lib/gateway/release";
import {
  ensureGatewayResources,
  findGatewayDatabase,
} from "@/lib/gateway/resources";
import {
  describeSetupLink,
  openInBrowser,
  setupLinkForDeploy,
} from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";
import { syncGatewayAppTools } from "./steps/syncAppTools";
import {
  cliVersion,
  connectToAccount,
  eventSink,
  openGatewayRelease,
  rememberedInstall,
  runReported,
} from "../shared";

export interface DeployGatewayFlags {
  domain?: string;
  "account-id"?: string;
  release?: string;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
  printSetupLink?: boolean;
  "allow-downgrade"?: boolean;
  "force-dns"?: boolean;
}

export async function deployGateway(
  flags: DeployGatewayFlags,
  reason: "deploy" | "upgrade",
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(out, () => run(flags, reason, out), {
    verbose: flags.verbose,
  });
}

async function run(
  flags: DeployGatewayFlags,
  reason: "deploy" | "upgrade",
  out: EventSink,
): Promise<void> {
  const requestedDomain = normalizeHostname(flags.domain);
  const cached = await rememberedInstall(requestedDomain);
  const { cf, account } = await connectToAccount({
    json: flags.json,
    accountId: flags["account-id"],
    remembered: cached?.accountId,
  });

  const { install } = await findInstall(cf);
  if (reason === "upgrade" && !install) throw notDeployedByEveryapp();
  const domain = requestedDomain ?? install?.gatewayHost ?? cached?.gatewayHost;
  if (!domain) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      "Pass --domain <hostname>: the gateway serves there, and each app one label below it (todo.<hostname>). Any hostname in a zone this Cloudflare account has works, e.g. apps.example.com in example.com. Or run `everyapp setup`, which helps pick one.",
    );
  }

  const release = await openGatewayRelease({
    releasePath: flags.release,
    out,
    verbose: flags.verbose,
  });
  try {
    if (!checkRelease({ release, install, reason, flags, out })) return;
    const target = await gatewayTarget({
      cf,
      accountId: account.id,
      install,
      domain,
      out,
    });

    const interactive = canPromptInTerminal(flags.json ?? false);
    const { result, db, gatewayUrl } = await deployGatewayRelease({
      cf,
      out,
      reason,
      release,
      accountId: account.id,
      target,
      interactive,
      forceDns: flags["force-dns"],
      allowDowngrade: flags["allow-downgrade"],
    });

    // Each app's tools catalog, taken by this gateway version. Never fails
    // the deploy.
    await syncGatewayAppTools({
      gatewayUrl,
      db,
      out,
      verbose: flags.verbose ?? false,
      boundWorkers: result.appWorkers,
    });

    const setupLink = await setupLinkForDeploy({
      db,
      gatewayUrl,
      printSetupLink: flags.printSetupLink,
      onUnattended: () =>
        out.emit({
          type: "warning",
          code: "GATEWAY_UNCLAIMED",
          message:
            "Gateway is unclaimed: run `everyapp gateway claim-link` on your machine to create the owner account.",
        }),
    });
    out.emit({
      type: "done",
      message: [
        `Gateway ${release.manifest.version} is live at ${gatewayUrl}.`,
        ...(setupLink ? [describeSetupLink(setupLink)] : []),
      ].join("\n"),
      data: {
        gatewayUrl,
        release: release.manifest.version,
        versionId: result.versionId,
        apps: result.appWorkers,
        domains: result.domains,
        ...(setupLink
          ? {
              setupLink: setupLink.url,
              setupLinkExpiresAt: setupLink.expiresAt.toISOString(),
            }
          : {}),
      },
    });
    if (setupLink && interactive) await openInBrowser(setupLink.url);
  } finally {
    await release.cleanup();
  }
}

/** The account's gateway database and install row. */
export async function findInstall(
  cf: CfRunner,
): Promise<{ databaseId: string | null; install: InstallRecord | null }> {
  const databaseId = await findGatewayDatabase(cf);
  if (!databaseId) return { databaseId, install: null };
  return { databaseId, install: await readInstall(cfD1Database(cf, databaseId)) };
}

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
  if (install) {
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
  | "confirm"
  | "readStatus"
  | "sleep"
  | "verifyTimeoutMs"
  | "leaseWaitMs"
> & {
    certificates?: Pick<
      Parameters<typeof waitForCertificates>[0],
      "isReady" | "sleep" | "maxWaitMs"
    >;
  }): Promise<{ result: ApplyGatewayResult; db: D1Database; gatewayUrl: string }> {
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
  return { result, db, gatewayUrl: `https://${target.domain}` };
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

/** False when there is nothing to do (upgrade to the running release). */
function checkRelease({
  release,
  install,
  reason,
  flags,
  out,
}: {
  release: GatewayRelease;
  install: InstallRecord | null;
  reason: "deploy" | "upgrade";
  flags: DeployGatewayFlags;
  out: EventSink;
}): boolean {
  if (compareVersions(release.manifest.minCli, cliVersion) > 0) {
    throw new EveryAppError(
      "CLI_TOO_OLD",
      `Gateway release ${release.manifest.version} needs everyapp ${release.manifest.minCli} or newer; this is ${cliVersion}.`,
    );
  }
  if (!install) return true;
  if (install.releaseSha256 === release.manifest.sha256 && reason === "upgrade") {
    out.emit({
      type: "done",
      message: `The gateway already runs release ${release.manifest.version}.`,
      data: { release: release.manifest.version },
    });
    return false;
  }
  // By migrations and build time, not the version, which an older CLI's
  // release can share. Checked again under the deploy lease.
  if (olderThanInstalled(release.manifest, install) && !flags["allow-downgrade"]) {
    throw downgradeRefused(release.manifest, {
      version: install.releaseVersion,
      sha256: install.releaseSha256,
    });
  }
  return true;
}
