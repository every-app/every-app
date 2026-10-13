/**
 * `everyapp gateway deploy` and `upgrade`: deploy the release this CLI
 * bundles. Deploy also installs a new gateway; upgrade needs one that this
 * CLI deployed before and does nothing when it already runs this release.
 * Neither moves a gateway to an older release without --allow-downgrade.
 */
import enquirer from "enquirer";
import { cfD1Database } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { findZone } from "@/lib/cf/zones";
import { resolvesThroughCloudflare } from "@/lib/dns";
import { formatWildcardDnsInstructions } from "@/lib/dnsInstructions";
import { EveryAppError } from "@/lib/errors";
import {
  applyGateway,
  downgradeRefused,
  notDeployedByEveryapp,
  olderThanInstalled,
} from "@/lib/gateway/apply";
import { waitForCertificate } from "@/lib/gateway/certWait";
import { readInstall, type InstallRecord } from "@/lib/gateway/install";
import { confirmLeaseBreak } from "@/lib/gateway/lease";
import { compareVersions, type GatewayRelease } from "@/lib/gateway/release";
import {
  ensureGatewayResources,
  findGatewayDatabase,
} from "@/lib/gateway/resources";
import {
  presentSetupLink,
  setupLinkForDeploy,
} from "@/lib/gateway/setup-link";
import type { EventSink } from "@/lib/output/events";
import {
  cliVersion,
  connectToAccount,
  eventSink,
  normalizeDomain,
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
  "break-lease"?: boolean;
  "allow-downgrade"?: boolean;
}

export async function deployGateway(
  flags: DeployGatewayFlags,
  reason: "deploy" | "upgrade",
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(out, () => run(flags, reason, out), {
    verbose: flags.verbose,
  });
}

async function run(
  flags: DeployGatewayFlags,
  reason: "deploy" | "upgrade",
  out: EventSink,
): Promise<void> {
  const requestedDomain = normalizeDomain(flags.domain);
  const cached = await rememberedInstall(requestedDomain);
  const { cf, account } = await connectToAccount({
    json: flags.json,
    accountId: flags["account-id"],
    remembered: cached?.accountId,
  });

  const existingDb = await findGatewayDatabase(cf);
  const install = existingDb
    ? await readInstall(cfD1Database(cf, existingDb))
    : null;
  if (reason === "upgrade" && !install) throw notDeployedByEveryapp();

  const domain = requestedDomain ?? install?.gatewayHost ?? cached?.gatewayHost;
  if (!domain) {
    throw new EveryAppError(
      "DOMAIN_REQUIRED",
      "Pass --domain <domain>: a Cloudflare zone in this account. The gateway serves at it, and apps at <app>-<org>.<domain>.",
    );
  }
  if (install && install.gatewayHost !== domain) {
    throw new EveryAppError(
      "DOMAIN_CHANGE_UNSUPPORTED",
      `This gateway is installed at ${install.gatewayHost}; moving it to ${domain} isn't supported.`,
    );
  }

  const release = await openGatewayRelease({
    releasePath: flags.release,
    out,
  });
  try {
    if (!checkRelease({ release, install, reason, flags, out })) return;

    const zone = install
      ? { id: install.zoneId, name: install.zoneName }
      : await findZone(cf, domain, account.id);

    if (!(await confirm({ flags, release, domain, account }))) {
      out.emit({ type: "done", message: "Deployment cancelled." });
      return;
    }

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
      accountId: account.id,
      gatewayHost: domain,
      zone,
      resources,
      db,
      interactive: canPromptInTerminal(flags.json ?? false),
      cliVersion,
      breakLease: confirmLeaseBreak({
        breakLease: flags["break-lease"],
        yes: flags.yes,
        interactive: canPromptInTerminal(flags.json ?? false),
      }),
      allowDowngrade: flags["allow-downgrade"],
    });

    const gatewayUrl = `https://${domain}`;
    if (result.firstDeploy) {
      await waitForCertificate({ url: gatewayUrl, out, step: "gateway.tls" });
    }
    if (!(await resolvesThroughCloudflare(`everyapp-wildcard-check.${domain}`))) {
      out.emit({
        type: "warning",
        code: "WILDCARD_DNS_MISSING",
        message: formatWildcardDnsInstructions({
          domain,
          accountId: account.id,
          mode: "gateway-warning",
        }),
      });
    }

    const setupLink = await setupLinkForDeploy({
      db,
      gatewayUrl,
      printSetupLink: flags.printSetupLink,
      onUnattended: () =>
        out.emit({
          type: "warning",
          code: "GATEWAY_UNCLAIMED",
          message:
            "Gateway is unclaimed: run `npx everyapp gateway claim-link` on your machine to create the owner account.",
        }),
    });
    out.emit({
      type: "done",
      message: `Gateway ${release.manifest.version} is live at ${gatewayUrl}.`,
      data: {
        gatewayUrl,
        release: release.manifest.version,
        versionId: result.versionId,
        apps: result.appWorkers,
        ...(setupLink && flags.json
          ? {
              setupLink: setupLink.url,
              setupLinkExpiresAt: setupLink.expiresAt.toISOString(),
            }
          : {}),
      },
    });
    if (setupLink && !flags.json) await presentSetupLink(setupLink);
  } finally {
    await release.cleanup();
  }
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

async function confirm({
  flags,
  release,
  domain,
  account,
}: {
  flags: DeployGatewayFlags;
  release: GatewayRelease;
  domain: string;
  account: { id: string; name: string | null };
}): Promise<boolean> {
  if (flags.yes || !canPromptInTerminal(flags.json ?? false)) return true;
  const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
    type: "confirm",
    name: "confirmed",
    message: `Deploy gateway ${release.manifest.version} to ${domain} in ${account.name ?? account.id}?`,
    initial: false,
  });
  return confirmed;
}
