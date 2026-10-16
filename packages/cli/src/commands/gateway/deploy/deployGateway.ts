/**
 * `everyapp gateway deploy` and `upgrade`: deploy the release this checkout
 * builds (from the build cache when its sources haven't changed). Deploy
 * also installs a new gateway; upgrade needs one that is installed and does
 * nothing when it already runs this release. Neither moves a gateway to an
 * older release: a checkout behind the live one is told to `git pull`
 * (only `setup --allow-downgrade` rolls back on purpose).
 */
import { deviceLoginAction, resolveAccount } from "@/lib/cf/account";
import { cfD1Database } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createCfRunner } from "@/lib/cf/runner";
import { waitForCertificates } from "@/lib/domains/certWait";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { resolveZone, type Zone } from "@/lib/domains/zones";
import { EveryAppError } from "@/lib/errors";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import {
  applyGateway,
  candidate,
  downgradeRefused,
  isLiveRelease,
  olderThanInstalled,
  type ApplyGatewayOptions,
  type ApplyGatewayResult,
} from "@/lib/gateway/apply";
import { loginAndDiscover, requireInstall } from "@/lib/gateway/connect";
import { requireGateway } from "@/lib/gateway/discover";
import type { InstallRecord } from "@/lib/gateway/install";
import { compareVersions, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import {
  describeSetupLink,
  openInBrowser,
  setupLinkForDeploy,
} from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";
import {
  cliVersion,
  eventSink,
  openGatewayRelease,
  runReported,
} from "../shared";

export interface DeployGatewayFlags {
  domain?: string;
  "account-id"?: string;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
  printSetupLink?: boolean;
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
  const interactive = canPromptInTerminal(flags.json ?? false);
  const { whoami, discovery } = await loginAndDiscover({
    accountId: flags["account-id"],
    host: requestedDomain,
    interactive,
    onDeviceLogin: flags.json ? deviceLoginAction(out, "gateway.login") : undefined,
  });
  // The Gateway the login finds; with none, `deploy` installs one.
  const found =
    reason === "upgrade"
      ? requireInstall(requireGateway(discovery, whoami))
      : discovery.gateway;
  const account =
    found?.account ??
    (await resolveAccount({ whoami, flag: flags["account-id"], interactive }));
  const cf = found?.cf ?? createCfRunner({ accountId: account.id });
  const install = found?.install ?? null;
  const domain = requestedDomain ?? install?.gatewayHost;
  if (!domain) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      "Pass --domain <hostname>: the gateway serves there, and each app one label below it (todo.<hostname>). Any hostname in a zone this Cloudflare account has works, e.g. apps.example.com in example.com. Or run `everyapp setup`, which helps pick one.",
    );
  }

  const release = await openGatewayRelease({ out, verbose: flags.verbose });
  try {
    if (!checkRelease({ release, install, reason, out })) return;
    const target = await gatewayTarget({
      cf,
      accountId: account.id,
      install,
      domain,
      out,
    });

    const { result, db, gatewayUrl } = await deployGatewayRelease({
      cf,
      out,
      reason,
      release,
      accountId: account.id,
      target,
      interactive,
      forceDns: flags["force-dns"],
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
  out,
}: {
  release: GatewayRelease;
  install: InstallRecord | null;
  reason: "deploy" | "upgrade";
  out: EventSink;
}): boolean {
  if (compareVersions(release.manifest.minCli, cliVersion) > 0) {
    throw new EveryAppError(
      "CLI_TOO_OLD",
      `Gateway release ${release.manifest.version} needs everyapp ${release.manifest.minCli} or newer; this is ${cliVersion}.`,
    );
  }
  if (!install) return true;
  // This release, or a build of the same sources.
  if (reason === "upgrade" && isLiveRelease(release, install)) {
    out.emit({
      type: "done",
      message: `The gateway already runs release ${release.manifest.version}, built from these sources.`,
      data: { release: release.manifest.version },
    });
    return false;
  }
  // By migrations and when the sources were committed, not the version,
  // which an older checkout can share. Checked again under the deploy
  // lease. Only setup rolls back on purpose (--allow-downgrade).
  if (olderThanInstalled(candidate(release), install)) {
    throw downgradeRefused(candidate(release), install);
  }
  return true;
}
