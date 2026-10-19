/**
 * Installing an app's Build Output. Every production build is
 * tenant-neutral (`everyAppWorker()` in production mode builds from
 * `sentinelDeployTarget()`, @every-app/sdk/cloudflare): the same output
 * whoever builds it, with placeholders where an install's Worker name,
 * organization, gateway, identity keys and resources belong. Installing it
 * rewrites each Worker's `worker.config.json` in place for one install:
 *
 *   - the manifest's D1 databases, KV namespaces, Hyperdrive configs and R2
 *     buckets get the names and ids the deploy provisioned, by binding name;
 *   - then every remaining placeholder string: the gateway URL (the
 *     identity issuer), the organization, the identity keys, and the
 *     Worker name wherever it appears (the Worker's own name, its audience,
 *     Durable Object and helper service bindings, Workflow names, buckets
 *     named after it);
 *   - a shared app's Workers trade EVERY_APP_ORG_ID for EVERYAPP_SHARED;
 *   - the app's Worker gets a tombstone for each Durable Object class the
 *     deploy deletes.
 *
 * It refuses an output a placeholder survives in. The app policy
 * (./policy.ts) then checks the installed output against the same target.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  BUILD_SENTINEL,
  resourceSentinel,
  type EveryAppDeployTarget,
} from "@every-app/sdk/cloudflare";
import { EveryAppError } from "@/lib/errors";

const WORKERS_DIR = path.join(".cloudflare", "output", "v0", "workers");
/** Cloudflare's limit on a Workflow's name. */
const MAX_WORKFLOW_NAME_LENGTH = 64;

/** One install of an app: what its build's placeholders become. */
export interface InstallTarget extends EveryAppDeployTarget {
  /**
   * A shared app (first-party, on the hosted gateway): one Worker for every
   * organization, which takes each request's organization from its
   * identity, so nothing pins it to the owner's.
   */
  shared?: boolean;
  /** Durable Object classes removed from the app; their data is deleted. */
  deletedDurableObjects?: readonly string[];
  /** The app's helper Workers, by full name (`<app worker>--<name>`). */
  helperWorkers?: readonly string[];
}

type Binding = Record<string, unknown> & { type?: unknown };

interface WorkerConfig extends Record<string, unknown> {
  name?: unknown;
  env?: Record<string, Binding>;
  exports?: Record<string, Record<string, unknown>>;
}

/** The kinds of placeholder resource, and the field each one rewrites. */
const RESOURCES = {
  d1: "D1 database",
  kv: "KV namespace",
  hyperdrive: "Hyperdrive config",
  r2: "R2 bucket",
} as const;

/**
 * One Worker's config, installed: a copy with every placeholder rewritten
 * for `target` (see the module comment). Throws INSTALL_INPUTS_MISSING for
 * a placeholder resource the target has none for, INSTALL_PLACEHOLDER_LEFT
 * when any placeholder survives.
 */
export function installWorkerConfig<T extends Record<string, unknown>>(
  config: T,
  target: InstallTarget,
): T {
  const installed = structuredClone(config) as WorkerConfig;
  const isAppWorker = installed.name === BUILD_SENTINEL.workerName;
  const env = installed.env ?? {};
  for (const [name, binding] of Object.entries(env)) {
    installResource(name, binding, target);
  }
  if (target.shared && env["EVERY_APP_ORG_ID"]) {
    delete env["EVERY_APP_ORG_ID"];
    env["EVERYAPP_SHARED"] = { type: "text", value: "1" };
  }

  const keys = JSON.stringify([BUILD_SENTINEL.publicKey]);
  const result = mapStrings(installed, (value) =>
    value === keys
      ? JSON.stringify(target.identityPublicKeys)
      : // The gateway URL first: it holds the Worker name's placeholder.
        value
          .replaceAll(BUILD_SENTINEL.gatewayUrl, () => target.gatewayUrl)
          .replaceAll(
            BUILD_SENTINEL.organizationId,
            () => target.organizationId,
          )
          .replaceAll(BUILD_SENTINEL.workerName, () => target.workerName),
  ) as WorkerConfig;

  if (isAppWorker && target.deletedDurableObjects?.length) {
    const exports = (result.exports ??= {});
    for (const className of target.deletedDurableObjects) {
      if (exports[className]) {
        throw new EveryAppError(
          "APP_POLICY",
          `Durable Object class ${className} is both exported by the build and being deleted; declare it in everyapp.config.ts, or stop exporting it.`,
        );
      }
      exports[className] = { type: "durable-object", state: "deleted" };
    }
  }

  const left = placeholdersIn(result);
  if (left.length > 0) {
    throw new EveryAppError(
      "INSTALL_PLACEHOLDER_LEFT",
      `The build of ${String(result.name)} still holds a build placeholder after installing it, at ${left.join(", ")}. Build the Worker from everyAppWorker() in cloudflare.config.ts, and leave its names, keys and ids to the deploy.`,
    );
  }
  assertWorkflowNames(result);
  return result as T;
}

/**
 * Install the app's Build Output in `cwd` for `target`: every Worker in
 * `.cloudflare/output/v0/workers`, rewritten in place.
 */
export async function installAppBuildOutput({
  cwd,
  target,
}: {
  cwd: string;
  target: InstallTarget;
}): Promise<void> {
  const workersDir = path.join(cwd, WORKERS_DIR);
  for (const entry of await fs.readdir(workersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(workersDir, entry.name, "worker.config.json");
    const config = JSON.parse(await fs.readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      file,
      `${JSON.stringify(installWorkerConfig(config, target), null, 2)}\n`,
    );
  }
}

/**
 * A manifest resource's binding gets the target's resource of that
 * binding. A binding of the kind that doesn't hold its placeholder was
 * written by hand in cloudflare.config.ts: it stays for the policy to judge.
 */
function installResource(
  name: string,
  binding: Binding,
  target: InstallTarget,
): void {
  const kind = String(binding.type);
  if (!Object.hasOwn(RESOURCES, kind)) return;
  const placeholder = resourceSentinel(name);
  const field = kind === "d1" || kind === "r2" ? "name" : "id";
  if (binding[field] !== placeholder) return;
  const resource = target.resources[kind as keyof typeof RESOURCES]?.[name];
  if (!resource) {
    throw new EveryAppError(
      "INSTALL_INPUTS_MISSING",
      `The build binds ${RESOURCES[kind as keyof typeof RESOURCES]} ${name}, which the deploy didn't provision. Declare it in everyapp.config.ts's resources, then deploy again.`,
    );
  }
  Object.assign(binding, resource);
}

/** `value` with `fn` applied to every string in it (not to keys). */
function mapStrings(value: unknown, fn: (value: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]),
    );
  }
  return value;
}

/** Where in `value` a placeholder (or one JSON-encoded) is, as paths. */
function placeholdersIn(value: unknown, at = ""): string[] {
  const placeholders = [
    BUILD_SENTINEL.workerName,
    BUILD_SENTINEL.organizationId,
    BUILD_SENTINEL.gatewayUrl,
    BUILD_SENTINEL.publicKey,
  ].flatMap((placeholder) => [
    placeholder,
    JSON.stringify(placeholder).slice(1, -1),
  ]);
  const holds = (text: string) =>
    placeholders.some((placeholder) => text.includes(placeholder));
  if (typeof value === "string") return holds(value) ? [at || "(root)"] : [];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      const where = at ? `${at}.${key}` : key;
      return holds(key) ? [where] : placeholdersIn(item, where);
    });
  }
  return [];
}

/**
 * Workflow names are named after the Worker, so only an installed build
 * knows whether one fits Cloudflare's limit.
 */
function assertWorkflowNames(config: WorkerConfig): void {
  const workflows = [
    ...Object.entries(config.env ?? {}),
    ...Object.entries(config.exports ?? {}),
  ].filter(([, entry]) => entry["type"] === "workflow");
  for (const [binding, entry] of workflows) {
    const name = String(entry["name"]);
    if (name.length > MAX_WORKFLOW_NAME_LENGTH) {
      throw new EveryAppError(
        "WORKFLOW_NAME_TOO_LONG",
        `${binding} would be the Workflow "${name}", longer than Cloudflare's ${MAX_WORKFLOW_NAME_LENGTH} characters; shorten its binding name in everyapp.config.ts.`,
      );
    }
  }
}
