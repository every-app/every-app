/**
 * The app's typed `Env`: `cf workers types` writes it to
 * `.cloudflare/types/index.d.ts` from cloudflare.config.ts, and the app's
 * tsconfig includes that file. `everyapp create` generates it and
 * `everyapp dev` does when a fresh clone has none yet.
 */
import path from "node:path";
import type { CfRunner } from "@/lib/cf/runner";
import { fileExists } from "@/lib/file-operations";

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

/** Whether the app's types were generated (a fresh clone has none). */
export async function hasWorkerTypes(cwd: string): Promise<boolean> {
  return fileExists(path.join(cwd, WORKER_TYPES_FILE));
}
