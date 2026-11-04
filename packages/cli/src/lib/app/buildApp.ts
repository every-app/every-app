/**
 * The production build of an app: the tenant-neutral Build Output in
 * `.cloudflare/output/v0`, the same whoever builds it, which the deploy
 * then installs (@every-app/perimeter/install config.ts) and `cf deploy --prebuilt --mode
 * production` uploads. It runs with EVERYAPP_BUILD=1, without which
 * `everyAppWorker()` refuses to build for production.
 *
 * `cf build` records `mode: "production"`, which the policy requires, two
 * ways: a Vite app builds in production by default, and cf refuses `--mode`
 * for TanStack Start; an app without Vite is built by Wrangler, which
 * records the mode only from `--mode production`.
 *
 * Either build runs with the build's NODE_OPTIONS (lib/runtime.ts
 * `buildNodeOptions`; the runner adds them to `cf build` itself).
 *
 * Nothing the build prints reaches stdout: cf's output stays in memory and
 * a failure shows its last 20 lines, a manifest build command's goes to a
 * log file (lib/childLog.ts). With `verbose`, either streams to stderr.
 */
import { runLogged } from "@/lib/childLog";
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { outputTail } from "@/lib/output/text";
import { buildNodeOptions } from "@/lib/runtime";
import fs from "node:fs";
import path from "node:path";

const BUILD_TIMEOUT_MS = 600_000;
const BUILD_ENV = { EVERYAPP_BUILD: "1" };
const VITE_CONFIGS = ["js", "mjs", "cjs", "ts", "mts", "cts"].map((ext) => `vite.config.${ext}`);

/** cf's arguments for the default build of the app at `cwd`. */
function cfBuildArgs(cwd: string): string[] {
  const vite = VITE_CONFIGS.some((file) => fs.existsSync(path.join(cwd, file)));
  return vite ? ["build"] : ["build", "--mode", "production"];
}

interface BuildAppOptions {
  cwd: string;
  cf: CfRunner;
  /** The manifest's `build` command, when it overrides `cf build`. */
  buildCommand?: string;
  verbose: boolean;
}

export async function buildApp({
  cwd,
  cf,
  buildCommand,
  verbose,
}: BuildAppOptions): Promise<void> {
  if (buildCommand) {
    await runLogged(buildCommand, [], {
      cwd,
      env: {
        ...process.env,
        ...BUILD_ENV,
        NODE_OPTIONS: buildNodeOptions(process.env["NODE_OPTIONS"]),
      },
      shell: true,
      echo: verbose,
      what: "Build",
      code: "BUILD_FAILED",
    });
    return;
  }
  await cf
    .run({
      args: cfBuildArgs(cwd),
      plane: "project",
      cwd,
      mode: "text",
      env: BUILD_ENV,
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
          "Build failed",
          "cf build's last lines:",
          ...outputTail(error.stdout, error.stderr).map((line) => `  ${line}`),
        ].join("\n"),
      );
    });
}
