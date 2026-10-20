import { devRegistryEnv } from "@/lib/app/localD1";
import type { CfRunner } from "@/lib/cf/runner";
import { spawnLongRunning, type LongRunningProcess } from "@/lib/longRunning";
import type { EveryAppCliManifest } from "@/lib/manifest";

export type AppDevServer = LongRunningProcess;

interface StartAppDevServerOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
  cf: CfRunner;
  /** Internal loopback port the gateway-lite proxies to. */
  port: number;
}

/**
 * Start the app's dev server on `port`: the manifest's `dev` command when it
 * has one, otherwise `cf dev`. cf forwards no port flag to Vite, so the port
 * travels in PORT and the app's vite.config.ts reads it. Either runs in its
 * own process group, so stopping it also stops the Vite and workerd
 * processes it starts, and its output is held until it is ready: its
 * startup banner names the internal port, which nobody should open.
 */
export async function startAppDevServer({
  cwd,
  manifest,
  cf,
  port,
}: StartAppDevServerOptions): Promise<AppDevServer> {
  if (manifest.dev) {
    return spawnLongRunning({
      command: manifest.dev,
      args: [],
      cwd,
      env: { ...process.env, PORT: String(port) },
      shell: true,
      hold: true,
    });
  }
  return cf.start({
    args: ["dev"],
    cwd,
    env: { PORT: String(port), ...devRegistryEnv(cwd) },
    holdOutput: true,
  });
}
