/** Node filesystem adapter for the shared self-hosted release installer. */
import { EveryAppError } from "@/lib/errors";
import { installWorkerConfig as install, type InstallTarget } from "@every-app/perimeter/install";
import fs from "node:fs/promises";
import { builtWorkers } from "./buildOutput";
export type { InstallTarget } from "@every-app/perimeter/install";
export function installWorkerConfig<T extends Record<string, unknown>>(config: T, target: InstallTarget): T {
  try {
    return install(config, target);
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
}
export async function installAppBuildOutput({
  cwd,
  target,
}: { cwd: string; target: InstallTarget }): Promise<void> {
  for await (const { file, config } of builtWorkers(cwd))
    await fs.writeFile(file, `${JSON.stringify(installWorkerConfig(config, target), null, 2)}\n`);
}
