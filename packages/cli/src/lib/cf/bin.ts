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
function resolveCliCfBinary(): Promise<CfBinary> {
  return resolveFrom(path.dirname(fileURLToPath(import.meta.url)), "cli");
}

/** The `cf` installed for `dir`, as `source`'s. */
async function resolveFrom(dir: string, source: CfBinary["source"]): Promise<CfBinary> {
  const { binPath, version } = await resolveLocalPackage(dir, "cf", "cf");
  return { path: binPath, version, source };
}

/**
 * The built-CLI test's seam (src/bin/builtCli.test.ts): with this set, the
 * file it names is cf for every call, whichever plane. The runner spawns
 * `node <path> …args` with the call's cwd and env, so a Node script stands
 * in for cf and answers from a fake account; the test runs `everyapp status`
 * from dist/ that way, with no Cloudflare login.
 */
const STAND_IN_ENV = "EVERYAPP_CF_BINARY";

/**
 * The `cf` to run a command with. Commands about one app (`cf dev`, local D1)
 * use the app's own `cf` when it has one: it is pinned next to the app's
 * Vite plugin, so both run the same Miniflare against `.cloudflare/state`.
 * Everything else uses the CLI's pin.
 */
export async function resolveCfBinary(projectRoot?: string): Promise<CfBinary> {
  const standIn = process.env[STAND_IN_ENV];
  if (standIn) return { path: standIn, version: PINNED_CF_VERSION, source: "cli" };
  if (projectRoot) {
    try {
      return await resolveFrom(projectRoot, "project");
    } catch {
      // The app doesn't install cf; fall back to the CLI's.
    }
  }
  return resolveCliCfBinary();
}
