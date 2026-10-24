import path from "node:path";
import chalk from "chalk";
import type { LocalContext } from "@/context";
import { gatewayFor, type ReconcileSeams } from "@/commands/appGateway";
import { removeEmailRoutes } from "@/lib/app/emailRoutes";
import {
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
  RESOURCE_LABELS,
} from "@/lib/app/ownership";
import type { D1Database } from "@/lib/cf/d1";
import { isCfError } from "@/lib/cf/errors";
import {
  deleteD1,
  deleteKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import { deleteHyperdrive } from "@/lib/cf/hyperdrive";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorker, getWorkerDeployment } from "@/lib/cf/workers";
import { deleteWorkflowIfExists, listWorkflows } from "@/lib/cf/workflows";
import { deleteHostCertificates } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { CancelledError } from "@/lib/errors";
import { refuseOlderCheckout } from "@/lib/gateway/apply";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { readInstall } from "@/lib/gateway/install";
import { readPublicSurfaces, syncAppsAccessAfter } from "@/lib/access/sync";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import {
  deleteApp as deleteFromRegistry,
  type RegisteredAppInfo,
} from "@/lib/gateway/registry";
import { loadEveryAppManifestFile } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { askText, canPromptInTerminal, confirmUnlessYes } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { listed, plural } from "@/lib/output/text";
import { version as cliVersion } from "../../../package.json";
import type { GatewayCommandFlags } from "../flags";

interface DeleteCommandFlags extends GatewayCommandFlags {
  purge?: boolean;
  yes?: boolean;
}

export async function deleteApp(
  this: LocalContext,
  flags: DeleteCommandFlags,
  appIdArgument?: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const appId =
      appIdArgument ??
      (
        await loadEveryAppManifestFile(path.join(process.cwd(), "everyapp.config.ts"), {
          message: "Which app? There's no everyapp.config.ts here",
          fix: `run this from the app's directory, or name it: ${CLI} delete <id>`,
        })
      ).id;
    const interactive = canPromptInTerminal(flags.json ?? false);
    await confirmDelete({ appId, flags, interactive });
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
  });
}

type RemovedApp = RegisteredAppInfo & { alreadyDeleted: boolean; purged?: PurgeResult };

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
 * was kept. An app deleted already whose binding or hostname the live
 * Gateway still has (a delete that stopped part-way) is reconciled again;
 * one the Gateway no longer has needs no redeploy.
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
}): Promise<RemovedApp> {
  const connection = await connectToGateway({
    gateway,
    accountId,
    interactive,
    login: { json, out, step: "app.login" },
    createCf,
  });
  const { cf, db: registry } = connection;
  // Before the registry changes: never with a Gateway behind the live one.
  const newGateway = gatewayFor(reconcile, out);
  await refuseOlderCheckout(connection.install, newGateway.source);
  out.emit({
    type: "step",
    step: "app.delete",
    status: "start",
    message: `Removing ${appId} from the Gateway...`,
    data: { appId },
  });
  // Whether Access had public routes of its to take back: read before the row is tombstoned.
  const hadPublicRoutes = (await readPublicSurfaces(registry)).some(
    (surface) => surface.appId === appId && surface.publicPaths.length > 0,
  );
  const deleted = await deleteFromRegistry(registry, appId, connection.deployer);
  const live = connection.install;
  const stillServed =
    live.liveAppWorkers.includes(deleted.workerName) || live.liveDomains.includes(deleted.hostname);
  if (!deleted.alreadyDeleted || stillServed) {
    // The Gateway this run deploys, without the app's binding.
    await reconcileGateway({
      cf,
      out,
      accountId: connection.accountId,
      databaseId: connection.databaseId,
      interactive,
      cliVersion,
      ...reconcile,
      openRelease: newGateway.openRelease,
    });
  }
  // Behind Cloudflare Access, the app's destination goes with it.
  await syncAppsAccessAfter(
    { cf, db: registry, install: connection.install, out },
    { appId, publicRoutes: hadPublicRoutes, removing: true },
  );
  out.emit({
    type: "step",
    step: "app.delete",
    status: "ok",
    message: `${appId} is deleted on the gateway; ${deleted.hostname} stops serving it.`,
    data: {
      appId,
      hostname: deleted.hostname,
      workerName: deleted.workerName,
      alreadyDeleted: deleted.alreadyDeleted && !stillServed,
    },
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

/**
 * The last word: what stays and how to delete it too, or with `--purge`
 * nothing more (its step and any warning said it).
 */
export function deletionSummary(
  appId: string,
  { workerName, alreadyDeleted, purged }: RemovedApp,
): { message: string; display: string; data: Record<string, unknown> } {
  const purge = `${CLI} delete ${appId} --purge`;
  const message = !purged
    ? `${alreadyDeleted ? `${appId} was already deleted` : `Deleted ${appId}`}; its Worker and data are kept, and any cron triggers, Workflows and mail routes keep running.`
    : purged.kept.length > 0
      ? `Deleted ${appId}${purged.removed.length > 0 ? ` and ${purged.removed.join(", ")}` : ""}; kept ${purged.kept.join(", ")}.`
      : purged.removed.length > 0
        ? `Deleted ${appId} and ${purged.removed.join(", ")}.`
        : `Deleted ${appId}; nothing of it was left in Cloudflare.`;
  const display = purged
    ? ""
    : alreadyDeleted
      ? chalk.dim(`Its Worker and data are kept. To delete them: ${purge}`)
      : [
          "Its Worker and data are kept, and any cron triggers, Workflows and mail routes keep running.",
          `To delete those too: ${purge}`,
        ]
          .map((line) => chalk.dim(line))
          .join("\n");
  return {
    message,
    display,
    data: {
      appId,
      workerName,
      alreadyDeleted,
      // Everything the app had in Cloudflare is gone.
      purged: purged ? purged.kept.length === 0 : false,
      removed: purged?.removed ?? [],
      kept: purged?.kept ?? [],
    },
  };
}

/** What a purge deleted, by kind, in the order a person reads them. */
const KINDS = ["Worker", "Workflow", "D1 database", "KV namespace", "Hyperdrive config", "mail route"] as const;
type Kind = (typeof KINDS)[number];

/** Something that has the app's name but isn't recorded as its own, and where to delete it by hand. */
interface Kept {
  /** As `purged.kept` lists it for a script. */
  described: string;
  /** For a person: "the D1 database every-acme-chef". */
  shown: string;
  /** Where in the Cloudflare dashboard. */
  place: string;
}

const PLACES = {
  worker: "Compute (Workers) → Workers & Pages",
  d1: "Storage & Databases → D1",
  kv: "Storage & Databases → KV",
  workflow: "Compute (Workers) → Workflows",
} as const;

async function purgeApp(
  cf: CfRunner,
  registry: D1Database,
  accountId: string,
  out: EventSink,
  appId: string,
  deleted: RegisteredAppInfo,
): Promise<PurgeResult> {
  out.emit({
    type: "step",
    step: "app.purge",
    status: "start",
    message: `Deleting ${appId}'s Worker and data...`,
    data: { appId },
  });
  const counts = new Map<Kind, number>();
  const count = (kind: Kind) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const recorded = await readOwnedResources(registry, deleted.workerName);
  // Its mail routes first, so no rule names a Worker that is gone.
  const removed = await removeEmailRoutes({
    cf,
    gatewayDb: registry,
    accountId,
    workerName: deleted.workerName,
    routes: recorded.filter((resource) => resource.kind === "email-route"),
  });
  if (removed.length > 0) counts.set("mail route", removed.length);
  const owned = recorded.filter((resource) => resource.kind !== "email-route");
  const workflowsKept: Kept[] = [];
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
          const runner = workflow.script_name ?? "unknown";
          workflowsKept.push({
            described: `Workflow "${workflow.name}" (Worker ${runner}'s)`,
            shown: `the Workflow ${workflow.name}, which Worker ${runner} runs`,
            place: PLACES.workflow,
          });
        }
        continue;
      }
      if (await deleteWorkflowIfExists(cf, workflow.name)) {
        removed.push(`Workflow "${workflow.name}"`);
        count("Workflow");
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
      count(RESOURCE_LABELS[resource.kind] as Kind);
    } catch (error) {
      // Deleted already, by an earlier purge that stopped or by hand.
      if (!isCfError(error, "not_found")) throw error;
    }
  }
  await forgetOwnedResources(registry, deleted.workerName);

  const kept = [...(await unrecordedResources(cf, deleted, owned)), ...workflowsKept];
  const kinds = KINDS.flatMap((kind) => {
    const n = counts.get(kind) ?? 0;
    return n === 0 ? [] : [n === 1 ? kind : plural(n, kind)];
  });
  out.emit({
    type: "step",
    step: "app.purge",
    status: "ok",
    message: removed.length
      ? `Deleted ${removed.join(", ")}.`
      : "Nothing deleted in Cloudflare.",
    data: { appId, removed, kinds },
  });
  if (kept.length > 0) {
    const one = kept.length === 1;
    out.emit({
      type: "warning",
      code: "RESOURCES_KEPT",
      step: "app.purge",
      message: [
        `Kept ${listed(kept.map((resource) => resource.shown))}`,
        one
          ? `It has ${appId}'s name, but no deploy recorded creating it, so it may belong to something else.`
          : `They have ${appId}'s names, but no deploy recorded creating them, so they may belong to something else.`,
      ].join("\n"),
      data: {
        kept: kept.map((resource) => resource.described),
        fix: one
          ? `if it is ${appId}'s, delete it in the Cloudflare dashboard (${kept[0]!.place})`
          : `if they are ${appId}'s, delete them in the Cloudflare dashboard`,
      },
    });
  }
  return { removed, kept: kept.map((resource) => resource.described) };
}

/** What exists under the app's assigned names without being recorded as its own. */
async function unrecordedResources(
  cf: CfRunner,
  deleted: RegisteredAppInfo,
  owned: ReadonlyArray<{ kind: string; name: string; resourceId: string | null }>,
): Promise<Kept[]> {
  const recorded = new Set(
    owned.filter((r) => r.resourceId).map((r) => `${r.kind}:${r.name}`),
  );
  const kept: Kept[] = [];
  const keep = (kind: "worker" | "d1" | "kv", name: string) =>
    kept.push({
      described: describeResource({ kind, name }),
      shown: `the ${RESOURCE_LABELS[kind]} ${name}`,
      place: PLACES[kind],
    });
  if (
    !recorded.has(`worker:${deleted.workerName}`) &&
    (await getWorkerDeployment(cf, deleted.workerName))
  ) {
    keep("worker", deleted.workerName);
  }
  for (const kind of ["d1", "kv"] as const) {
    for (const name of new Set(Object.values(deleted.resources[kind]))) {
      if (recorded.has(`${kind}:${name}`)) continue;
      if (await (kind === "d1" ? findD1 : findKv)(cf, name)) keep(kind, name);
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
}): Promise<void> {
  // --purge, at a terminal: the app id typed, not a yes.
  if (flags.purge && interactive && !flags.yes) {
    const typed = (
      await askText(`Type ${appId} to confirm`, {
        context: [`This deletes ${appId}'s Worker and all its data for good.`],
      })
    ).trim();
    if (typed !== appId) {
      throw new CancelledError(
        typed ? `"${typed}" doesn't match ${appId}. Nothing deleted.` : "Cancelled. Nothing deleted.",
      );
    }
    return;
  }
  // Unattended, its rerun adds --yes, for a person to agree to (lib/errors.ts).
  await confirmUnlessYes({
    yes: flags.yes,
    interactive,
    question: `Delete ${appId} from the Gateway?`,
    unattended: "Deleting an app needs confirmation at a terminal, or --yes",
    context: ["Its Worker and data stay; --purge deletes them too."],
    cancelled: "Cancelled. Nothing deleted.",
  });
}
