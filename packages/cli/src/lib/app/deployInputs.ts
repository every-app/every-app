/**
 * The CLI side of `.everyapp/deploy.json`: the deploy-time inputs
 * `everyAppWorker()` (from `@every-app/sdk/cloudflare`) reads while
 * `cf build` runs in production mode. The file exists only for that build.
 */
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEPLOY_INPUTS_FILE,
  parseDeployInputs,
  type EveryAppDeployInputs,
} from "@every-app/sdk/cloudflare";
import { ensureGitignored } from "@/lib/gitignore";
import { onInterrupt } from "@/lib/interrupt";

export type DeployInputs = Omit<EveryAppDeployInputs, "schema" | "createdAt">;

/** Unregisters the interrupt cleanup of a deploy.json that is still there. */
const written = new Map<string, () => void>();

/** Validate with the same parser the config uses, then write it (0600). */
export async function writeDeployInputs(
  cwd: string,
  inputs: DeployInputs,
): Promise<string> {
  const value = parseDeployInputs({
    schema: 1,
    ...inputs,
    createdAt: new Date().toISOString(),
  });
  const file = path.join(cwd, DEPLOY_INPUTS_FILE);
  ensureGitignored(cwd, `${path.dirname(DEPLOY_INPUTS_FILE)}/`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // While it exists, a bare `cf deploy` would build a real Worker: an
  // interrupted deploy removes it too.
  written.get(file)?.();
  written.set(file, onInterrupt({ sync: () => rmSync(file, { force: true }) }));
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  return file;
}

export async function removeDeployInputs(cwd: string): Promise<void> {
  const file = path.join(cwd, DEPLOY_INPUTS_FILE);
  await fs.rm(file, { force: true });
  written.get(file)?.();
  written.delete(file);
}
