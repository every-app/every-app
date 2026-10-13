/**
 * cf builds and serves an app through its package manager (`pnpm vite
 * build`), and what that runs uses the first `node` on PATH, which the
 * runner makes this CLI's Node (privateDir.ts, thisNodeBinDir). A package
 * manager can put another Node first again for what it runs: a Volta shim
 * does, for the project's `volta.node` pin, and so does pnpm's
 * `use-node-version`. One older than 22.18 can't load cloudflare.config.ts,
 * and the build fails with an obscure `Unknown file extension ".ts"`. So
 * before `cf build` or `cf dev`, the package manager is asked which Node it
 * runs things on.
 */
import { execa } from "execa";
import { EveryAppError } from "@/lib/errors";
import { detectPackageManager } from "@/lib/package-manager";
import { loadsCloudflareConfig, MIN_NODE_VERSION } from "@/lib/runtime";

const PROBE_TIMEOUT_MS = 60_000;

/** cf commands that run the project's package manager. */
export function runsPackageManager(args: readonly string[]): boolean {
  return args[0] === "build" || args[0] === "dev";
}

export async function assertToolchainNode(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const probe = ["node", "-p", "process.versions.node"];
  let packageManager: Awaited<ReturnType<typeof detectPackageManager>>;
  let version: string;
  try {
    packageManager = await detectPackageManager(cwd);
    const args =
      packageManager === "yarn"
        ? probe
        : packageManager === "npm"
          ? ["exec", "--", ...probe]
          : ["exec", ...probe];
    const { stdout } = await execa(packageManager, args, {
      cwd,
      env,
      extendEnv: false,
      stdin: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    version = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  } catch {
    // It doesn't run at all (or package.json doesn't parse): cf says so,
    // in its own words.
    return;
  }
  if (!/^\d+\.\d+\.\d+$/.test(version) || loadsCloudflareConfig(version)) {
    return;
  }
  throw new EveryAppError(
    "NODE_TOO_OLD",
    `${packageManager} runs this project's tools on Node.js ${version}, though everyapp runs on ${process.versions.node}: something pins it for this project (a Volta \`volta.node\` in package.json, pnpm's use-node-version). cf needs Node.js ${MIN_NODE_VERSION} or newer to load cloudflare.config.ts. Raise the pin (\`volta pin node@22\`, for Volta), then run this again.`,
  );
}
