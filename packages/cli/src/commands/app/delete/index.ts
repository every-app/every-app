import enquirer from "enquirer";
import type { LocalContext } from "@/context";
import {
  connectToGatewayAccount,
  gatewayCall,
  type ReconcileSeams,
} from "@/commands/app/deploy/deployApp";
import {
  appWithWorkerNamed,
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
} from "@/lib/app/ownership";
import { cfD1Database, type D1Database } from "@/lib/cf/d1";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { CfError } from "@/lib/cf/errors";
import {
  deleteD1,
  deleteKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { deleteWorker, getWorkerDeployment } from "@/lib/cf/workers";
import { deleteWorkflow, listWorkflows } from "@/lib/cf/workflows";
import { deleteHostCertificates } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { EveryAppError } from "@/lib/errors";
import { GatewayClient, type DeletedApp } from "@/lib/gateway/api";
import { readInstall } from "@/lib/gateway/install";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { resolveGatewayUrl } from "@/lib/gateway/resolve";
import { loadEveryAppManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";
import { version as cliVersion } from "../../../../package.json";

interface DeleteCommandFlags {
  gateway?: string;
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
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      const appId =
        appIdArgument ?? (await loadEveryAppManifest(process.cwd())).id;
      const gatewayUrl = await resolveGatewayUrl(flags.gateway);
      const interactive = canPromptInTerminal(flags.json ?? false);
      if (!(await confirmDelete({ appId, gatewayUrl, flags, interactive }))) {
        out.emit({ type: "done", message: "Nothing deleted." });
        return;
      }
      const result = await removeApp({
        appId,
        client: new GatewayClient({ gatewayUrl }),
        out,
        interactive,
        purge: flags.purge ?? false,
      });
      out.emit({ type: "done", ...deletionSummary(appId, result) });
    },
    { verbose: flags.verbose },
  );
}

/**
 * `everyapp app delete`: tombstone the app on the gateway (its names stay
 * reserved to its organization), drop its binding and its Custom Domain
 * with a reconcile, delete the certificate Cloudflare keeps for that
 * hostname, and with `purge` delete its Worker, D1 databases and KV
 * namespaces: only those the registry recorded as created by the app, never
 * whatever has its names; and the Workflows that run on its Worker.
 * `purged` says what was deleted and what was kept.
 */
export async function removeApp({
  appId,
  client,
  out,
  interactive,
  purge,
  createCf = (accountId?: string) => createCfRunner({ accountId }),
  reconcile,
}: {
  appId: string;
  client: GatewayClient;
  out: EventSink;
  interactive: boolean;
  purge: boolean;
  createCf?: (accountId?: string) => CfRunner;
  reconcile?: ReconcileSeams;
}): Promise<DeletedApp & { purged?: PurgeResult }> {
  const { cf, accountId, gatewayDb } = await connectToGatewayAccount({
    client,
    interactive,
    createCf,
  });
  const deleted = await gatewayCall(() => client.deleteApp(appId));
  out.emit({
    type: "step",
    step: "app.delete",
    status: "ok",
    message: `${appId} is deleted on the gateway; ${deleted.hostname} stops serving it.`,
  });

  await reconcileGateway({
    cf,
    out,
    accountId,
    interactive,
    cliVersion,
    ...reconcile,
  });

  // Cloudflare keeps a removed Custom Domain's certificate. A hostname
  // outside the base was never the gateway's: whatever has a certificate
  // for it keeps it.
  const registry = cfD1Database(cf, gatewayDb);
  const install = await readInstall(registry);
  if (
    install?.routing === "custom-domains" &&
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
  const purged = await purgeApp(cf, registry, out, appId, deleted);
  return { ...deleted, purged };
}

interface PurgeResult {
  removed: string[];
  kept: string[];
}

/** The last word: what was deleted, and with `--purge`, what was kept. */
export function deletionSummary(
  appId: string,
  { workerName, purged }: DeletedApp & { purged?: PurgeResult },
): { message: string; data: Record<string, unknown> } {
  const message = !purged
    ? `Deleted ${appId}. Its Worker and data are kept, and the Worker's cron schedules and Workflows, if it has any, keep running; \`everyapp app delete ${appId} --purge\` removes them.`
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
  out: EventSink,
  appId: string,
  deleted: DeletedApp,
): Promise<PurgeResult> {
  const owned = await readOwnedResources(registry, deleted.workerName);
  // Named after another app's Worker: that app's, whatever was recorded.
  const othersApp = (name: string) =>
    name === deleted.workerName
      ? Promise.resolve(null)
      : appWithWorkerNamed(registry, name);
  const removed: string[] = [];
  const othersKept: string[] = [];
  const workflowsKept: string[] = [];
  // Its Workflows before the Worker they run on; a Worker the app didn't
  // record creating keeps its own.
  if (owned.some((resource) => resource.kind === "worker" && resource.resourceId)) {
    for (const workflow of await listWorkflows(cf, deleted.workerName)) {
      if (workflow.script_name !== deleted.workerName) {
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
  // The Worker next: it binds the databases and namespaces.
  for (const resource of owned.sort((a, b) =>
    a.kind === "worker" ? -1 : b.kind === "worker" ? 1 : 0,
  )) {
    if (!resource.resourceId) continue;
    const otherApp = await othersApp(resource.name);
    if (otherApp) {
      othersKept.push(`${describeResource(resource)} (app ${otherApp}'s)`);
      continue;
    }
    try {
      if (resource.kind === "worker") {
        if (!(await getWorkerDeployment(cf, resource.resourceId))) continue;
        await deleteWorker(cf, resource.resourceId);
      } else if (resource.kind === "d1") {
        await deleteD1(cf, resource.resourceId);
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
    ...(await unrecordedResources(cf, deleted, owned, othersApp)),
    ...workflowsKept,
  ];
  if (othersKept.length > 0) {
    out.emit({
      type: "warning",
      code: "RESOURCES_KEPT",
      step: "app.purge",
      message: `Kept ${othersKept.join(", ")}: named after another app's Worker, so it is that app's (${appId} matched its name only under the old naming).`,
      data: { kept: othersKept },
    });
  }
  if (unrecorded.length > 0) {
    out.emit({
      type: "warning",
      code: "RESOURCES_KEPT",
      step: "app.purge",
      message: `Kept ${unrecorded.join(", ")}: they have ${appId}'s names, but no deploy recorded creating them, so they may belong to someone else. If they are ${appId}'s (deployed before everyapp recorded what it creates), delete them with npx cf.`,
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
  return { removed, kept: [...othersKept, ...unrecorded] };
}

/**
 * What exists under the app's assigned names without being recorded as its
 * own, leaving out names of other apps' Workers.
 */
async function unrecordedResources(
  cf: CfRunner,
  deleted: DeletedApp,
  owned: ReadonlyArray<{ kind: string; name: string; resourceId: string | null }>,
  othersApp: (name: string) => Promise<string | null>,
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
      if (recorded.has(`${kind}:${name}`) || (await othersApp(name))) continue;
      if (await (kind === "d1" ? findD1 : findKv)(cf, name)) {
        kept.push(describeResource({ kind, name }));
      }
    }
  }
  return kept;
}

async function confirmDelete({
  appId,
  gatewayUrl,
  flags,
  interactive,
}: {
  appId: string;
  gatewayUrl: string;
  flags: DeleteCommandFlags;
  interactive: boolean;
}): Promise<boolean> {
  if (flags.yes) return true;
  if (!interactive) {
    throw new EveryAppError(
      "CONFIRMATION_REQUIRED",
      `Deleting an app needs a person at a terminal, or --yes.`,
    );
  }
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
    message: `Delete ${appId} from ${gatewayUrl}?`,
    initial: false,
  });
  return confirmed;
}
