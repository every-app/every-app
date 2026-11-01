/**
 * The Build Output `cf build` writes (v0), the app's and the Gateway
 * release's alike: a root `config.json` saying how it was built, and a
 * directory per Worker under `workers/` (`default` for the main one), each
 * with its `worker.config.json` and `bundle/`.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** The Build Output, relative to the root it was built in. */
export const BUILD_OUTPUT_DIR = path.join(".cloudflare", "output", "v0");
/** The Build Output's Workers, relative to the root it was built in. */
export const WORKERS_DIR = path.join(BUILD_OUTPUT_DIR, "workers");
/** The main Worker's directory under {@link WORKERS_DIR}. */
export const DEFAULT_WORKER = "default";

/**
 * Each Worker in the Build Output under `cwd`, read as it is reached: its
 * directory's name, the directory, and its parsed worker.config.json.
 */
export async function* builtWorkers<Config = Record<string, unknown>>(
  cwd: string,
): AsyncGenerator<{ name: string; directory: string; file: string; config: Config }> {
  const workersDir = path.join(cwd, WORKERS_DIR);
  for (const entry of await fs.readdir(workersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(workersDir, entry.name);
    const file = path.join(directory, "worker.config.json");
    const config = JSON.parse(await fs.readFile(file, "utf8")) as Config;
    yield { name: entry.name, directory, file, config };
  }
}

/** Whether the Build Output at `dir` is a production build (`cf build`'s default), not a preview. */
export async function isProductionBuild(dir: string): Promise<boolean> {
  const rootConfig = JSON.parse(
    await fs.readFile(path.join(dir, "config.json"), "utf8"),
  ) as { buildContext?: { mode?: string; isPreview?: boolean } };
  return rootConfig.buildContext?.mode === "production" && !rootConfig.buildContext.isPreview;
}
