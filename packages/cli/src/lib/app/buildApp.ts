/**
 * The production build of an app. `.everyapp/deploy.json` exists only while
 * the build runs; the result is the Build Output in `.cloudflare/output/v0`
 * that `cf deploy --prebuilt --mode production` uploads.
 *
 * `cf build` gets no `--mode`: cf refuses `--mode` for TanStack Start
 * projects, and Vite builds in production mode by default.
 */
import chalk from "chalk";
import { executeCommandWithFormatting } from "@/lib/formatting";
import type { CfRunner } from "@/lib/cf/runner";
import {
  removeDeployInputs,
  writeDeployInputs,
  type DeployInputs,
} from "./deployInputs";

const BUILD_TIMEOUT_MS = 600_000;

interface BuildAppOptions {
  cwd: string;
  cf: CfRunner;
  inputs: DeployInputs;
  /** The manifest's `build` command, when it overrides `cf build`. */
  buildCommand?: string;
  env: Record<string, string>;
  verbose: boolean;
}

export async function buildApp({
  cwd,
  cf,
  inputs,
  buildCommand,
  env,
  verbose,
}: BuildAppOptions): Promise<void> {
  await writeDeployInputs(cwd, inputs);
  try {
    if (buildCommand) {
      await executeCommandWithFormatting(buildCommand, [], {
        cwd,
        description: "Building your application...\n",
        env: { ...process.env, ...env },
        shell: true,
        verbose,
      });
      return;
    }
    console.log(chalk.dim("  Building your application with cf build..."));
    const result = await cf.run({
      args: ["build"],
      plane: "project",
      cwd,
      mode: "text",
      env,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (verbose && result.stdout.trim()) {
      console.log(chalk.dim(result.stdout.trimEnd()));
    }
  } finally {
    await removeDeployInputs(cwd);
  }
}
