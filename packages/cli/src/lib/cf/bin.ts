import path from "node:path";
import { fileURLToPath } from "node:url";
import { dependencies } from "../../../package.json";
import { resolveLocalPackage } from "@/lib/local-package-bin";

/** The exact `cf` version this CLI depends on and is tested against. */
export const PINNED_CF_VERSION: string = dependencies.cf;

export interface CfBinary {
  /** Absolute path of the `cf` bin script, run with this Node. */
  path: string;
  version: string;
  /** Whose `cf` this is: the app's own devDependency, or the CLI's pin. */
  source: "project" | "cli";
}

/**
 * The CLI's own pinned `cf`, never a global one. Resolved from this module's
 * location, which is inside the installed `everyapp` package.
 */
async function resolveCliCfBinary(): Promise<CfBinary> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { binPath, version } = await resolveLocalPackage(here, "cf", "cf");
  return { path: binPath, version, source: "cli" };
}

/**
 * The `cf` to run a command with. Commands about one app (`cf dev`, local D1)
 * use the app's own `cf` when it has one: it is pinned next to the app's
 * Vite plugin, so both run the same Miniflare against `.cloudflare/state`.
 * Everything else uses the CLI's pin.
 */
export async function resolveCfBinary(projectRoot?: string): Promise<CfBinary> {
  if (projectRoot) {
    try {
      const { binPath, version } = await resolveLocalPackage(
        projectRoot,
        "cf",
        "cf",
      );
      return { path: binPath, version, source: "project" };
    } catch {
      // The app doesn't install cf; fall back to the CLI's.
    }
  }
  return resolveCliCfBinary();
}
