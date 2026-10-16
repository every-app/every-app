/**
 * A Worker's secrets through `cf workers secrets`: their names, and
 * deleting one. Setting one never goes this way: values travel with a
 * deploy, in `cf deploy --secrets-file` (lib/cf/deploy.ts), so they land in
 * a version everyapp uploaded.
 */
import { CfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";
import { WorkerSecretListOutput } from "./schemas";

/** The names of the Worker's secrets, sorted. */
export async function listWorkerSecrets(
  cf: CfRunner,
  workerName: string,
): Promise<string[]> {
  const secrets = await runCfJson(
    cf,
    { plane: "account", args: ["workers", "secrets", "list", "--worker", workerName] },
    WorkerSecretListOutput,
  );
  return secrets.map((secret) => secret.name).sort();
}

/**
 * Delete one of the Worker's secrets: Cloudflare makes a new version of
 * the live one without it. False when the Worker had no such secret (or
 * no Worker has that name yet). `--force` answers cf's confirmation,
 * decided as for `deleteD1`.
 */
export async function deleteWorkerSecret(
  cf: CfRunner,
  workerName: string,
  name: string,
): Promise<boolean> {
  try {
    await cf.run({
      plane: "account",
      mode: "json",
      args: ["workers", "secrets", "delete", name, "--worker", workerName, "--force"],
    });
    return true;
  } catch (error) {
    if (
      error instanceof CfError &&
      (error.kind === "not_found" || /not[_ ]found/i.test(error.message))
    ) {
      return false;
    }
    throw error;
  }
}
