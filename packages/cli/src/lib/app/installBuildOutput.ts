/**
 * Installing an app's Build Output. Every production build is
 * tenant-neutral (`everyAppWorker()` in production mode builds from
 * `sentinelDeployTarget()`, @every-app/sdk/cloudflare): the same output
 * whoever builds it, with placeholders where an install's Worker name,
 * organization, gateway, identity keys and resources belong. Installing it
 * rewrites each Worker's `worker.config.json` in place for one install:
 *
 *   - the manifest's D1 databases, KV namespaces, Hyperdrive configs, R2
 *     buckets, queues and Vectorize indexes get the names and ids the
 *     deploy provisioned, by binding name, and each queue consumer trigger
 *     (and its dead-letter queue) the name of the queue its placeholder
 *     stands for;
 *   - its AI Gateways' `json` bindings get the gateway's `{ id, accountId,
 *     url }`: only a json binding whose `value.id` is its own binding's
 *     placeholder, never any other json binding;
 *   - its Secrets Store secrets get the store and secret the deploy made:
 *     only a binding whose `secretName` is its own binding's placeholder;
 *   - then every remaining placeholder string: the gateway URL (the
 *     identity issuer), the account, the organization, the identity keys, and the
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
import type { Resources } from "@every-app/perimeter/manifest";
import {
  BUILD_SENTINEL,
  resourceSentinel,
  type EveryAppDeployTarget,
} from "@every-app/sdk/cloudflare";
import { EveryAppError } from "@/lib/errors";
import { builtWorkers } from "./buildOutput";
import { RESOURCE_LABELS } from "./ownership";

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
  /**
   * The manifest's `resources` as everyapp.config.ts declares them. The
   * policy lets a binding the deploy provisions nothing for (Workers AI, Browser Rendering, Images, Analytics Engine)
   * through only under a name declared here: nothing else says the app
   * asked for it.
   */
  declared?: Resources;
}

type Binding = Record<string, unknown> & { type?: unknown };

interface WorkerConfig extends Record<string, unknown> {
  name?: unknown;
  env?: Record<string, Binding>;
  triggers?: Array<Record<string, unknown>>;
  exports?: Record<string, Record<string, unknown>>;
}

/** The kinds of placeholder resource. */
const RESOURCE_KINDS = ["d1", "kv", "hyperdrive", "r2", "vectorize"] as const;
type PlaceholderKind = (typeof RESOURCE_KINDS)[number];

function isPlaceholderKind(kind: string): kind is PlaceholderKind {
  return (RESOURCE_KINDS as readonly string[]).includes(kind);
}

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
  for (const trigger of installed.triggers ?? []) {
    if (trigger["type"] === "queue") installQueueTrigger(trigger, target);
  }
  if (target.shared && env["EVERY_APP_ORG_ID"]) {
    delete env["EVERY_APP_ORG_ID"];
    env["EVERYAPP_SHARED"] = { type: "text", value: "1" };
  }

  const keys = JSON.stringify([BUILD_SENTINEL.publicKey]);
  const result = mapStrings(installed, (value) =>
    value === keys
      ? JSON.stringify(target.identityPublicKeys)
      : // The gateway URL and the account first: they hold the Worker
        // name's placeholder.
        value
          .replaceAll(BUILD_SENTINEL.gatewayUrl, () => target.gatewayUrl)
          .replaceAll(BUILD_SENTINEL.accountId, () => target.accountId)
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
  for await (const { file, config } of builtWorkers(cwd)) {
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
  if (binding.type === "json") {
    installAiGateway(name, binding, target);
    return;
  }
  if (binding.type === "secrets-store-secret") {
    installStoreSecret(name, binding, target);
    return;
  }
  const kind = String(binding.type);
  if (kind === "queue") {
    if (binding["name"] !== resourceSentinel(name)) return;
    binding["name"] = provisionedQueue(name, target, `The build binds Queue ${name}`);
    return;
  }
  if (!isPlaceholderKind(kind)) return;
  const placeholder = resourceSentinel(name);
  const field = kind === "kv" || kind === "hyperdrive" ? "id" : "name";
  if (binding[field] !== placeholder) return;
  const resource = target.resources[kind]?.[name];
  if (!resource) {
    throw new EveryAppError(
      "INSTALL_INPUTS_MISSING",
      `The build binds ${RESOURCE_LABELS[kind]} ${name}, which the deploy didn't provision`,
      { fix: "declare it in everyapp.config.ts's resources" },
    );
  }
  Object.assign(binding, resource);
}

/** What a queue placeholder holds before its binding: `every-hosted--sentinel--`. */
const QUEUE_PLACEHOLDER_PREFIX = resourceSentinel("");

/**
 * A queue consumer trigger gets the name of the queue its placeholder
 * stands for (the placeholder holds the binding), and so does its
 * dead-letter queue. A name that isn't a placeholder was written by hand
 * in cloudflare.config.ts: it stays for the policy to judge.
 */
function installQueueTrigger(
  trigger: Record<string, unknown>,
  target: InstallTarget,
): void {
  for (const field of ["name", "deadLetterQueue"] as const) {
    const value = trigger[field];
    if (typeof value !== "string" || !value.startsWith(QUEUE_PLACEHOLDER_PREFIX)) continue;
    const binding = value.slice(QUEUE_PLACEHOLDER_PREFIX.length);
    trigger[field] = provisionedQueue(
      binding,
      target,
      `The build ${field === "name" ? "consumes" : "sends failed messages to"} Queue ${binding}`,
    );
  }
}

/** The name of the queue the deploy provisioned for a binding. */
function provisionedQueue(binding: string, target: InstallTarget, what: string): string {
  const queue = target.resources.queues?.[binding];
  if (!queue) {
    throw new EveryAppError(
      "INSTALL_INPUTS_MISSING",
      `${what}, which the deploy didn't provision`,
      { fix: "declare it in everyapp.config.ts's resources.queues" },
    );
  }
  return queue.name;
}

/**
 * An AI Gateway's binding, `{ type: "json", value: { id, accountId, url } }`,
 * gets the gateway the deploy provisioned: only when `value.id` is this
 * binding's placeholder. Any other json binding is the app's own data and
 * stays as it is.
 */
function installAiGateway(
  name: string,
  binding: Binding,
  target: InstallTarget,
): void {
  const value = binding["value"];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>)["id"] !== resourceSentinel(name)
  ) {
    return;
  }
  const gateway = target.resources.aiGateway?.[name];
  if (!gateway) {
    throw new EveryAppError(
      "INSTALL_INPUTS_MISSING",
      `The build binds ${RESOURCE_LABELS["ai-gateway"]} ${name}, which the deploy didn't provision`,
      { fix: "declare it in everyapp.config.ts's resources.aiGateway" },
    );
  }
  binding["value"] = {
    id: gateway.id,
    accountId: gateway.accountId,
    url: gateway.url,
  };
}

/**
 * A Secrets Store binding, `{ type: "secrets-store-secret", storeId,
 * secretName }`, gets the store and secret the deploy provisioned: only
 * when `secretName` is this binding's placeholder. One written by hand in
 * cloudflare.config.ts stays as it is, for the policy to refuse.
 */
function installStoreSecret(
  name: string,
  binding: Binding,
  target: InstallTarget,
): void {
  if (binding["secretName"] !== resourceSentinel(name)) return;
  const secret = target.resources.secretsStore?.[name];
  if (!secret) {
    throw new EveryAppError(
      "INSTALL_INPUTS_MISSING",
      `The build binds ${RESOURCE_LABELS["secrets-store-secret"]} ${name}, which the deploy didn't provision`,
      { fix: "declare it in everyapp.config.ts's resources.secretsStore" },
    );
  }
  binding["storeId"] = secret.storeId;
  binding["secretName"] = secret.secretName;
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
    BUILD_SENTINEL.accountId,
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
        `${binding} would be the Workflow "${name}", longer than Cloudflare's ${MAX_WORKFLOW_NAME_LENGTH} characters`,
        { fix: "shorten its binding name in everyapp.config.ts" },
      );
    }
  }
}
