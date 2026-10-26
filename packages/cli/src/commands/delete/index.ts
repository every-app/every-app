import path from "node:path";
import chalk from "chalk";
import { queueNameFor, vectorizeNameFor } from "@every-app/perimeter/manifest";
import { gatewayFor, refuseGatewayNewerThanCli, type ReconcileSeams } from "@/commands/appGateway";
import { removeEmailRoutes } from "@/lib/app/emailRoutes";
import {
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
  RESOURCE_LABELS,
} from "@/lib/app/ownership";
import { deleteAiGateway } from "@/lib/cf/aiGateway";
import type { D1Database } from "@/lib/cf/d1";
import { isCfError } from "@/lib/cf/errors";
import {
  deleteD1,
  deleteKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import { deleteHyperdrive } from "@/lib/cf/hyperdrive";
import { deleteQueue, deleteQueueConsumer, listQueues } from "@/lib/cf/queues";
import { deleteR2Bucket, listR2Buckets } from "@/lib/cf/r2";
import { deleteStoreSecret } from "@/lib/cf/secretsStore";
import { deleteVectorizeIndex, getVectorizeIndex } from "@/lib/cf/vectorize";
import type { CfRunner } from "@/lib/cf/runner";
import { deleteWorker, getWorkerDeployment } from "@/lib/cf/workers";
import { deleteWorkflowIfExists, listWorkflows } from "@/lib/cf/workflows";
import { deleteHostCertificates } from "@/lib/domains/certificates";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { CancelledError } from "@/lib/errors";
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
import { cliVersion } from "@/lib/version";
import type { GatewayCommandFlags } from "../flags";

interface DeleteCommandFlags extends GatewayCommandFlags {
  purge?: boolean;
  yes?: boolean;
}

export async function deleteApp(flags: DeleteCommandFlags,
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
  // The live Gateway again, without the app's binding: refused before the
  // registry changes when it can't be had (GATEWAY_RELEASE_UNAVAILABLE).
  refuseGatewayNewerThanCli(connection.install);
  const newGateway = gatewayFor(reconcile, connection.install, out);
  await newGateway.source();
  out.emit({
    type: "step",
    step: "app.delete",
    status: "start",
    message: `Removing ${appId} from the Gateway...`,
    data: { appId },
  });
  // Whether Access had public routes or an /mcp of its to take back: read before the row is tombstoned.
  const surface = (await readPublicSurfaces(registry)).find((candidate) => candidate.appId === appId);
  const hadSurface = { publicRoutes: (surface?.publicPaths.length ?? 0) > 0, mcp: surface?.mcp ?? false };
  const deleted = await deleteFromRegistry(registry, appId, connection.deployer, Date.now(), { purge });
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
    { appId, surface: hadSurface, removing: true },
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
const KINDS = [
  "Worker",
  "Workflow",
  "D1 database",
  "KV namespace",
  "Hyperdrive config",
  "Queue",
  "R2 bucket",
  "Vectorize index",
  "AI Gateway",
  "Secrets Store secret",
  "mail route",
] as const;
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
  queue: "Compute (Workers) → Queues",
  r2: "Storage & Databases → R2 Object Storage",
  vectorize: "AI → Vectorize",
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
  const queuesKept: Kept[] = [];
  const bucketsKept: Kept[] = [];
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
  // Its Workers' queue consumers before the Workers: Cloudflare refuses to
  // delete a Worker that consumes a queue, its references or not (10064).
  if (owned.some((resource) => resource.kind === "queue" && resource.resourceId)) {
    await detachQueueConsumers(cf, ownWorkers);
  }
  // The Workers next, the app's before its helpers (it binds their
  // classes): they bind the databases, namespaces, Hyperdrive configs and
  // queues and Vectorize indexes (a config goes; the Postgres database it
  // connects to is never touched), and a queue a Worker binds can't be
  // deleted (11005).
  const order = (resource: (typeof owned)[number]) =>
    resource.kind !== "worker" ? 2 : resource.binding === "" ? 0 : 1;
  for (const resource of owned.sort((a, b) => order(a) - order(b))) {
    if (!resource.resourceId) continue;
    try {
      if (resource.kind === "worker") {
        if (!(await getWorkerDeployment(cf, resource.resourceId))) continue;
        const workerName = resource.resourceId;
        await deleteWorker(cf, workerName).catch(async (error: unknown) => {
          // A consumer the listing above missed (it lags a deploy by
          // seconds), or one added outside everyapp: detached, then again.
          if (!isCfError(error, "queue_consumer_worker")) throw error;
          await detachQueueConsumers(cf, new Set([workerName]));
          await deleteWorker(cf, workerName);
        });
      } else if (resource.kind === "d1") {
        await deleteD1(cf, resource.resourceId);
      } else if (resource.kind === "hyperdrive") {
        await deleteHyperdrive(cf, resource.resourceId);
      } else if (resource.kind === "queue") {
        await deleteQueue(cf, resource.resourceId);
      } else if (resource.kind === "r2") {
        // R2 refuses a bucket that still holds objects: kept, and said.
        try {
          await deleteR2Bucket(cf, resource.resourceId);
        } catch (error) {
          if (isCfError(error, "not_found")) throw error;
          bucketsKept.push({
            described: `${describeResource(resource)} (R2 refused to delete it: it may still hold objects)`,
            shown: `the R2 bucket ${resource.name}, which R2 refused to delete (empty it first)`,
            place: PLACES.r2,
          });
          continue;
        }
      } else if (resource.kind === "vectorize") {
        await deleteVectorizeIndex(cf, resource.resourceId);
      } else if (resource.kind === "ai-gateway") {
        // Its stored logs go with it.
        await deleteAiGateway(cf, resource.resourceId);
      } else if (resource.kind === "secrets-store-secret") {
        // Recorded as <store id>/<secret id>; the store itself stays.
        const [storeId = "", secretId = ""] = resource.resourceId.split("/");
        await deleteStoreSecret(cf, storeId, secretId);
      } else {
        await deleteKv(cf, resource.resourceId);
      }
      removed.push(describeResource(resource));
      count(RESOURCE_LABELS[resource.kind] as Kind);
    } catch (error) {
      // A queue another Worker (not the app's) still binds stays, said kept.
      if (resource.kind === "queue" && isCfError(error, "queue_in_use")) {
        queuesKept.push({
          described: `${describeResource(resource)} (a Worker that isn't ${appId}'s binds it)`,
          shown: `the Queue ${resource.name}, which a Worker that isn't ${appId}'s binds`,
          place: PLACES.queue,
        });
        continue;
      }
      // Deleted already, by an earlier purge that stopped or by hand.
      if (!isCfError(error, "not_found")) throw error;
    }
  }
  await forgetOwnedResources(registry, deleted.workerName);

  const kept = [
    ...(await unrecordedResources(cf, deleted, owned)),
    ...workflowsKept,
    ...queuesKept,
    ...bucketsKept,
  ];
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
  const keep = (kind: "worker" | "d1" | "kv" | "queue" | "r2" | "vectorize", name: string) =>
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
  // The queues its last manifest named, asked about only when it named any.
  const queueNames = storedQueueBindings(deleted.manifest)
    .map((binding) => queueNameFor(deleted.workerName, binding))
    .filter((name) => !recorded.has(`queue:${name}`));
  if (queueNames.length > 0) {
    const existing = new Set((await listQueues(cf)).map((queue) => queue.queue_name));
    for (const name of queueNames) if (existing.has(name)) keep("queue", name);
  }
  // The buckets it binds by name (the manifest's, and one named after its
  // Worker by hand), made before deploys recorded buckets or not made by it.
  const bucketNames = [...new Set([...Object.values(deleted.resources.r2), deleted.workerName])].filter(
    (name) => !recorded.has(`r2:${name}`),
  );
  if (bucketNames.length > 0) {
    const existing = new Set(await listR2Buckets(cf, deleted.workerName).catch(() => [] as string[]));
    for (const name of bucketNames) if (existing.has(name)) keep("r2", name);
  }
  // The indexes the last deployed manifest declares, by their names.
  for (const binding of storedVectorizeBindings(deleted.manifest)) {
    const name = vectorizeNameFor(deleted.workerName, binding);
    if (recorded.has(`vectorize:${name}`)) continue;
    if (await getVectorizeIndex(cf, name)) keep("vectorize", name);
  }
  return kept;
}

/**
 * Detach every queue consumer that is one of these Workers, on any queue,
 * so Cloudflare lets the Workers be deleted; the queues and their messages
 * stay.
 */
async function detachQueueConsumers(cf: CfRunner, workers: ReadonlySet<string>): Promise<void> {
  for (const queue of await listQueues(cf)) {
    for (const consumer of queue.consumers ?? []) {
      if (!consumer.consumer_id || !workers.has(consumer.script ?? "")) continue;
      try {
        await deleteQueueConsumer(cf, queue.queue_id, consumer.consumer_id);
      } catch (error) {
        if (!isCfError(error, "not_found")) throw error;
      }
    }
  }
}

/** The queue bindings of a stored manifest (`resources.queues[].name`), read loosely. */
function storedQueueBindings(manifest: unknown): string[] {
  const queues = (manifest as { resources?: { queues?: unknown } } | null)?.resources?.queues;
  if (!Array.isArray(queues)) return [];
  return queues.flatMap((queue: unknown) => {
    const name = (queue as { name?: unknown } | null)?.name;
    return typeof name === "string" ? [name] : [];
  });
}

/** The bindings of `resources.vectorize` in a stored manifest, read as JSON parsed it. */
function storedVectorizeBindings(manifest: RegisteredAppInfo["manifest"]): string[] {
  const resources = (manifest as { resources?: { vectorize?: unknown } } | null)?.resources;
  const entries = Array.isArray(resources?.vectorize) ? (resources.vectorize as unknown[]) : [];
  return entries.flatMap((entry) => {
    const name = (entry as { name?: unknown } | null)?.name;
    return typeof name === "string" ? [name] : [];
  });
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
