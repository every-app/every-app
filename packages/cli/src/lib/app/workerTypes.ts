/**
 * The app's typed `Env`: `cf workers types` writes it to
 * `.cloudflare/types/index.d.ts` from cloudflare.config.ts, and the app's
 * tsconfig includes that file. `everyapp create` generates it and
 * `everyapp dev` does when a fresh clone has none yet.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { CfRunner } from "@/lib/cf/runner";

export const WORKER_TYPES_FILE = ".cloudflare/types/index.d.ts";

export async function generateWorkerTypes(
  cf: CfRunner,
  cwd: string,
): Promise<void> {
  await cf.run({
    args: ["workers", "types"],
    plane: "project",
    cwd,
    mode: "text",
  });
}

/** Generate the types unless they exist. Returns whether it generated them. */
export async function ensureWorkerTypes(
  cf: CfRunner,
  cwd: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, WORKER_TYPES_FILE));
    return false;
  } catch {
    await generateWorkerTypes(cf, cwd);
    return true;
  }
}
