/**
 * The production build of an app. `.everyapp/deploy.json` exists only while
 * the build runs; the result is the Build Output in `.cloudflare/output/v0`
 * that `cf deploy --prebuilt --mode production` uploads.
 *
 * `cf build` gets no `--mode`: cf refuses `--mode` for TanStack Start
 * projects, and Vite builds in production mode by default.
 *
 * Nothing the build prints reaches stdout: cf's output stays in memory and
 * a failure shows its last 20 lines, a manifest build command's goes to a
 * log file (lib/childLog.ts). With `verbose`, either streams to stderr.
 */
import { runLogged } from "@/lib/childLog";
import { CfError, outputTail } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
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
      await runLogged(buildCommand, [], {
        cwd,
        env: { ...process.env, ...env },
        shell: true,
        echo: verbose,
        what: "The app's build command",
        code: "BUILD_FAILED",
      });
      return;
    }
    await cf
      .run({
        args: ["build"],
        plane: "project",
        cwd,
        mode: "text",
        env,
        timeoutMs: BUILD_TIMEOUT_MS,
        ...(verbose
          ? { onOutput: (chunk: string) => void process.stderr.write(chunk) }
          : {}),
      })
      .catch((error: unknown) => {
        // A build's error is in what Vite printed, not only in cf's box.
        if (!(error instanceof CfError)) throw error;
        throw new EveryAppError(
          "BUILD_FAILED",
          [
            "cf build failed. Its last lines:",
            ...outputTail(error.stdout, error.stderr).map((line) => `  ${line}`),
          ].join("\n"),
        );
      });
  } finally {
    await removeDeployInputs(cwd);
  }
}
