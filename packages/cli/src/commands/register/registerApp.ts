/**
 * `everyapp register`: put a Worker deployed by other means (an Alchemy
 * stage, wrangler, another pipeline) behind the hosted gateway as a shared
 * app, the way `deploy --shared` leaves an app it builds itself:
 *
 *   1. find the gateway through the Cloudflare login (lib/gateway/connect.ts),
 *      refuse a checkout older than it, and a gateway that isn't hosted;
 *   2. load and validate the app's manifest with the loader `deploy` uses,
 *      and check the Worker exists in the gateway's account (cf);
 *   3. register the app in the platform organization (scope `shared`,
 *      `<appId>.<base>`) under the Worker name the registry rules give it,
 *      which must be the one passed: the gateway binds no other;
 *   4. record the Worker's live version and the manifest (`binding`), bind
 *      it on the gateway (a reconcile, applyGateway: APP__<worker>) and
 *      publish its hostname, then wait for it to go live, as deploy does.
 *
 * Nothing about the Worker changes: no build, no upload, no secrets, and
 * it is never recorded as everyapp's own, so `delete --purge` keeps it. Its
 * own pipeline gives it what an everyapp-built Worker gets (the identity
 * keys and issuer, and the AppGateway binding with these props), which the
 * `app.register` step lists.
 */
import { appBindingName } from "@every-app/perimeter/manifest";
import {
  assertSharedApps,
  bindIfNeeded,
  checkoutGateway,
  type ReconcileSeams,
} from "@/commands/deploy/deployApp";
import { waitForLive, type LiveWaitSeams } from "@/commands/deploy/steps/waitForLive";
import { deviceLoginAction } from "@/lib/cf/account";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { preflightDomains } from "@/lib/domains/preflight";
import { EveryAppError } from "@/lib/errors";
import { refuseOlderCheckout } from "@/lib/gateway/apply";
import { openGatewayRelease } from "@/lib/gateway/checkoutRelease";
import { connectToGateway } from "@/lib/gateway/connect";
import { acquireLease } from "@/lib/gateway/lease";
import { markDeployed, register } from "@/lib/gateway/registry";
import { loadEveryAppManifestFile } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";

interface RegisterAppOptions {
  appId: string;
  /** The Worker in the gateway's account (`--worker`). */
  workerName: string;
  /** The app's everyapp.config.ts (`--manifest`). */
  manifestPath: string;
  /** `--shared`: the only kind `register` makes. */
  shared: boolean;
  gateway?: string;
  accountId?: string;
  out: EventSink;
  json?: boolean;
  verbose?: boolean;
  forceDns?: boolean;
  /** Wait for the app to go live (default true; `--no-wait`). */
  waitForLive?: boolean;
  /** Seams for tests. */
  interactive?: boolean;
  createCf?: (accountId?: string) => CfRunner;
  reconcile?: ReconcileSeams;
  live?: LiveWaitSeams;
}

interface RegisterAppResult {
  liveUrl: string;
  organizationId: string;
  hostname: string;
  workerName: string;
  versionId: string;
  live: boolean;
}

export async function registerApp(
  options: RegisterAppOptions,
): Promise<RegisterAppResult> {
  const { appId, workerName, out } = options;
  if (!options.shared) {
    throw new EveryAppError(
      "SHARED_FLAG_REQUIRED",
      `\`${CLI} register\` registers shared apps only, a hosted gateway's first-party apps: pass --shared. An organization's own app deploys with \`${CLI} deploy\`.`,
    );
  }
  const interactive =
    options.interactive ?? canPromptInTerminal(options.json ?? false);
  const manifest = await loadEveryAppManifestFile(options.manifestPath);
  if (manifest.id !== appId) {
    throw new EveryAppError(
      "MANIFEST_MISMATCH",
      `${options.manifestPath} is app "${manifest.id}"'s manifest, not "${appId}"'s.`,
    );
  }

  // 1. The gateway, through the Cloudflare login. It must be hosted.
  const { cf, accountId, accountName, databaseId, db: registry, install, gatewayUrl, deployer } =
    await connectToGateway({
      gateway: options.gateway,
      accountId: options.accountId,
      interactive,
      onDeviceLogin: options.json ? deviceLoginAction(out, "app.login") : undefined,
      createCf: options.createCf,
    });
  await refuseOlderCheckout(install, checkoutGateway(options.reconcile));
  assertSharedApps(install);

  // 2. The Worker, deployed by other means, is there.
  const deployment = await getWorkerDeployment(cf, workerName);
  if (!deployment) {
    throw new EveryAppError(
      "WORKER_NOT_FOUND",
      `No Worker ${workerName} in the gateway's Cloudflare account (${accountName ?? accountId}). Deploy it there first, then register it.`,
    );
  }
  if (!deployment.versionId) {
    throw new EveryAppError(
      "VERSION_UNKNOWN",
      `Cloudflare reports no version serving ${workerName}.`,
    );
  }
  const versionId = deployment.versionId;

  // 3. Register under the name the rules give it, which must be this Worker.
  const { plan, organization } = await register(registry, {
    appSlug: appId,
    name: manifest.name ?? appId,
    description: manifest.description ?? appId,
    manifest,
    appBaseDomain: install.appBaseDomain,
    deployer,
    organizationName: accountName ?? "",
    scope: "shared",
    expectedWorkerName: workerName,
  });
  const hostname = plan.app.hostname!;
  const isNew = plan.kind !== "existing";
  out.emit({
    type: "step",
    step: "app.register",
    status: "ok",
    message: `${isNew ? "Registered" : "Updating"} ${appId} as ${workerName} at https://${hostname} (${plan.app.status}). A shared app: every member of every organization can open it. Its Worker needs the identity keys, the issuer, the vars and the AppGateway binding's props in data.worker.`,
    data: {
      appId,
      workerName,
      hostname,
      status: plan.app.status,
      existingApp: !isNew,
      scope: plan.app.scope,
      organizationId: organization.id,
      organizationName: organization.name,
      versionId,
      worker: {
        identityIssuer: gatewayUrl,
        identityPublicKeys: install.jwtPublicKey ? [install.jwtPublicKey] : [],
        // The SDK then refuses a gateway call that says nobody's.
        vars: { EVERYAPP_SHARED: "1" },
        gatewayBinding: {
          service: "every-app-gateway",
          entrypoint: "AppGateway",
          props: { organizationId: organization.id, appId, workerName },
        },
      },
    },
  });

  const outsideBase = !isOneLabelBelow(hostname, install.appBaseDomain);
  const newHost = !outsideBase && !install.liveDomains.includes(hostname);
  if (newHost) {
    await preflightDomains({
      cf,
      out,
      step: "app.domain",
      zone: { id: install.zoneId, name: install.zoneName },
      domains: [...install.liveDomains, hostname],
      liveDomains: install.liveDomains,
      forceDns: options.forceDns,
      interactive,
    });
  }

  // 4. Record the live version (one deploy or register of the app at a
  // time), bind, publish and go live.
  const lease = await acquireLease({
    db: registry,
    id: `app:${workerName}`,
    purpose: "app.register",
    onWait: (holder) =>
      out.emit({
        type: "progress",
        step: "app.lease",
        message: `Waiting for another deploy of ${appId} to finish: ${holder.holder}...`,
      }),
    onHeartbeatProblem: (message) =>
      out.emit({ type: "warning", code: "LEASE_HEARTBEAT", step: "app.lease", message }),
  });
  try {
    await markDeployed(registry, plan.app.id, {
      versionId,
      manifest,
      actor: deployer.actor,
    });
  } finally {
    await lease.release();
  }

  const rerun = `${CLI} register ${appId} --worker ${workerName} --shared --manifest ${options.manifestPath}`;
  await bindIfNeeded({
    cf,
    db: registry,
    databaseId,
    out,
    accountId,
    workerName,
    publishHost: newHost,
    interactive,
    forceDns: options.forceDns,
    seams: {
      openRelease: () => openGatewayRelease({ out, verbose: options.verbose }),
      ...options.reconcile,
    },
    rerun,
  });
  const wait = !outsideBase && (options.waitForLive ?? true);
  if (!outsideBase && !wait) {
    out.emit({
      type: "progress",
      step: "app.live",
      message: `${appId} goes live on its first visit to https://${hostname}; \`${CLI} status\` shows it.`,
      data: { hostname },
    });
  }
  const live =
    wait &&
    (await waitForLive({
      db: registry,
      appRowId: plan.app.id,
      appId,
      hostname,
      out,
      newHostname: newHost,
      ...options.live,
    })) === "live";
  if (live) {
    out.emit({
      type: "step",
      step: "app.live",
      status: "ok",
      message: `${appId} is live at https://${hostname}, through ${appBindingName(workerName)}.`,
      data: { hostname, url: `https://${hostname}` },
    });
  }
  return {
    liveUrl: `https://${hostname}`,
    organizationId: organization.id,
    hostname,
    workerName,
    versionId,
    live,
  };
}
