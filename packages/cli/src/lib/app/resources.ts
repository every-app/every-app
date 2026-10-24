/**
 * An app's Worker, D1 databases and KV namespaces, under the names its
 * registration assigned (`every-<orgKey>-<appId>[--<binding>]`), and its
 * Hyperdrive configs, named `<worker>--<binding>` after its Worker. Its R2
 * buckets (`resources.r2`) only get their assigned names here: the ones
 * the built Workers bind are made after the Build Output is installed
 * (./buckets.ts; cf's prebuilt deploy creates none), never recorded, and
 * purging them is a later change.
 *
 * An existing one is used only when the gateway's D1 records it as the
 * app's (./ownership.ts): anything else under the app's name may belong to
 * another install or app, or to someone else entirely, and is refused, on
 * the first deploy and on every retry. A new one is recorded as the app's
 * before it is created, so a retry after any failure finds it again.
 */
import {
  isReservedName,
  RESOURCE_SEPARATOR,
} from "@every-app/perimeter/manifest";
import type { AppResources } from "@every-app/perimeter/registry";
import type { D1Database } from "@/lib/cf/d1";
import { isCfError } from "@/lib/cf/errors";
import {
  createD1,
  createKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import {
  cachesAs,
  connectsTo,
  createHyperdrive,
  findHyperdrive,
  updateHyperdrive,
  type HyperdriveCaching,
} from "@/lib/cf/hyperdrive";
import type { CfRunner } from "@/lib/cf/runner";
import type { HyperdriveConfig } from "@/lib/cf/schemas";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { EveryAppError } from "@/lib/errors";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { CLI, thisCommand } from "@/lib/output/command";
import type { InstallTarget } from "./installBuildOutput";
import {
  APP_SECRETS_FILE,
  hyperdriveOriginUrl,
  hyperdriveOriginVariable,
  parseOriginUrl,
  type AppSecrets,
  type HyperdriveOrigin,
} from "./deploySecrets";
import {
  describeResource,
  forgetOwnedResources,
  readOwnedResources,
  recordOwnedResource,
  RESOURCE_LABELS,
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
  onCreated?: (description: string, kind: OwnedResource["kind"]) => void;
  onRecreated?: (description: string, kind: OwnedResource["kind"]) => void;
  /** Said when an existing Hyperdrive config is adopted or pointed at a new origin. */
  onChanged?: (message: string) => void;
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
      `A Worker named ${workerName} already exists in this Cloudflare account\nNo deploy of this app created it; it may belong to another Gateway or project.`,
      { fix: "delete or rename it", rerun: thisCommand() },
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
  options: ProvisionOptions & {
    manifest: EveryAppCliManifest;
    /** The app's secrets file: the origins of its Hyperdrive configs. */
    secrets?: AppSecrets;
  },
): Promise<InstallTarget["resources"]> {
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

  const d1: NonNullable<InstallTarget["resources"]["d1"]> = {};
  for (const binding of manifest.resources?.d1 ?? []) {
    d1[binding] = {
      name: assignedName(registration, "d1", binding),
      id: await provision("d1", binding),
    };
  }
  const kv: NonNullable<InstallTarget["resources"]["kv"]> = {};
  for (const binding of manifest.resources?.kv ?? []) {
    kv[binding] = { id: await provision("kv", binding) };
  }
  const buckets = manifest.resources?.r2 ?? [];
  const r2 = buckets.length
    ? {
        r2: Object.fromEntries(
          buckets.map((binding) => [
            binding,
            { name: assignedName(registration, "r2", binding) },
          ]),
        ),
      }
    : {};
  const configs = manifest.resources?.hyperdrive ?? [];
  if (configs.length === 0) return { d1, kv, ...r2 };
  // Every origin is checked before any config is created or changed.
  const origins = new Map(
    configs.map(({ name: binding }) => {
      const origin = hyperdriveOriginUrl(options.secrets ?? {}, manifest, binding);
      return [
        binding,
        origin ? parseOriginUrl(origin.url, origin.variable) : null,
      ] as const;
    }),
  );
  const hyperdrive: NonNullable<InstallTarget["resources"]["hyperdrive"]> = {};
  for (const { name: binding, caching = "off" } of configs) {
    hyperdrive[binding] = {
      id: await provisionHyperdrive({
        ...options,
        owned,
        binding,
        name: hyperdriveNameFor(registration.workerName, binding),
        origin: origins.get(binding) ?? null,
        caching,
      }),
    };
  }
  return { d1, kv, ...r2, hyperdrive };
}

/**
 * The Hyperdrive config a binding uses, named after the app's Worker:
 * `every-acme-seo` and `HYPERDRIVE` → `every-acme-seo--hyperdrive`.
 */
function hyperdriveNameFor(workerName: string, binding: string): string {
  return `${workerName}${RESOURCE_SEPARATOR}${binding.toLowerCase().replaceAll("_", "-")}`;
}

/**
 * The app's Hyperdrive config for one binding, as for its D1 databases
 * (./resources.ts provisionOne) with three differences. One not recorded as
 * the app's is adopted when it connects to the origin in the app's secrets
 * file: whoever holds that URL holds the database already, so binding the
 * config gives the app nothing more. A recorded one whose host, port,
 * database or user differ from that origin is pointed at it. And its query
 * caching is kept as the manifest says (`caching`, off by default): the
 * deploy creates it that way and turns it back if it changed.
 */
async function provisionHyperdrive(
  options: ProvisionOptions & {
    owned: OwnedResource[];
    binding: string;
    name: string;
    origin: HyperdriveOrigin | null;
    caching: HyperdriveCaching;
  },
): Promise<string> {
  const { cf, gatewayDb, registration, owned, binding, name, origin, caching } = options;
  const { onRecreated, onChanged } = options;
  const { workerName } = registration;
  const resource = { kind: "hyperdrive" as const, binding, name };
  const description = describeResource(resource);
  const variable = hyperdriveOriginVariable(binding);
  const recorded = owned.find(
    (entry) =>
      entry.kind === "hyperdrive" &&
      entry.binding === binding &&
      entry.name === name,
  );
  const existing = await findHyperdrive(cf, name);
  /** Point the app's config at `origin` and its caching, where either differs. */
  const reconcile = async (config: HyperdriveConfig) => {
    const repoint = origin !== null && !connectsTo(config, origin);
    const recache = !cachesAs(config, caching);
    if (!repoint && !recache) return;
    // A config that caches nothing says so with every change.
    await updateHyperdrive(cf, config.id, {
      ...(repoint ? { origin } : {}),
      ...(recache || caching === "off" ? { caching } : {}),
    });
    if (repoint) {
      onChanged?.(`Pointed ${description} at the database in ${APP_SECRETS_FILE}.`);
    }
    if (recache) {
      onChanged?.(
        caching === "off"
          ? `Turned off query caching on ${description} (Hyperdrive never invalidates a cached read when the app writes; caching: "default" in everyapp.config.ts turns it on).`
          : `Turned on Hyperdrive's query caching on ${description} (caching: "default").`,
      );
    }
  };

  if (recorded?.resourceId) {
    if (existing?.id === recorded.resourceId) {
      await reconcile(existing);
      return existing.id;
    }
    if (existing) throw replacedError(resource, recorded.resourceId);
    onRecreated?.(description, resource.kind);
  } else if (recorded) {
    // Claimed, then created, but the id never recorded: it's this one.
    if (existing) {
      await recordOwnedResource(gatewayDb, workerName, {
        ...resource,
        resourceId: existing.id,
      });
      await reconcile(existing);
      return existing.id;
    }
  } else if (existing) {
    if (origin && connectsTo(existing, origin)) {
      await recordOwnedResource(gatewayDb, workerName, {
        ...resource,
        resourceId: existing.id,
      });
      onChanged?.(`Adopted ${description}, which connects to the database in ${APP_SECRETS_FILE}.`);
      await reconcile(existing);
      return existing.id;
    }
    throw new EveryAppError(
      "RESOURCE_NAME_TAKEN",
      `A Hyperdrive config named "${name}" already exists in this Cloudflare account\nNo deploy of this app created it.`,
      {
        fix: `to use it, set ${variable} in ${APP_SECRETS_FILE} to the URL of the database it connects to; otherwise delete or rename it`,
        rerun: thisCommand(),
      },
    );
  }

  if (!origin) {
    throw new EveryAppError(
      "HYPERDRIVE_ORIGIN_MISSING",
      `${binding} needs the database its Hyperdrive config connects to\nCreating the config needs its URL.`,
      {
        fix: `set ${variable} (or POSTGRES_DATABASE_URL, when it is the app's only config) in ${APP_SECRETS_FILE} to postgres://<user>:<password>@<host>:<port>/<database>`,
        rerun: thisCommand(),
      },
    );
  }
  return createClaimed(options, resource, () =>
    createHyperdrive(cf, name, origin, caching),
  );
}

function assignedName(
  registration: AppNaming,
  kind: "d1" | "kv" | "r2",
  binding: string,
): string {
  const name = registration.resources[kind][binding];
  if (!name || isReservedName(name)) {
    throw new EveryAppError(
      "RESOURCE_NAME_MISSING",
      `The Gateway assigned no usable ${RESOURCE_LABELS[kind]} name for binding ${binding}`,
      { rerun: `${CLI} setup`, rerunNote: "to upgrade the Gateway" },
    );
  }
  return name;
}

async function provisionOne(
  options: ProvisionOptions & {
    owned: OwnedResource[];
    kind: "d1" | "kv";
    binding: string;
    name: string;
    find: (name: string) => Promise<string | null>;
    create: (name: string) => Promise<string>;
  },
): Promise<string> {
  const { gatewayDb, registration, owned, kind, binding, name, find, create, onRecreated } =
    options;
  const { workerName } = registration;
  const resource = { kind, binding, name };
  const recorded = owned.find(
    (entry) =>
      entry.kind === kind && entry.binding === binding && entry.name === name,
  );
  const existing = await find(name);

  if (recorded?.resourceId) {
    if (existing === recorded.resourceId) return existing;
    if (existing) throw replacedError(resource, recorded.resourceId);
    onRecreated?.(describeResource(resource), kind);
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
      `A ${RESOURCE_LABELS[kind]} named "${name}" already exists in this Cloudflare account\nNo deploy of this app created it; it may belong to another Gateway, app or project.`,
      { fix: "delete or rename it", rerun: thisCommand() },
    );
  }

  return createClaimed(options, resource, () => create(name));
}

/**
 * Create one of the app's resources, recorded as the app's first: a retry
 * after a create whose id went unrecorded finds it by its name.
 */
async function createClaimed(
  { gatewayDb, registration, onCreated }: ProvisionOptions,
  resource: Omit<OwnedResource, "resourceId">,
  create: () => Promise<string>,
): Promise<string> {
  const { workerName } = registration;
  await recordOwnedResource(gatewayDb, workerName, {
    ...resource,
    resourceId: null,
  });
  let id: string;
  try {
    id = await create();
  } catch (error) {
    if (isCfError(error, "already_exists")) {
      // Someone else created it since the lookup: not ours.
      await forgetOwnedResources(gatewayDb, workerName, {
        kind: resource.kind,
        binding: resource.binding,
      });
      throw new EveryAppError(
        "RESOURCE_NAME_TAKEN",
        `${describeResource(resource)} was created by someone else while this deploy was creating it`,
        { fix: "delete or rename it", rerun: thisCommand() },
      );
    }
    throw error;
  }
  await recordOwnedResource(gatewayDb, workerName, {
    ...resource,
    resourceId: id,
  });
  onCreated?.(describeResource(resource), resource.kind);
  return id;
}

/** A resource under the app's name that isn't the one it recorded. */
function replacedError(
  resource: Pick<OwnedResource, "kind" | "name">,
  recordedId: string,
): EveryAppError {
  return new EveryAppError(
    "RESOURCE_REPLACED",
    `${describeResource(resource)} isn't the one this app created\nThat one (${recordedId}) was deleted, and this one was created by someone else since.`,
    { fix: "delete or rename it", rerun: thisCommand() },
  );
}
