/**
 * An app's Worker, D1 databases and KV namespaces, under the names the
 * gateway assigned at registration (`every-<orgKey>-<appId>[--<binding>]`,
 * legacy apps `every-<appId>[-<binding>]`).
 *
 * An existing one is used only when the gateway's D1 records it as the
 * app's (./ownership.ts): anything else under the app's name may belong to
 * another install or app, or to someone else entirely, and is refused, on
 * the first deploy and on every retry. A new one is recorded as the app's
 * before it is created, so a retry after any failure finds it again.
 *
 * Legacy apps, which the wrangler-era CLI deployed, have no records yet:
 * the first deploy with this CLI adopts their Worker and the resources it
 * created for them (see {@link adoptsLegacyResource}).
 */
import { isReservedName } from "@every-app/perimeter/manifest";
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
import type { AppResources } from "@/lib/gateway/api";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { DeployInputs } from "./deployInputs";
import {
  appWithWorkerNamed,
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
  recordOwnedResource,
  type OwnedResource,
} from "./ownership";

/** What the registration says about the app's names. */
interface AppNaming {
  workerName: string;
  legacyNames: boolean;
  /** Names from the registration, by kind and binding. */
  resources: AppResources;
  /** The manifest the app was last deployed (or, by older CLIs, registered) with. */
  previousManifest: unknown;
}

interface ProvisionOptions {
  cf: CfRunner;
  /** The gateway's D1, which holds the ownership records. */
  gatewayDb: D1Database;
  registration: AppNaming;
  /** Said for each resource created, adopted, or created again after it was deleted. */
  onCreated?: (description: string) => void;
  onAdopted?: (description: string) => void;
  onRecreated?: (description: string) => void;
}

/**
 * Make sure the Worker this deploy uploads is the app's: recorded as its
 * own, or not there yet (then recorded before the first upload).
 */
export async function claimAppWorker({
  cf,
  gatewayDb,
  registration,
  onAdopted,
}: ProvisionOptions): Promise<void> {
  const { workerName } = registration;
  const owned = await readOwnedResources(gatewayDb, workerName);
  if (owned.some((resource) => resource.kind === "worker")) return;
  const exists = (await getWorkerDeployment(cf, workerName)) !== null;
  if (exists && !registration.legacyNames) {
    throw new EveryAppError(
      "WORKER_NAME_TAKEN",
      `A Worker named ${workerName} already exists in this Cloudflare account, but no deploy of this app created it. It may belong to another gateway or project; delete or rename it, then deploy again.`,
    );
  }
  await recordOwnedResource(gatewayDb, workerName, {
    kind: "worker",
    binding: "",
    name: workerName,
    resourceId: workerName,
  });
  if (exists) onAdopted?.(`Worker ${workerName}`);
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
      `The gateway assigned no usable ${kind === "d1" ? "D1 database" : "KV namespace"} name for binding ${binding}. Upgrade the gateway (everyapp gateway upgrade).`,
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
  onAdopted,
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
  if (registration.legacyNames && name !== workerName) {
    const otherApp = await appWithWorkerNamed(gatewayDb, name);
    if (otherApp) {
      throw new EveryAppError(
        "RESOURCE_NAME_TAKEN",
        `${describeResource(resource)} is app ${otherApp}'s: it is named after that app's Worker, and matches this app's ${binding} binding only under the old naming. Give the binding another name, so this app gets one of its own, then deploy again.`,
      );
    }
  }
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
    if (!adoptsLegacyResource(registration, kind, binding)) {
      throw new EveryAppError(
        "RESOURCE_NAME_TAKEN",
        `A ${kind === "d1" ? "D1 database" : "KV namespace"} named "${name}" already exists in this Cloudflare account, but no deploy of this app created it. It may belong to another gateway, app or project; delete or rename it, then deploy again.`,
      );
    }
    await recordOwnedResource(gatewayDb, workerName, {
      ...resource,
      resourceId: existing,
    });
    onAdopted?.(describeResource(resource));
    return existing;
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

/**
 * A legacy app's resources were created by the wrangler-era CLI, which
 * kept no records, so its first deploy with this CLI adopts them: DB and KV,
 * named exactly after its Worker (no other registered app can have that
 * name), and any other binding its last manifest declared (never one named
 * after another app's Worker: see appWithWorkerNamed). One it adds now is
 * created fresh: its legacy name may be another project's.
 */
function adoptsLegacyResource(
  registration: AppNaming,
  kind: "d1" | "kv",
  binding: string,
): boolean {
  if (!registration.legacyNames) return false;
  if (binding === "DB" || binding === "KV") return true;
  const previous = registration.previousManifest as {
    resources?: Partial<Record<"d1" | "kv", unknown>>;
  } | null;
  const declared = previous?.resources?.[kind];
  return Array.isArray(declared) && declared.includes(binding);
}
