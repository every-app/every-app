/**
 * What an app's built Workers may be, checked on its Build Output (once
 * installed for the deploy, ./installBuildOutput.ts) before
 * `cf deploy --prebuilt` uploads them. An app's cloudflare.config.ts is the
 * app author's code; this keeps it from shipping a Worker the gateway's
 * model doesn't allow: public on workers.dev or a domain of its own,
 * without its identity keys or in dev mode, bound to another Worker or to
 * resources the deploy didn't provision for it or that aren't named after
 * it, with a binding type the model doesn't know, or giving away or
 * deleting Durable Object data.
 *
 * An app may also ship helper Workers (its manifest's `workers`), built as
 * auxiliary Workers beside its own. Each is private in the same way and
 * named after the app's Worker; only the app's Worker may bind it.
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
import {
  BUILD_OUTPUT_DIR,
  builtWorkers,
  DEFAULT_WORKER,
  isProductionBuild,
} from "./buildOutput";
import type { InstallTarget } from "./installBuildOutput";

type Binding = Record<string, unknown> & { type?: string };
type Export = Record<string, unknown> & { type?: string; state?: string };

/**
 * The binding types an app may use. Everything else is refused until the
 * model covers it: most reach account-wide resources by id or name (another
 * app's queue, dispatch namespace, private network, secrets store,
 * rate-limit counters, …), or account-wide capabilities the gateway is
 * meant to broker (email). Buckets and Workflows are allowed only under the
 * app's own names (buckets only as the manifest's `resources.r2`, when it
 * declares any), and Hyperdrive configs only as the ones the deploy
 * provisioned. Workers AI is account-wide inference billed to the account,
 * outside the Gateway's budgets, caps and usage tap (its `workers-ai`
 * provider is the brokered path), and the deploy provisions nothing to
 * check it against: so only under a binding name the manifest declares in
 * `resources.ai`, never one cloudflare.config.ts adds on its own. Browser
 * Rendering is the same: account-wide browser time billed to the account,
 * so only under a name `resources.browser` declares. Images the same, under
 * `resources.images`: transformations bill the account.
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
  "hyperdrive",
  "ai",
  "browser",
  "images",
]);

/**
 * Account-wide names an app owns: exactly its Worker's name, or it with the
 * resource separator. `every-acme-notes-archive` is app `notes-archive`'s
 * Worker, not one of app `notes`'s resources.
 */
/** The service binding every app Worker has: the gateway's AppGateway. */
function isGatewayBinding(name: string, binding: Binding): boolean {
  return (
    name === "EVERY_APP_GATEWAY" &&
    binding["worker"] === GATEWAY_WORKER_NAME &&
    binding["exportName"] === "AppGateway"
  );
}

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

type PolicyInputs = Pick<
  InstallTarget,
  | "workerName"
  | "resources"
  | "deletedDurableObjects"
  | "helperWorkers"
  | "declared"
>;

/** Everything wrong with the app's built Worker, as sentences; empty when it's fine. */
export function appPolicyProblems(
  config: BuiltWorkerConfig,
  inputs: PolicyInputs,
): string[] {
  const { workerName, helperWorkers = [] } = inputs;
  const problems: string[] = [];
  if (config.name !== workerName) {
    problems.push(`its name is "${config.name}", not "${workerName}"`);
  }
  problems.push(...privacyProblems(config));

  const env = config.env ?? {};
  for (const name of ["EVERYAPP_IDENTITY_PUBLIC_KEYS", "EVERYAPP_IDENTITY_ISSUER"]) {
    if (env[name]?.type !== "text") problems.push(`${name} isn't built in`);
  }
  // The gateway mints this Worker's identities for its name and nothing else.
  const audience = env["EVERYAPP_AUDIENCE"];
  if (audience?.type !== "text" || audience["value"] !== workerName) {
    problems.push(`EVERYAPP_AUDIENCE isn't the Worker's name ("${workerName}")`);
  }
  problems.push(
    ...bindingProblems(
      env,
      inputs,
      (name, binding) =>
        isGatewayBinding(name, binding) || helperWorkers.includes(String(binding["worker"])),
    ),
    ...exportProblems(
      config.exports ?? {},
      inputs.deletedDurableObjects ?? [],
      workerName,
    ),
  );
  return problems;
}

/**
 * Everything wrong with one of the app's built helper Workers: it is
 * private like the app, named after it, and reaches only the gateway (with
 * the app's identity) and the app's own resources.
 */
export function helperPolicyProblems(
  config: BuiltWorkerConfig,
  helperName: string,
  inputs: PolicyInputs,
): string[] {
  const problems: string[] = [];
  if (config.name !== helperName) {
    problems.push(`its name is "${config.name}", not "${helperName}"`);
  }
  problems.push(
    ...privacyProblems(config),
    ...bindingProblems(config.env ?? {}, inputs, isGatewayBinding),
    // No tombstones on a helper yet: its classes stay while it does.
    ...exportProblems(config.exports ?? {}, [], inputs.workerName),
  );
  return problems;
}

/** Reached only through the gateway: no public URL, domain or route. */
function privacyProblems(config: BuiltWorkerConfig): string[] {
  const problems: string[] = [];
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
  if (config.env?.["EVERYAPP_DEV"]) {
    problems.push("EVERYAPP_DEV is set, which only `everyapp dev` may do");
  }
  return problems;
}

/** Problems with a Worker's bindings; `mayBindWorker` decides service bindings. */
function bindingProblems(
  env: Record<string, Binding>,
  { workerName, resources, helperWorkers = [], declared }: PolicyInputs,
  mayBindWorker: (name: string, binding: Binding) => boolean,
): string[] {
  const problems: string[] = [];
  const appWorkers = new Set([workerName, ...helperWorkers]);
  const d1Ids = new Set(Object.values(resources.d1 ?? {}).map((d1) => d1.id));
  const kvIds = new Set(Object.values(resources.kv ?? {}).map((kv) => kv.id));
  const hyperdriveIds = new Set(
    Object.values(resources.hyperdrive ?? {}).map((config) => config.id),
  );
  // The manifest's buckets, when it declares any; otherwise any bucket
  // named after the app's Worker (one bound by hand in cloudflare.config.ts).
  const buckets = Object.values(resources.r2 ?? {}).map((bucket) => bucket.name);
  // Workers AI only under the names resources.ai declares.
  const aiBindings = declared?.ai ?? [];
  // Browser Rendering only under the names resources.browser declares.
  const browserBindings = declared?.browser ?? [];
  // Images only under the names resources.images declares.
  const imagesBindings = declared?.images ?? [];
  for (const [name, binding] of Object.entries(env)) {
    if (!ALLOWED_BINDINGS.has(String(binding.type))) {
      problems.push(
        `${name} is a ${String(binding.type)} binding, which Every App apps can't use`,
      );
      continue;
    }
    switch (binding.type) {
      case "worker":
        if (!mayBindWorker(name, binding)) {
          problems.push(
            `${name} binds Worker "${String(binding["worker"])}"; apps may only bind the gateway's AppGateway and, from the app's own Worker, its helper Workers`,
          );
        }
        break;
      case "durable-object":
        if (!appWorkers.has(String(binding["worker"]))) {
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
      // A config holds a database's credentials: only the app's own.
      case "hyperdrive":
        if (!hyperdriveIds.has(String(binding["id"]))) {
          problems.push(`${name} isn't a Hyperdrive config the deploy provisioned`);
        }
        break;
      case "ai":
        if (!aiBindings.includes(name)) {
          problems.push(
            aiBindings.length > 0
              ? `${name} is a Workers AI binding, which isn't one of the app's in resources.ai (${aiBindings.join(", ")})`
              : `${name} is a Workers AI binding, which everyapp.config.ts doesn't declare; list it in resources.ai`,
          );
        }
        break;
      case "browser":
        if (!browserBindings.includes(name)) {
          problems.push(
            browserBindings.length > 0
              ? `${name} is a Browser Rendering binding, which isn't one of the app's in resources.browser (${browserBindings.join(", ")})`
              : `${name} is a Browser Rendering binding, which everyapp.config.ts doesn't declare; list it in resources.browser`,
          );
        }
        break;
      case "images":
        if (!imagesBindings.includes(name)) {
          problems.push(
            imagesBindings.length > 0
              ? `${name} is an Images binding, which isn't one of the app's in resources.images (${imagesBindings.join(", ")})`
              : `${name} is an Images binding, which everyapp.config.ts doesn't declare; list it in resources.images`,
          );
        }
        break;
      case "r2": {
        const bucket = String(binding["name"] ?? "");
        if (buckets.length > 0) {
          if (!buckets.includes(bucket)) {
            problems.push(
              `${name} is bucket "${bucket}", which isn't one of the app's buckets in resources.r2 (${buckets.join(", ")})`,
            );
          }
        } else if (!isOwnResourceName(bucket, workerName)) {
          problems.push(
            `${name} is bucket "${bucket}"; an app's buckets are named after its Worker (${workerName} or ${workerName}${RESOURCE_SEPARATOR}<name>)`,
          );
        }
        break;
      }
      case "workflow": {
        // Workflow names are account-wide and name their instances, so an
        // app reaches only Workflows its own Workers define, named after it.
        const workflow = String(binding["name"] ?? "");
        if (
          !appWorkers.has(String(binding["worker"])) ||
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
  return problems;
}

/**
 * Durable Object exports may create, rename or keep classes. Deleting one
 * deletes its data, so only the classes the deploy dropped with
 * --allow-delete-durable-object-data may be; moving one's data to another
 * Worker, or taking another Worker's, never. None may be backed by a
 * container, which the deploy doesn't build, own or bill to an app.
 * Workflows must be named after the app's Worker.
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
    if (entry["container"] !== undefined) {
      problems.push(
        `Durable Object class ${name} is backed by a container, which Every App apps can't run`,
      );
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
 * Check the app's Build Output against the policy (its Worker and every
 * helper Worker the manifest declares), list each Worker's source maps for
 * upload, and validate each with cf's schema. Throws APP_POLICY with every
 * problem. Returns the Workflows each Worker defines, which cf creates or
 * updates as it deploys that Worker: `workflows` for the app's own, and
 * `helperWorkflows` by helper Worker name.
 */
export async function prepareAppBuildOutput({
  cwd,
  inputs,
}: {
  cwd: string;
  inputs: PolicyInputs;
}): Promise<{
  workflows: string[];
  helperWorkflows: Record<string, string[]>;
  /** The R2 buckets the Workers bind, by name (lib/app/buckets.ts makes the missing ones). */
  r2Buckets: string[];
}> {
  if (!(await isProductionBuild(path.join(cwd, BUILD_OUTPUT_DIR)))) {
    throw new EveryAppError(
      "APP_POLICY",
      "The app's Build Output isn't a production build. The manifest's build command must run `cf build` (production by default).",
    );
  }

  const built = await readBuiltWorkers(cwd);
  const helperWorkers = inputs.helperWorkers ?? [];
  const problems: string[] = [];
  const app = built.get(DEFAULT_WORKER);
  if (!app) {
    throw new EveryAppError(
      "APP_POLICY",
      "The app's Build Output has no default Worker. Build it from everyAppWorker() in cloudflare.config.ts.",
    );
  }
  problems.push(...appPolicyProblems(app.config, inputs));
  for (const [directory, { config }] of built) {
    if (directory === DEFAULT_WORKER) continue;
    const name = String(config.name);
    if (!helperWorkers.includes(name)) {
      problems.push(
        `the build has a Worker "${name}" that everyapp.config.ts doesn't declare in workers`,
      );
      continue;
    }
    problems.push(
      ...helperPolicyProblems(config, name, inputs).map(
        (problem) => `${name}: ${problem}`,
      ),
    );
  }
  for (const helper of helperWorkers) {
    if (![...built.values()].some(({ config }) => config.name === helper)) {
      problems.push(
        `the build has no Worker ${helper}, which everyapp.config.ts declares; add it to the Vite plugin's auxiliaryWorkers with everyAppAuxiliaryWorker()`,
      );
    }
  }
  if (problems.length > 0) {
    throw new EveryAppError(
      "APP_POLICY",
      `The built Worker can't be deployed as an Every App app:\n  - ${problems.join("\n  - ")}\nBuild it from everyAppWorker() in cloudflare.config.ts.`,
    );
  }

  const helperWorkflows: Record<string, string[]> = {};
  for (const [worker, { config, directory }] of built) {
    if (worker !== DEFAULT_WORKER) {
      const name = String(config.name);
      helperWorkflows[name] = definedWorkflows(config, name);
    }
    // cf uploads source maps only as listed modules; list every one.
    if (config.manifest) {
      const modules = { ...(config.manifest.modules ?? {}) };
      for (const map of await listSourceMaps(path.join(directory, "bundle"))) {
        modules[map] = { type: "sourcemap" };
      }
      config.manifest = { ...config.manifest, modules };
    }
    validateWorkerConfig(config);
    await fs.writeFile(
      path.join(directory, "worker.config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  return {
    workflows: definedWorkflows(app.config, inputs.workerName),
    helperWorkflows,
    r2Buckets: [...new Set([...built.values()].flatMap(({ config }) => boundR2Buckets(config)))].sort(),
  };
}

/** The names of the R2 buckets a built Worker's bindings name. */
function boundR2Buckets(config: BuiltWorkerConfig): string[] {
  const env = (config as { env?: Record<string, { type?: unknown; name?: unknown }> }).env ?? {};
  return Object.values(env)
    .filter((binding) => binding?.type === "r2" && typeof binding.name === "string")
    .map((binding) => binding.name as string);
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

/** Each Worker in the Build Output, by its directory name. */
async function readBuiltWorkers(
  cwd: string,
): Promise<Map<string, { config: BuiltWorkerConfig; directory: string }>> {
  const workers = new Map<
    string,
    { config: BuiltWorkerConfig; directory: string }
  >();
  for await (const { name, config, directory } of builtWorkers<BuiltWorkerConfig>(cwd)) {
    workers.set(name, { config, directory });
  }
  return workers;
}
