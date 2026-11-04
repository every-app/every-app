/**
 * The app's Build Output on disk, for the shared install engine and policy
 * (@every-app/perimeter/install): reading its Workers, and writing them
 * back once installed and checked, each with its source maps listed and
 * validated against cf's schema.
 */
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
  isProductionBuild,
  WORKERS_DIR,
} from "./buildOutput";

import {
  checkBuildOutput,
  type BuiltWorkerConfig,
  type PolicyInputs,
} from "@every-app/perimeter/install";
export { appPolicyProblems, helperPolicyProblems } from "@every-app/perimeter/install";

/**
 * The production Build Output's Workers under `cwd`, by directory
 * (`default` the app's own). Throws APP_POLICY for a preview build.
 */
export async function readBuildOutput(cwd: string): Promise<Map<string, BuiltWorkerConfig>> {
  if (!(await isProductionBuild(path.join(cwd, BUILD_OUTPUT_DIR)))) {
    throw new EveryAppError(
      "APP_POLICY",
      "The app's Build Output isn't a production build. Make the manifest's build command run `cf build --mode production` (plain `cf build` for a Vite app).",
    );
  }
  const workers = new Map<string, BuiltWorkerConfig>();
  for await (const { name, config } of builtWorkers<BuiltWorkerConfig>(cwd)) {
    workers.set(name, config);
  }
  return workers;
}

/**
 * Write each Worker back to the Build Output under `cwd`, as cf deploys
 * it: cf uploads source maps only as listed modules, so every one is
 * listed, and each config is validated with cf's schema.
 */
export async function writeBuildOutput(
  cwd: string,
  workers: Iterable<{ directory: string; config: BuiltWorkerConfig }>,
): Promise<void> {
  for (const { directory, config } of workers) {
    const dir = path.join(cwd, WORKERS_DIR, directory);
    if (config.manifest) {
      const modules = { ...(config.manifest.modules ?? {}) };
      for (const map of await listSourceMaps(path.join(dir, "bundle"))) {
        modules[map] = { type: "sourcemap" };
      }
      config.manifest = { ...config.manifest, modules };
    }
    validateWorkerConfig(config);
    await fs.writeFile(path.join(dir, "worker.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
}

/**
 * Check the app's tenant-neutral Build Output against the policy (its
 * Worker and every helper Worker the manifest declares) before it is packed
 * as a release, and write it back with its source maps listed. Throws
 * APP_POLICY with every problem.
 */
export async function prepareAppBuildOutput({
  cwd,
  inputs,
}: { cwd: string; inputs: PolicyInputs }): Promise<void> {
  const workers = await readBuildOutput(cwd);
  try {
    checkBuildOutput(workers, inputs);
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
  await writeBuildOutput(
    cwd,
    [...workers].map(([directory, config]) => ({ directory, config })),
  );
}
