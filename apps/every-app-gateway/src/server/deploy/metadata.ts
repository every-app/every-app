/**
 * What a third-party app's Worker is allowed to be, and the upload
 * metadata the deployer sends for it: built from the app's manifest and its
 * registry row, never from what the bundle says. The bundle is built with
 * the sentinel deploy inputs (HOSTED_DEPLOY_SENTINEL), so every binding it
 * declares is a placeholder; the deployer REWRITES each binding it allows
 * and REFUSES the bundle when it declares any other:
 *
 *   allowed, rewritten         the app's id, audience (its Worker name),
 *                              identity keys and issuer, organization and
 *                              gateway URL as plain text; the gateway's
 *                              AppGateway service binding with the
 *                              registry's props; the D1 databases the
 *                              deployer created for it; its own Durable
 *                              Object classes; its static assets; version
 *                              metadata
 *   refused                    service bindings to anything else, dispatch
 *                              namespaces, another Worker's Durable
 *                              Objects, KV, R2, Hyperdrive, rate limits,
 *                              the secrets store, mTLS, Workers AI, email,
 *                              queues, any other secret or variable, and
 *                              whatever the deployer doesn't know
 *
 * and the Worker itself: no crons, routes, domains, tail consumers,
 * logpush, placement or limits of its own, no Workflows, no helper Workers,
 * no dev mode, at most the policy's Durable Object classes. Tags name its
 * organization and app; limits are the policy's; observability is on.
 */
import {
  GATEWAY_WORKER_NAME,
  HOSTED_DEPLOY_SENTINEL,
  type Manifest,
} from "@every-app/perimeter/manifest";
import type {
  WorkerAssetsConfig,
  WorkerBinding,
  WorkerMetadata,
  WorkerMigrations,
} from "@every-app/cf-rest";
import { bundleRefused } from "./errors";

type Binding = Record<string, unknown> & { type?: unknown };

/** The worker.config.json fields a third-party Worker may set. */
const ALLOWED_CONFIG_KEYS = new Set([
  "name",
  "compatibilityDate",
  "compatibilityFlags",
  "workersDev",
  "previewUrls",
  // Replaced by the deployer's own.
  "observability",
  "env",
  "exports",
  "manifest",
  "assets",
  "triggers",
]);

/** Flags that change nothing about what the Worker can reach. */
const ALLOWED_COMPATIBILITY_FLAGS = new Set([
  "nodejs_compat",
  "nodejs_compat_v2",
  "nodejs_als",
  "global_fetch_strictly_public",
]);

/** The platform's text bindings, which the deployer writes itself. */
const PLATFORM_TEXT = [
  "EVERYAPP_APP_ID",
  "EVERYAPP_AUDIENCE",
  "EVERYAPP_IDENTITY_PUBLIC_KEYS",
  "EVERYAPP_IDENTITY_ISSUER",
] as const;
/** Declared as secrets by the build; plain text on a third-party Worker. */
const PLATFORM_SECRETS = ["GATEWAY_URL", "EVERY_APP_ORG_ID"] as const;
const GATEWAY_BINDING = "EVERY_APP_GATEWAY";
const GATEWAY_ENTRYPOINT = "AppGateway";

export interface ThirdPartyLimits {
  cpuMs: number;
  subrequests: number;
  durableObjectClasses: number;
}

interface BuiltWorkerConfig {
  name?: unknown;
  compatibilityDate?: unknown;
  compatibilityFlags?: unknown;
  workersDev?: unknown;
  previewUrls?: unknown;
  triggers?: unknown;
  env?: Record<string, Binding>;
  exports?: Record<string, Binding & { state?: unknown }>;
  manifest?: {
    mainModule?: unknown;
    modules?: Record<string, { type?: unknown }>;
  };
  assets?: Record<string, unknown>;
}

function config(worker: Record<string, unknown>): BuiltWorkerConfig {
  return worker as BuiltWorkerConfig;
}

/** The manifest's Durable Object classes, by binding. */
function durableObjects(manifest: Manifest) {
  return (manifest.resources?.durableObjects ?? []) as Array<{
    name: string;
    className: string;
    worker?: string;
  }>;
}

/** Everything the hosted policy refuses in the manifest itself. */
export function manifestProblems(
  manifest: Manifest,
  limits: ThirdPartyLimits,
): string[] {
  const problems: string[] = [];
  if (manifest.workers?.length) {
    problems.push(
      "it declares helper Workers (workers), which third-party apps can't have",
    );
  }
  if (manifest.resources?.workflows?.length) {
    problems.push(
      "it declares Workflows, which third-party apps can't have yet",
    );
  }
  if (manifest.resources?.kv?.length) {
    problems.push(
      "it declares KV namespaces, which third-party apps can't have; use D1",
    );
  }
  const classes = durableObjects(manifest);
  if (classes.some((durableObject) => durableObject.worker)) {
    problems.push("a Durable Object class names a helper Worker");
  }
  if (classes.length > limits.durableObjectClasses) {
    problems.push(
      `it declares ${classes.length} Durable Object classes; a third-party app may have ${limits.durableObjectClasses}`,
    );
  }
  return problems;
}

/**
 * Everything wrong with the built Worker, as sentences; empty when it may
 * go. `hasAssets`: the upload holds static assets.
 */
export function bundleProblems(
  worker: Record<string, unknown>,
  manifest: Manifest,
  limits: ThirdPartyLimits,
  hasAssets: boolean,
): string[] {
  const built = config(worker);
  const problems = manifestProblems(manifest, limits);
  if (built.name !== HOSTED_DEPLOY_SENTINEL.workerName) {
    problems.push(
      `its Worker is named "${String(built.name)}": a deploy through the gateway builds with the hosted sentinel inputs (everyapp deploy --gateway)`,
    );
  }
  for (const key of Object.keys(worker)) {
    if (!ALLOWED_CONFIG_KEYS.has(key))
      problems.push(`it sets ${key}, which third-party Workers can't`);
  }
  if (built.workersDev !== false) problems.push("workersDev isn't false");
  if (built.previewUrls !== false) problems.push("previewUrls isn't false");
  if (
    Array.isArray(built.triggers)
      ? built.triggers.length > 0
      : built.triggers !== undefined
  ) {
    problems.push(
      "it declares triggers (crons or routes), which third-party apps can't have yet",
    );
  }
  if (typeof built.compatibilityDate !== "string")
    problems.push("it has no compatibility date");
  const flags = built.compatibilityFlags ?? [];
  if (!Array.isArray(flags))
    problems.push("its compatibility flags aren't a list");
  else {
    for (const flag of flags) {
      if (!ALLOWED_COMPATIBILITY_FLAGS.has(String(flag))) {
        problems.push(`compatibility flag ${String(flag)} isn't allowed`);
      }
    }
  }
  if (typeof built.manifest?.mainModule !== "string")
    problems.push("its Build Output names no main module");
  for (const key of Object.keys(built.assets ?? {})) {
    if (!["htmlHandling", "notFoundHandling", "runWorkerFirst"].includes(key)) {
      problems.push(`assets.${key} isn't allowed`);
    }
  }

  const d1 = new Set(manifest.resources?.d1 ?? []);
  const classes = new Map(
    durableObjects(manifest).map((d) => [d.name, d.className]),
  );
  for (const [name, binding] of Object.entries(built.env ?? {})) {
    const type = String(binding.type);
    const refuse = (why: string) => problems.push(`${name} ${why}`);
    if ((PLATFORM_TEXT as readonly string[]).includes(name)) {
      if (type !== "text")
        refuse(`is a ${type} binding; the platform sets it as text`);
      else if (name === "EVERYAPP_APP_ID" && binding["value"] !== manifest.id) {
        refuse(`isn't the manifest's id "${manifest.id}"`);
      }
      continue;
    }
    if ((PLATFORM_SECRETS as readonly string[]).includes(name)) {
      if (type !== "secret")
        refuse(`is a ${type} binding; the platform sets it`);
      continue;
    }
    switch (type) {
      case "worker":
        if (
          name !== GATEWAY_BINDING ||
          binding["worker"] !== GATEWAY_WORKER_NAME ||
          binding["exportName"] !== GATEWAY_ENTRYPOINT
        ) {
          refuse(
            `binds Worker "${String(binding["worker"])}"; a third-party app binds only the gateway's ${GATEWAY_ENTRYPOINT} as ${GATEWAY_BINDING}`,
          );
        }
        break;
      case "d1":
        if (!d1.has(name)) refuse("isn't a D1 database the manifest declares");
        break;
      case "durable-object":
        if (binding["worker"] !== built.name) {
          refuse(
            `binds another Worker's Durable Object ("${String(binding["worker"])}")`,
          );
        } else if (classes.get(name) !== binding["exportName"]) {
          refuse("isn't a Durable Object class the manifest declares");
        }
        break;
      case "assets":
        // Cloudflare refuses an assets binding without an assets upload.
        if (!hasAssets) {
          refuse(
            "is an assets binding, but the upload has no assets: the Build Output's assets directory is empty",
          );
        }
        break;
      case "version-metadata":
        break;
      case "secret":
        refuse(
          "is a secret; third-party apps can't have secrets of their own yet",
        );
        break;
      default:
        refuse(`is a ${type} binding, which third-party apps can't have`);
    }
  }
  if (built.env?.["EVERYAPP_DEV"])
    problems.push("EVERYAPP_DEV is set, which only `everyapp dev` may do");

  const declaredClasses = new Set(classes.values());
  for (const [className, entry] of Object.entries(built.exports ?? {})) {
    if (entry.type === "worker") continue;
    if (entry.type !== "durable-object") {
      problems.push(
        `export ${className} is a ${String(entry.type)}, which third-party apps can't declare`,
      );
    } else if (!declaredClasses.has(className)) {
      problems.push(
        `Durable Object class ${className} isn't one the manifest declares`,
      );
    } else if ((entry.state ?? "created") !== "created") {
      problems.push(
        `Durable Object class ${className} is ${String(entry.state)}, which the deployer doesn't do`,
      );
    }
  }
  return problems;
}

/** What the deployer knows of the app's Worker, from the registry and Cloudflare. */
export interface DeployTarget {
  appId: string;
  organizationId: string;
  /** The registry's Worker name, `every-<orgKey>-<appId>`. */
  workerName: string;
  gatewayUrl: string;
  /** The gateway's JWT_PUBLIC_KEY (SPKI PEM). */
  identityPublicKey: string;
  /** The D1 databases the deployer created for the app, by binding. */
  d1: Record<string, { name: string; id: string }>;
  limits: ThirdPartyLimits;
  /** The classes the live version has, and its migration tag (none: a new Worker). */
  durableObjects: {
    liveClasses: readonly string[];
    migrationTag: string | null;
  };
  /** The completion token of the assets upload, when the app has assets. */
  assetsJwt?: string;
}

/** The next Durable Object migration: `everyapp-v<n+1>`. */
function migrationsFor(
  manifest: Manifest,
  target: DeployTarget,
): WorkerMigrations | undefined {
  const live = new Set(target.durableObjects.liveClasses);
  const classes = durableObjects(manifest).map((d) => d.className);
  const removed = [...live].filter((className) => !classes.includes(className));
  if (removed.length > 0) {
    throw bundleRefused([
      `it drops the Durable Object class${removed.length === 1 ? "" : "es"} ${removed.join(", ")}, which deletes ${removed.length === 1 ? "its" : "their"} data; third-party deploys never do`,
    ]);
  }
  const added = classes.filter((className) => !live.has(className));
  if (added.length === 0) return undefined;
  const tag = target.durableObjects.migrationTag;
  const number = tag
    ? Number(/^everyapp-v(\d+)$/.exec(tag)?.[1] ?? Number.NaN)
    : 0;
  if (!Number.isInteger(number)) {
    throw bundleRefused([
      `its live Worker has the migration tag "${tag}", which the deployer didn't write`,
    ]);
  }
  return {
    ...(tag ? { old_tag: tag } : {}),
    new_tag: `everyapp-v${number + 1}`,
    new_sqlite_classes: added,
  };
}

function assetsConfig(
  assets: Record<string, unknown> | undefined,
): WorkerAssetsConfig {
  const result: WorkerAssetsConfig = {};
  if (assets?.["htmlHandling"] !== undefined) {
    result.html_handling = assets[
      "htmlHandling"
    ] as WorkerAssetsConfig["html_handling"];
  }
  if (assets?.["notFoundHandling"] !== undefined) {
    result.not_found_handling = assets[
      "notFoundHandling"
    ] as WorkerAssetsConfig["not_found_handling"];
  }
  if (typeof assets?.["runWorkerFirst"] === "boolean") {
    result.run_worker_first = assets["runWorkerFirst"];
  }
  return result;
}

/**
 * The bindings the deployer sends: every one rewritten from the manifest
 * and the target, whatever the bundle's placeholders said.
 */
function userWorkerBindings(
  built: BuiltWorkerConfig,
  manifest: Manifest,
  target: DeployTarget,
): WorkerBinding[] {
  const text = (name: string, value: string): WorkerBinding => ({
    type: "plain_text",
    name,
    text: value,
  });
  const bindings: WorkerBinding[] = [
    text("EVERYAPP_APP_ID", target.appId),
    // The gateway mints this Worker's identities for its name only.
    text("EVERYAPP_AUDIENCE", target.workerName),
    text(
      "EVERYAPP_IDENTITY_PUBLIC_KEYS",
      JSON.stringify([target.identityPublicKey]),
    ),
    text("EVERYAPP_IDENTITY_ISSUER", target.gatewayUrl),
    text("GATEWAY_URL", target.gatewayUrl),
    text("EVERY_APP_ORG_ID", target.organizationId),
    {
      type: "service",
      name: GATEWAY_BINDING,
      service: GATEWAY_WORKER_NAME,
      entrypoint: GATEWAY_ENTRYPOINT,
      props: {
        organizationId: target.organizationId,
        appId: target.appId,
        workerName: target.workerName,
      },
    },
  ];
  for (const binding of manifest.resources?.d1 ?? []) {
    const database = target.d1[binding];
    if (!database) throw new Error(`No D1 database for ${binding}`);
    bindings.push({ type: "d1", name: binding, id: database.id });
  }
  for (const durableObject of durableObjects(manifest)) {
    bindings.push({
      type: "durable_object_namespace",
      name: durableObject.name,
      class_name: durableObject.className,
    });
  }
  for (const [name, binding] of Object.entries(built.env ?? {})) {
    if (binding.type === "assets") bindings.push({ type: "assets", name });
    if (binding.type === "version-metadata")
      bindings.push({ type: "version_metadata", name });
  }
  return bindings;
}

/**
 * The upload metadata for a third-party app's Worker. Refuses (with every
 * problem) a bundle `bundleProblems` refuses, so no caller can upload one
 * it didn't check.
 */
export function buildUserWorkerMetadata({
  worker,
  manifest,
  target,
}: {
  worker: Record<string, unknown>;
  manifest: Manifest;
  target: DeployTarget;
}): WorkerMetadata {
  const problems = bundleProblems(
    worker,
    manifest,
    target.limits,
    Boolean(target.assetsJwt),
  );
  if (problems.length > 0) throw bundleRefused(problems);
  const built = config(worker);
  const migrations = migrationsFor(manifest, target);
  return {
    main_module: String(built.manifest?.mainModule),
    compatibility_date: String(built.compatibilityDate),
    compatibility_flags: ((built.compatibilityFlags ?? []) as unknown[]).map(
      String,
    ),
    bindings: userWorkerBindings(built, manifest, target),
    limits: {
      cpu_ms: target.limits.cpuMs,
      subrequests: target.limits.subrequests,
    },
    tags: [`org-${target.organizationId}`, `app-${target.appId}`, "kind-org"],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 },
    },
    ...(migrations ? { migrations } : {}),
    ...(target.assetsJwt
      ? {
          assets: { jwt: target.assetsJwt, config: assetsConfig(built.assets) },
        }
      : {}),
  };
}

/** A binding as compared after upload: keys sorted, so order never matters. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

/** Whether Cloudflare's listing of one binding says what the deployer sent. */
function listedAsSent(
  sent: WorkerBinding,
  listed: Record<string, unknown>,
  workerName: string,
): boolean {
  // Every field sent, `type` included, comes back unchanged. Fields
  // Cloudflare adds of its own (a service binding's `environment`, a
  // Durable Object binding's `namespace_id`) aren't the deployer's to check,
  // except the one that could point elsewhere: the class's Worker.
  for (const [key, value] of Object.entries(sent)) {
    if (
      JSON.stringify(canonical(value)) !==
      JSON.stringify(canonical(listed[key]))
    ) {
      return false;
    }
  }
  return !(
    sent.type === "durable_object_namespace" &&
    listed["script_name"] !== undefined &&
    listed["script_name"] !== workerName
  );
}

/**
 * The bindings that differ between what the deployer sent and what
 * Cloudflare lists for the Worker `workerName` now, by name; empty when
 * they match: the same names, once each, and each listed with every field
 * as sent.
 */
export function bindingMismatches(
  sent: readonly WorkerBinding[],
  listed: readonly unknown[],
  workerName: string,
): string[] {
  const listedByName = new Map<string, Array<Record<string, unknown>>>();
  for (const binding of listed) {
    const entry = (binding ?? {}) as Record<string, unknown>;
    const name = String(entry["name"]);
    listedByName.set(name, [...(listedByName.get(name) ?? []), entry]);
  }
  const sentNames = new Set(sent.map((binding) => binding.name));
  const mismatched = new Set(
    [...listedByName.keys()].filter((name) => !sentNames.has(name)),
  );
  for (const binding of sent) {
    const matches = listedByName.get(binding.name) ?? [];
    if (
      matches.length !== 1 ||
      !listedAsSent(binding, matches[0]!, workerName)
    ) {
      mismatched.add(binding.name);
    }
  }
  return [...mismatched].sort();
}
