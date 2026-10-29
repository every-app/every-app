/** Filesystem/schema adapter over the shared self-hosted Worker policy. */
import { EveryAppError } from "@/lib/errors";
import {
  listSourceMaps,
  validateWorkerConfig,
} from "@/lib/gateway/patchBuildOutput";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BUILD_OUTPUT_DIR,
  builtWorkers,
  DEFAULT_WORKER,
  isProductionBuild,
} from "./buildOutput";

import {
  appPolicyProblems,
  helperPolicyProblems,
  type BuiltWorkerConfig,
  type PolicyInputs,
} from "@every-app/perimeter/install";
export { appPolicyProblems, helperPolicyProblems } from "@every-app/perimeter/install";
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
}: { cwd: string; inputs: PolicyInputs }): Promise<{
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
      problems.push(`the build has a Worker "${name}" that everyapp.config.ts doesn't declare in workers`);
      continue;
    }
    problems.push(...helperPolicyProblems(config, name, inputs).map((problem) => `${name}: ${problem}`));
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
      `The built Worker can't be deployed as an EveryApp app:\n  - ${problems.join("\n  - ")}\nBuild it from everyAppWorker() in cloudflare.config.ts.`,
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
    await fs.writeFile(path.join(directory, "worker.config.json"), `${JSON.stringify(config, null, 2)}\n`);
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
