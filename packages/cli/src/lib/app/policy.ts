/**
 * What an app's built Worker may be, checked on its Build Output before
 * `cf deploy --prebuilt` uploads it. An app's cloudflare.config.ts is the
 * app author's code; this keeps it from shipping a Worker the gateway's
 * model doesn't allow: public on workers.dev or a domain of its own,
 * without its identity keys or in dev mode, bound to another Worker or to
 * resources the deploy didn't provision for it or that aren't named after
 * it, with a binding type the model doesn't know, or giving away or
 * deleting Durable Object data.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  GATEWAY_WORKER_NAME,
  RESOURCE_SEPARATOR,
} from "@every-app/perimeter/manifest";
import { EveryAppError } from "@/lib/errors";
import {
  listSourceMaps,
  validateWorkerConfig,
} from "@/lib/gateway/patchBuildOutput";
import type { DeployInputs } from "./deployInputs";

const OUTPUT_DIR = path.join(".cloudflare", "output", "v0");
const WORKER_DIR = path.join(OUTPUT_DIR, "workers", "default");

type Binding = Record<string, unknown> & { type?: string };
type Export = Record<string, unknown> & { type?: string; state?: string };

/**
 * The binding types an app may use. Everything else is refused until the
 * model covers it: most reach account-wide resources by id or name (another
 * app's queue, Hyperdrive config, dispatch namespace, private network,
 * secrets store, rate-limit counters, …), or account-wide capabilities the
 * gateway is meant to broker (Workers AI, email). Buckets and Workflows are
 * allowed only under the app's own names.
 */
const ALLOWED_BINDINGS = new Set([
  "text",
  "json",
  "secret",
  "version-metadata",
  "assets",
  "d1",
  "kv",
  "r2",
  "durable-object",
  "workflow",
  "worker",
]);

/**
 * Account-wide names an app owns: exactly its Worker's name, or it with the
 * resource separator. `every-acme-notes-archive` is app `notes-archive`'s
 * Worker, not one of app `notes`'s resources.
 */
function isOwnResourceName(resource: string, workerName: string): boolean {
  return (
    resource === workerName ||
    resource.startsWith(`${workerName}${RESOURCE_SEPARATOR}`)
  );
}

interface BuiltWorkerConfig extends Record<string, unknown> {
  name?: string;
  workersDev?: boolean;
  previewUrls?: boolean;
  domains?: string[];
  triggers?: Array<{ type?: string }>;
  env?: Record<string, Binding>;
  exports?: Record<string, Export>;
  manifest?: {
    type: string;
    mainModule: string;
    modules?: Record<string, { type: string }>;
  };
}

/** Everything wrong with the built Worker, as sentences; empty when it's fine. */
export function appPolicyProblems(
  config: BuiltWorkerConfig,
  {
    workerName,
    resources,
    deletedDurableObjects = [],
  }: Pick<DeployInputs, "workerName" | "resources" | "deletedDurableObjects">,
): string[] {
  const problems: string[] = [];
  if (config.name !== workerName) {
    problems.push(`its name is "${config.name}", not "${workerName}"`);
  }
  if (config.workersDev !== false) problems.push("workersDev isn't false");
  if (config.previewUrls !== false) problems.push("previewUrls isn't false");
  if (config.domains?.length) {
    problems.push("it declares domains (apps are served through the gateway)");
  }
  // Only cron schedules: routes would serve the app around the gateway, a
  // queue consumer could take another app's queue by name, and an email
  // trigger could claim the account's Email Routing addresses.
  for (const trigger of config.triggers ?? []) {
    if (trigger.type === "scheduled") continue;
    problems.push(
      trigger.type === "fetch"
        ? "it declares routes (apps are served through the gateway)"
        : `it declares a trigger of type "${String(trigger.type)}" (apps may only declare cron schedules)`,
    );
  }

  const env = config.env ?? {};
  for (const name of ["EVERYAPP_IDENTITY_PUBLIC_KEYS", "EVERYAPP_IDENTITY_ISSUER"]) {
    if (env[name]?.type !== "text") problems.push(`${name} isn't built in`);
  }
  if (env["EVERYAPP_DEV"]) {
    problems.push("EVERYAPP_DEV is set, which only `everyapp dev` may do");
  }
  // The gateway mints this Worker's identities for its name and nothing else.
  const audience = env["EVERYAPP_AUDIENCE"];
  if (audience?.type !== "text" || audience["value"] !== workerName) {
    problems.push(`EVERYAPP_AUDIENCE isn't the Worker's name ("${workerName}")`);
  }

  const d1Ids = new Set(Object.values(resources.d1 ?? {}).map((d1) => d1.id));
  const kvIds = new Set(Object.values(resources.kv ?? {}).map((kv) => kv.id));
  for (const [name, binding] of Object.entries(env)) {
    if (!ALLOWED_BINDINGS.has(String(binding.type))) {
      problems.push(
        `${name} is a ${String(binding.type)} binding, which Every App apps can't use`,
      );
      continue;
    }
    switch (binding.type) {
      case "worker":
        if (
          name !== "EVERY_APP_GATEWAY" ||
          binding["worker"] !== GATEWAY_WORKER_NAME ||
          binding["exportName"] !== "AppGateway"
        ) {
          problems.push(
            `${name} binds Worker "${String(binding["worker"])}"; apps may only bind the gateway's AppGateway`,
          );
        }
        break;
      case "durable-object":
        if (binding["worker"] !== workerName) {
          problems.push(
            `${name} binds another Worker's Durable Object ("${String(binding["worker"])}")`,
          );
        }
        break;
      case "d1":
        if (!d1Ids.has(String(binding["id"]))) {
          problems.push(`${name} isn't a D1 database the deploy provisioned`);
        }
        break;
      case "kv":
        if (!kvIds.has(String(binding["id"]))) {
          problems.push(`${name} isn't a KV namespace the deploy provisioned`);
        }
        break;
      case "r2": {
        const bucket = String(binding["name"] ?? "");
        if (!isOwnResourceName(bucket, workerName)) {
          problems.push(
            `${name} is bucket "${bucket}"; an app's buckets are named after its Worker (${workerName} or ${workerName}${RESOURCE_SEPARATOR}<name>)`,
          );
        }
        break;
      }
      case "workflow": {
        // A Workflow runs on the Worker that defines it: an app binds only
        // its own, under its own names.
        const workflow = String(binding["name"] ?? "");
        if (
          binding["worker"] !== workerName ||
          !isOwnResourceName(workflow, workerName)
        ) {
          problems.push(
            `${name} binds Workflow "${workflow}" of Worker "${String(binding["worker"])}"; an app binds only its own Workflows, named after its Worker (${workerName}${RESOURCE_SEPARATOR}<name>)`,
          );
        }
        break;
      }
    }
  }
  problems.push(
    ...exportProblems(config.exports ?? {}, deletedDurableObjects, workerName),
  );
  return problems;
}

/**
 * Durable Object exports may create, rename or keep classes. Deleting one
 * deletes its data, so only the classes the deploy dropped with
 * --allow-delete-durable-object-data may be; moving one's data to another
 * Worker, or taking another Worker's, never. Workflows are named after the
 * app's Worker.
 */
function exportProblems(
  exports: Record<string, Export>,
  deletedDurableObjects: readonly string[],
  workerName: string,
): string[] {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(exports)) {
    if (entry.type === "worker") continue;
    if (entry.type === "workflow") {
      const workflow = String(entry["name"] ?? "");
      if (!isOwnResourceName(workflow, workerName)) {
        problems.push(
          `Workflow ${name} is named "${workflow}"; an app's Workflows are named after its Worker (${workerName}${RESOURCE_SEPARATOR}<name>)`,
        );
      }
      continue;
    }
    if (entry.type !== "durable-object") {
      problems.push(
        `export ${name} is a ${String(entry.type)}, which Every App apps can't declare`,
      );
      continue;
    }
    switch (entry.state ?? "created") {
      case "created":
      case "renamed":
        break;
      case "deleted":
        if (!deletedDurableObjects.includes(name)) {
          problems.push(
            `Durable Object class ${name} is marked deleted, which deletes its data; remove it from everyapp.config.ts and deploy with --allow-delete-durable-object-data instead`,
          );
        }
        break;
      case "transferred":
        problems.push(
          `Durable Object class ${name} would move its data to Worker "${String(entry["transferredTo"])}"`,
        );
        break;
      case "expecting-transfer":
        problems.push(
          `Durable Object class ${name} would take the data of Worker "${String(entry["transferFrom"])}"'s class`,
        );
        break;
      default:
        problems.push(
          `Durable Object class ${name} has state "${entry.state}", which everyapp doesn't deploy`,
        );
    }
  }
  return problems;
}

/**
 * Check the app's Build Output against the policy, list its source maps for
 * upload, and validate it with cf's schema. Throws APP_POLICY with every
 * problem. Returns the Workflows the Worker defines, which cf creates or
 * updates as it deploys it.
 */
export async function prepareAppBuildOutput({
  cwd,
  inputs,
}: {
  cwd: string;
  inputs: Pick<
    DeployInputs,
    "workerName" | "resources" | "deletedDurableObjects"
  >;
}): Promise<{ workflows: string[] }> {
  const rootConfig = JSON.parse(
    await fs.readFile(path.join(cwd, OUTPUT_DIR, "config.json"), "utf8"),
  ) as { buildContext?: { mode?: string; isPreview?: boolean } };
  if (
    rootConfig.buildContext?.mode !== "production" ||
    rootConfig.buildContext.isPreview
  ) {
    throw new EveryAppError(
      "APP_POLICY",
      "The app's Build Output isn't a production build. The manifest's build command must run `cf build` (production by default).",
    );
  }

  const configPath = path.join(cwd, WORKER_DIR, "worker.config.json");
  const config = JSON.parse(
    await fs.readFile(configPath, "utf8"),
  ) as BuiltWorkerConfig;
  const problems = appPolicyProblems(config, inputs);
  if (problems.length > 0) {
    throw new EveryAppError(
      "APP_POLICY",
      `The built Worker can't be deployed as an Every App app:\n  - ${problems.join("\n  - ")}\nBuild it from everyAppWorker() in cloudflare.config.ts.`,
    );
  }

  // cf uploads source maps only as listed modules; list every one.
  if (config.manifest) {
    const modules = { ...(config.manifest.modules ?? {}) };
    for (const map of await listSourceMaps(path.join(cwd, WORKER_DIR, "bundle"))) {
      modules[map] = { type: "sourcemap" };
    }
    config.manifest = { ...config.manifest, modules };
  }
  validateWorkerConfig(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { workflows: definedWorkflows(config, inputs.workerName) };
}

/**
 * The Workflows cf creates or updates for this Worker: its workflow
 * exports, and any workflow binding to itself.
 */
function definedWorkflows(
  config: BuiltWorkerConfig,
  workerName: string,
): string[] {
  const names = [
    ...Object.values(config.exports ?? {})
      .filter((entry) => entry.type === "workflow")
      .map((entry) => String(entry["name"])),
    ...Object.values(config.env ?? {})
      .filter(
        (binding) =>
          binding.type === "workflow" && binding["worker"] === workerName,
      )
      .map((binding) => String(binding["name"])),
  ];
  return [...new Set(names)];
}
