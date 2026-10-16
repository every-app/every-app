import { execa } from "execa";
import { devRegistryEnv } from "@/lib/app/localD1";
import type { CfRunner } from "@/lib/cf/runner";
import type { EveryAppCliManifest } from "@/lib/manifest";

export interface AppDevServer {
  /** Settles when the dev server process exits. */
  readonly exited: Promise<unknown>;
  stop(): void;
}

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
 * travels in PORT and the app's vite.config.ts reads it. `cf dev` runs in its
 * own process group so stopping it also stops the Vite and workerd processes
 * it starts.
 */
export async function startAppDevServer({
  cwd,
  manifest,
  cf,
  port,
}: StartAppDevServerOptions): Promise<AppDevServer> {
  if (manifest.dev) {
    const child = execa(manifest.dev, [], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, PORT: String(port) },
      reject: false,
      shell: true,
    });
    return { exited: child, stop: () => child.kill("SIGTERM") };
  }

  const child = await cf.start({
    args: ["dev"],
    cwd,
    env: { PORT: String(port), ...devRegistryEnv(cwd) },
  });
  return { exited: child.exited, stop: () => child.stop("SIGTERM") };
}
