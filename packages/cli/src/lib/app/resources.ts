/**
 * An app's Worker, D1 databases and KV namespaces, under the names its
 * registration assigned (`every-<orgKey>-<appId>[--<binding>]`).
 *
 * An existing one is used only when the gateway's D1 records it as the
 * app's (./ownership.ts): anything else under the app's name may belong to
 * another install or app, or to someone else entirely, and is refused, on
 * the first deploy and on every retry. A new one is recorded as the app's
 * before it is created, so a retry after any failure finds it again.
 */
import { isReservedName } from "@every-app/perimeter/manifest";
import type { AppResources } from "@every-app/perimeter/registry";
import type { D1Database } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import {
  createD1,
  createKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { EveryAppError } from "@/lib/errors";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { DeployInputs } from "./deployInputs";
import {
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
  recordOwnedResource,
  type OwnedResource,
} from "./ownership";

/** What the registration says about the app's names. */
interface AppNaming {
  workerName: string;
  /** Names from the registration, by kind and binding. */
  resources: AppResources;
}

interface ProvisionOptions {
  cf: CfRunner;
  /** The gateway's D1, which holds the ownership records. */
  gatewayDb: D1Database;
  registration: AppNaming;
  /** Said for each resource created, or created again after it was deleted. */
  onCreated?: (description: string) => void;
  onRecreated?: (description: string) => void;
}

/**
 * Make sure the Worker this deploy uploads is the app's: recorded as its
 * own, or not there yet (then recorded before the first upload). A helper
 * Worker is recorded under the app's Worker, by its name in `workers`.
 */
export async function claimAppWorker(
  { cf, gatewayDb, registration }: ProvisionOptions,
  /** A helper Worker (`workers`): its name there and its Worker's name. */
  helper?: { name: string; workerName: string },
): Promise<void> {
  const binding = helper?.name ?? "";
  const workerName = helper?.workerName ?? registration.workerName;
  const owned = await readOwnedResources(gatewayDb, registration.workerName);
  if (
    owned.some(
      (resource) => resource.kind === "worker" && resource.binding === binding,
    )
  ) {
    return;
  }
  if ((await getWorkerDeployment(cf, workerName)) !== null) {
    throw new EveryAppError(
      "WORKER_NAME_TAKEN",
      `A Worker named ${workerName} already exists in this Cloudflare account, but no deploy of this app created it. It may belong to another gateway or project; delete or rename it, then deploy again.`,
    );
  }
  await recordOwnedResource(gatewayDb, registration.workerName, {
    kind: "worker",
    binding,
    name: workerName,
    resourceId: workerName,
  });
}

export async function provisionAppResources(
  options: ProvisionOptions & { manifest: EveryAppCliManifest },
): Promise<DeployInputs["resources"]> {
  const { cf, registration, manifest } = options;
  const owned = await readOwnedResources(
    options.gatewayDb,
    registration.workerName,
  );
  const provision = (kind: "d1" | "kv", binding: string) =>
    provisionOne({
      ...options,
      owned,
      kind,
      binding,
      name: assignedName(registration, kind, binding),
      find: kind === "d1" ? (name) => findD1(cf, name) : (name) => findKv(cf, name),
      create:
        kind === "d1" ? (name) => createD1(cf, name) : (name) => createKv(cf, name),
    });

  const d1: NonNullable<DeployInputs["resources"]["d1"]> = {};
  for (const binding of manifest.resources?.d1 ?? []) {
    d1[binding] = {
      name: assignedName(registration, "d1", binding),
      id: await provision("d1", binding),
    };
  }
  const kv: NonNullable<DeployInputs["resources"]["kv"]> = {};
  for (const binding of manifest.resources?.kv ?? []) {
    kv[binding] = { id: await provision("kv", binding) };
  }
  return { d1, kv };
}

function assignedName(
  registration: AppNaming,
  kind: "d1" | "kv",
  binding: string,
): string {
  const name = registration.resources[kind][binding];
  if (!name || isReservedName(name)) {
    throw new EveryAppError(
      "RESOURCE_NAME_MISSING",
      `The gateway assigned no usable ${kind === "d1" ? "D1 database" : "KV namespace"} name for binding ${binding}. Upgrade the gateway: ${CLI} setup`,
    );
  }
  return name;
}

async function provisionOne({
  gatewayDb,
  registration,
  owned,
  kind,
  binding,
  name,
  find,
  create,
  onCreated,
  onRecreated,
}: ProvisionOptions & {
  owned: OwnedResource[];
  kind: "d1" | "kv";
  binding: string;
  name: string;
  find: (name: string) => Promise<string | null>;
  create: (name: string) => Promise<string>;
}): Promise<string> {
  const { workerName } = registration;
  const resource = { kind, binding, name };
  const recorded = owned.find(
    (entry) =>
      entry.kind === kind && entry.binding === binding && entry.name === name,
  );
  const existing = await find(name);

  if (recorded?.resourceId) {
    if (existing === recorded.resourceId) return existing;
    if (existing) {
      throw new EveryAppError(
        "RESOURCE_REPLACED",
        `${describeResource(resource)} isn't the one this app created (${recorded.resourceId}): that was deleted, and this one was created by someone else since. Delete or rename it, then deploy again.`,
      );
    }
    onRecreated?.(describeResource(resource));
  } else if (recorded) {
    // Claimed, then created, but the id never recorded: it's this one.
    if (existing) {
      await recordOwnedResource(gatewayDb, workerName, {
        ...resource,
        resourceId: existing,
      });
      return existing;
    }
  } else if (existing) {
    throw new EveryAppError(
      "RESOURCE_NAME_TAKEN",
      `A ${kind === "d1" ? "D1 database" : "KV namespace"} named "${name}" already exists in this Cloudflare account, but no deploy of this app created it. It may belong to another gateway, app or project; delete or rename it, then deploy again.`,
    );
  }

  // Claim the name first: a retry after a create whose id went unrecorded
  // finds the resource by it.
  await recordOwnedResource(gatewayDb, workerName, {
    ...resource,
    resourceId: null,
  });
  let id: string;
  try {
    id = await create(name);
  } catch (error) {
    if (error instanceof CfError && error.kind === "already_exists") {
      // Someone else created it since the lookup: not ours.
      await forgetOwnedResources(gatewayDb, workerName, { kind, binding });
      throw new EveryAppError(
        "RESOURCE_NAME_TAKEN",
        `${describeResource(resource)} was created by someone else while this deploy was creating it. Delete or rename it, then deploy again.`,
      );
    }
    throw error;
  }
  await recordOwnedResource(gatewayDb, workerName, {
    ...resource,
    resourceId: id,
  });
  onCreated?.(describeResource(resource));
  return id;
}
