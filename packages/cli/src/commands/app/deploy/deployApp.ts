import chalk from "chalk";
import {
  getDefaultAccountId,
  getGatewayPublicUrl,
  replaceGatewayServiceBindings,
  resolvesThroughCloudflare,
} from "@/lib/cloudflare";
import { installDependencies } from "@/lib/package-manager";
import { setupCloudflareResources } from "@/commands/app/deploy/steps/setupCloudflareResources";
import { runAppMigrations } from "@/lib/migrations";
import { buildAndDeploy } from "@/commands/app/deploy/steps/buildAndDeploy";
import {
  fetchGatewayIdentityKeys,
  registerAppWithGateway,
  resolveGatewayDeploymentInfo,
} from "@/commands/app/deploy/steps/registerApp";
import { setupAppSecrets } from "@/commands/app/deploy/steps/setupAppSecrets";
import {
  ensureGeneratedWranglerConfig,
  loadEveryAppManifest,
  type EveryAppCliManifest,
} from "@/lib/generateWranglerConfig";
import { workerNameFor } from "@every-app/perimeter/manifest";
import { exitWithUpdateNotice } from "@/lib/version-check";
import { formatWildcardDnsInstructions } from "@/lib/dnsInstructions";

interface DeployAppOptions {
  cwd: string;
  manifest?: EveryAppCliManifest;
  verbose: boolean;
  skipDnsCheck?: boolean;
}

interface DeployAppResult {
  liveUrl: string;
  gatewayUrl: string;
  organizationId: string;
  hostname: string;
}

interface AppHostnameTarget {
  hostname: string;
  apex: string;
  issuerHost: string;
  isWorkersDev: boolean;
}

/**
 * Shared deployment logic used by both `app create` and `app deploy`.
 */
export async function deployApp(
  options: DeployAppOptions,
): Promise<DeployAppResult> {
  const { cwd, verbose } = options;

  const manifest = options.manifest ?? (await loadEveryAppManifest(cwd));
  const appId = manifest.id;
  const workerName = workerNameFor(appId);

  const d1Bindings = manifest.resources?.d1 ?? [];
  const kvBindings = manifest.resources?.kv ?? [];
  const gatewayUrl = await getGatewayPublicUrl();
  const gatewayDeployment = await resolveGatewayDeploymentInfo(gatewayUrl);
  const { organizationId } = gatewayDeployment;
  const identity = await fetchGatewayIdentityKeys(gatewayUrl);
  const identityIssuer = identity.issuer ?? "";
  // This is only a one-label wildcard DNS probe. Registration remains the
  // authority for the app's final hostname and live URL.
  const hostnameTarget = deriveAppHostnameFromIssuer(appId, identity.issuer);

  if (hostnameTarget) {
    await verifyAppSubdomainCanResolve({
      ...hostnameTarget,
      skipDnsCheck: options.skipDnsCheck ?? false,
    });
  }

  const { d1DatabaseIds, kvNamespaceIds } = await setupCloudflareResources({
    appId,
    d1Bindings,
    kvBindings,
    verbose,
  });

  console.log();
  await installDependencies({
    cwd,
    description: "Installing dependencies for Cloudflare deployment...",
    install: manifest.install,
    verbose,
  });

  if (d1Bindings.length > 0) {
    await runAppMigrations({
      cwd,
      workerName,
      d1Bindings,
      d1DatabaseIds,
      migrations: manifest.migrations,
      verbose,
    });
  } else if (verbose) {
    console.log(chalk.dim("No D1 resources declared; skipping migrations.\n"));
  }

  const { configPath: generatedWranglerConfigPath } =
    await ensureGeneratedWranglerConfig(cwd, {
      manifest,
      d1DatabaseIds,
      kvNamespaceIds,
      identityPublicKeys: identity.keys,
      vars: {
        EVERYAPP_IDENTITY_ISSUER: identityIssuer,
      },
      gatewayBinding: gatewayDeployment.gatewayBinding,
    });

  await buildAndDeploy({
    cwd,
    buildCommand: manifest.build,
    gatewayUrl,
    appId,
    generatedWranglerConfigPath,
    verbose,
  });

  const { hostname } = await registerAppWithGateway({
    appId,
    workerName,
    manifest,
    gatewayUrl,
    verbose,
    appName: manifest.name,
    appDescription: manifest.description,
  });

  await setupAppSecrets({
    gatewayUrl,
    appPath: cwd,
    workerName,
    verbose,
  });

  const accountId = await getDefaultAccountId();
  const serviceBindings = await replaceGatewayServiceBindings(accountId);
  if (verbose) {
    console.log(
      chalk.dim(
        `  Reconciled ${serviceBindings.length} gateway app service binding${serviceBindings.length === 1 ? "" : "s"}`,
      ),
    );
  }

  return {
    liveUrl: `https://${hostname}`,
    gatewayUrl,
    organizationId,
    hostname,
  };
}

export function deriveAppHostnameFromIssuer(
  appId: string,
  issuer: string | null | undefined,
): AppHostnameTarget | null {
  if (!issuer) {
    return null;
  }

  const issuerHost = new URL(issuer).hostname;
  return {
    hostname: `${appId}.${issuerHost}`,
    apex: issuerHost,
    issuerHost,
    isWorkersDev: issuerHost.endsWith(".workers.dev"),
  };
}

async function verifyAppSubdomainCanResolve({
  hostname,
  apex,
  issuerHost,
  isWorkersDev,
  skipDnsCheck,
}: AppHostnameTarget & { skipDnsCheck: boolean }): Promise<void> {
  if (isWorkersDev) {
    console.log(chalk.red("\nGateway custom domain required\n"));
    console.log(
      [
        `  The gateway is currently configured at ${chalk.cyan(issuerHost)}.`,
        "  App subdomains cannot work on workers.dev domains.",
        "",
        `  Run ${chalk.cyan(
          "everyapp gateway deploy --domain <apex-domain>",
        )} first, then deploy the app again.`,
        "",
      ].join("\n"),
    );
    await exitWithUpdateNotice(1);
  }

  if (skipDnsCheck) {
    return;
  }

  if (await resolvesThroughCloudflare(hostname)) {
    return;
  }

  console.log(chalk.red("\nApp subdomain DNS is not ready\n"));
  const accountId = await getDefaultAccountId().catch(() => null);
  console.log(
    chalk.yellow(
      formatWildcardDnsInstructions({
        domain: apex,
        accountId,
        mode: "app-blocking",
        hostname: chalk.cyan(hostname),
      }),
    ),
  );
  await exitWithUpdateNotice(1);
}
