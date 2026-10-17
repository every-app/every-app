import enquirer from "enquirer";
import type { LocalContext } from "@/context";
import {
  checkoutGateway,
  type ReconcileSeams,
} from "@/commands/deploy/deployApp";
import { removeEmailRoutes } from "@/lib/app/emailRoutes";
import {
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
} from "@/lib/app/ownership";
import { deviceLoginAction } from "@/lib/cf/account";
import type { D1Database } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { CfError } from "@/lib/cf/errors";
import {
  deleteD1,
  deleteKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import { deleteHyperdrive } from "@/lib/cf/hyperdrive";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorker, getWorkerDeployment } from "@/lib/cf/workers";
import { deleteWorkflow, listWorkflows } from "@/lib/cf/workflows";
import { deleteHostCertificates } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { EveryAppError } from "@/lib/errors";
import { refuseOlderCheckout } from "@/lib/gateway/apply";
import { openGatewayRelease } from "@/lib/gateway/checkoutRelease";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readInstall } from "@/lib/gateway/install";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import {
  deleteApp as deleteFromRegistry,
  type RegisteredAppInfo,
} from "@/lib/gateway/registry";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";
import { handTerminalOver } from "@/lib/output/terminal";
import { version as cliVersion } from "../../../package.json";

interface DeleteCommandFlags {
  gateway?: string;
  "account-id"?: string;
  purge?: boolean;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export async function deleteApp(
  this: LocalContext,
  flags: DeleteCommandFlags,
  appIdArgument?: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const appId =
        appIdArgument ?? (await loadEveryAppManifest(process.cwd())).id;
      const interactive = canPromptInTerminal(flags.json ?? false);
      if (!(await confirmDelete({ appId, flags, interactive }))) {
        out.emit({ type: "done", message: "Nothing deleted." });
        return;
      }
      const result = await removeApp({
        appId,
        gateway: requestedGatewayUrl(flags.gateway),
        accountId: flags["account-id"],
        out,
        json: flags.json,
        interactive,
        purge: flags.purge ?? false,
      });
      out.emit({ type: "done", ...deletionSummary(appId, result) });
    },
    { verbose: flags.verbose },
  );
}

/**
 * `everyapp delete`: tombstone the app in the gateway's D1 registry
 * (its names stay reserved to its organization; everyone's access to it,
 * its tokens, tools and place in AI connections go), drop its binding and
 * its Custom Domain with a reconcile, delete the certificate Cloudflare
 * keeps for that hostname, and with `purge` delete its Worker, D1
 * databases and KV namespaces: only those the registry recorded as created
 * by the app, never whatever has its names; the Workflows that run on
 * its Worker; and its Email Routing routes (a catch-all drops mail
 * again). Its helper Workers are recorded beside its Worker, so they
 * and their Workflows go with it. `purged` says what was deleted and what
 * was kept. An app deleted already is deleted again from the reconcile on,
 * so a delete that stopped part-way can run again.
 */
export async function removeApp({
  appId,
  gateway,
  accountId,
  out,
  json,
  interactive,
  purge,
  createCf,
  reconcile,
}: {
  appId: string;
  /** The gateway `--gateway` or EVERYAPP_GATEWAY_URL names. */
  gateway?: string;
  /** The Gateway's Cloudflare account (`--account-id`). */
  accountId?: string;
  out: EventSink;
  /** An agent reads the events: it gets cf's device login, and the run waits. */
  json?: boolean;
  interactive: boolean;
  purge: boolean;
  createCf?: (accountId?: string) => CfRunner;
  reconcile?: ReconcileSeams;
}): Promise<RegisteredAppInfo & { purged?: PurgeResult }> {
  const connection = await connectToGateway({
    gateway,
    accountId,
    interactive,
    onDeviceLogin: json ? deviceLoginAction(out, "app.login") : undefined,
    createCf,
  });
  const { cf, db: registry } = connection;
  // Before the registry changes: never with a checkout behind the Gateway.
  await refuseOlderCheckout(connection.install, checkoutGateway(reconcile));
  const deleted = await deleteFromRegistry(registry, appId, connection.deployer);
  out.emit({
    type: "step",
    step: "app.delete",
    status: "ok",
    message: `${appId} is deleted on the gateway; ${deleted.hostname} stops serving it.`,
    data: { appId, hostname: deleted.hostname, workerName: deleted.workerName },
  });

  // The gateway this checkout builds, without the app's binding.
  await reconcileGateway({
    cf,
    out,
    accountId: connection.accountId,
    databaseId: connection.databaseId,
    interactive,
    cliVersion,
    openRelease: () => openGatewayRelease({ out }),
    ...reconcile,
  });

  // Cloudflare keeps a removed Custom Domain's certificate. A hostname
  // outside the base was never the gateway's: whatever has a certificate
  // for it keeps it.
  const install = await readInstall(registry);
  if (
    install &&
    isOneLabelBelow(deleted.hostname, install.appBaseDomain) &&
    !install.liveDomains.includes(deleted.hostname)
  ) {
    await deleteHostCertificates({
      cf,
      out,
      step: "app.delete",
      zoneId: install.zoneId,
      hostname: deleted.hostname,
    });
  }

  if (!purge) return deleted;
  const purged = await purgeApp(cf, registry, connection.accountId, out, appId, deleted);
  return { ...deleted, purged };
}

interface PurgeResult {
  removed: string[];
  kept: string[];
}

/** The last word: what was deleted, and with `--purge`, what was kept. */
export function deletionSummary(
  appId: string,
  { workerName, purged }: RegisteredAppInfo & { purged?: PurgeResult },
): { message: string; data: Record<string, unknown> } {
  const message = !purged
    ? `Deleted ${appId}. Its Worker and data are kept, and the Worker's cron schedules, Workflows and mail routes, if it has any, keep running; \`${CLI} delete ${appId} --purge\` removes them.`
    : purged.kept.length > 0
      ? `Deleted ${appId}${purged.removed.length > 0 ? ` and ${purged.removed.join(", ")}` : ""}; kept ${purged.kept.join(", ")} (see above).`
      : purged.removed.length > 0
        ? `Deleted ${appId} and ${purged.removed.join(", ")}.`
        : `Deleted ${appId}; nothing of it was left in Cloudflare.`;
  return {
    message,
    data: {
      appId,
      workerName,
      // Everything the app had in Cloudflare is gone.
      purged: purged ? purged.kept.length === 0 : false,
      removed: purged?.removed ?? [],
      kept: purged?.kept ?? [],
    },
  };
}

async function purgeApp(
  cf: CfRunner,
  registry: D1Database,
  accountId: string,
  out: EventSink,
  appId: string,
  deleted: RegisteredAppInfo,
): Promise<PurgeResult> {
  const recorded = await readOwnedResources(registry, deleted.workerName);
  // Its mail routes first, so no rule names a Worker that is gone.
  const removed = await removeEmailRoutes({
    cf,
    gatewayDb: registry,
    accountId,
    workerName: deleted.workerName,
    routes: recorded.filter((resource) => resource.kind === "email-route"),
  });
  const owned = recorded.filter((resource) => resource.kind !== "email-route");
  const workflowsKept: string[] = [];
  // The app's Worker and its helper Workers (`<worker>--<name>`), as recorded.
  const ownWorkers = new Set(
    owned.flatMap((resource) =>
      resource.kind === "worker" && resource.resourceId ? [resource.resourceId] : [],
    ),
  );
  // Its Workflows before the Workers they run on; a Worker the app didn't
  // record creating keeps its own.
  if (ownWorkers.size > 0) {
    for (const workflow of await listWorkflows(cf, deleted.workerName)) {
      if (!ownWorkers.has(workflow.script_name ?? "")) {
        // Named like the app's, but another Worker runs it.
        if (workflow.name.startsWith(`${deleted.workerName}--`)) {
          workflowsKept.push(
            `Workflow "${workflow.name}" (Worker ${workflow.script_name ?? "unknown"}'s)`,
          );
        }
        continue;
      }
      try {
        await deleteWorkflow(cf, workflow.name);
        removed.push(`Workflow "${workflow.name}"`);
      } catch (error) {
        if (!(error instanceof CfError && error.kind === "not_found")) throw error;
      }
    }
  }
  // The Workers next, the app's before its helpers (it binds their
  // classes): they bind the databases, namespaces and Hyperdrive configs
  // (a config goes; the Postgres database it connects to is never touched).
  const order = (resource: (typeof owned)[number]) =>
    resource.kind !== "worker" ? 2 : resource.binding === "" ? 0 : 1;
  for (const resource of owned.sort((a, b) => order(a) - order(b))) {
    if (!resource.resourceId) continue;
    try {
      if (resource.kind === "worker") {
        if (!(await getWorkerDeployment(cf, resource.resourceId))) continue;
        await deleteWorker(cf, resource.resourceId);
      } else if (resource.kind === "d1") {
        await deleteD1(cf, resource.resourceId);
      } else if (resource.kind === "hyperdrive") {
        await deleteHyperdrive(cf, resource.resourceId);
      } else {
        await deleteKv(cf, resource.resourceId);
      }
      removed.push(describeResource(resource));
    } catch (error) {
      // Deleted already, by an earlier purge that stopped or by hand.
      if (!(error instanceof CfError && error.kind === "not_found")) throw error;
    }
  }
  await forgetOwnedResources(registry, deleted.workerName);

  const unrecorded = [
    ...(await unrecordedResources(cf, deleted, owned)),
    ...workflowsKept,
  ];
  if (unrecorded.length > 0) {
    out.emit({
      type: "warning",
      code: "RESOURCES_KEPT",
      step: "app.purge",
      message: `Kept ${unrecorded.join(", ")}: they have ${appId}'s names, but no deploy recorded creating them, so they may belong to someone else. If they are ${appId}'s, delete them with npx cf.`,
      data: { kept: unrecorded },
    });
  }
  out.emit({
    type: "step",
    step: "app.purge",
    status: "ok",
    message: removed.length
      ? `Deleted ${removed.join(", ")}.`
      : "Nothing deleted in Cloudflare.",
    data: { removed },
  });
  return { removed, kept: unrecorded };
}

/** What exists under the app's assigned names without being recorded as its own. */
async function unrecordedResources(
  cf: CfRunner,
  deleted: RegisteredAppInfo,
  owned: ReadonlyArray<{ kind: string; name: string; resourceId: string | null }>,
): Promise<string[]> {
  const recorded = new Set(
    owned.filter((r) => r.resourceId).map((r) => `${r.kind}:${r.name}`),
  );
  const kept: string[] = [];
  if (
    !recorded.has(`worker:${deleted.workerName}`) &&
    (await getWorkerDeployment(cf, deleted.workerName))
  ) {
    kept.push(describeResource({ kind: "worker", name: deleted.workerName }));
  }
  for (const kind of ["d1", "kv"] as const) {
    for (const name of new Set(Object.values(deleted.resources[kind]))) {
      if (recorded.has(`${kind}:${name}`)) continue;
      if (await (kind === "d1" ? findD1 : findKv)(cf, name)) {
        kept.push(describeResource({ kind, name }));
      }
    }
  }
  return kept;
}

async function confirmDelete({
  appId,
  flags,
  interactive,
}: {
  appId: string;
  flags: DeleteCommandFlags;
  interactive: boolean;
}): Promise<boolean> {
  if (flags.yes) return true;
  if (!interactive) {
    // Its rerun adds --yes, for a person to agree to (lib/errors.ts).
    throw new EveryAppError(
      "CONFIRMATION_REQUIRED",
      `Deleting an app needs a person at a terminal, or --yes.`,
    );
  }
  handTerminalOver();
  if (flags.purge) {
    const { typed } = await enquirer.prompt<{ typed: string }>({
      type: "input",
      name: "typed",
      message: `This deletes ${appId}'s Worker and all its data for good. Type the app id to confirm`,
    });
    return typed.trim() === appId;
  }
  const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
    type: "confirm",
    name: "confirmed",
    message: `Delete ${appId} from your gateway?`,
    initial: false,
  });
  return confirmed;
}
