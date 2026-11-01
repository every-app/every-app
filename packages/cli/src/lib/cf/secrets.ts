/**
 * A Worker's secrets through `cf workers secrets`: their names, deleting
 * one, and setting or removing several at once. A change makes Cloudflare
 * create a new version of the live one; the caller records that version as
 * the Worker's own (the install row, or the app's resource records), so the
 * next deploy replaces it unattended. A first deploy still sends its secrets
 * with the upload (`cf deploy --secrets-file`, lib/cf/deploy.ts).
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

/**
 * Set or remove several of the Worker's secrets in one new version
 * (`cf workers secrets bulk`). The API takes a JSON merge patch under
 * `secrets`: a secret object (with its own `name`) sets, null removes, and
 * a body of any other shape is a patch of nothing, which makes a version
 * with no change. It travels in a private temp file cf reads as JSON
 * (`--body @<file>`, never `--file`, which uploads an octet stream the API
 * takes the same way), so a value is never on argv.
 */
export async function patchWorkerSecrets(
  cf: CfRunner,
  workerName: string,
  changes: Readonly<Record<string, string | null>>,
): Promise<void> {
  const body = {
    secrets: Object.fromEntries(
      Object.entries(changes).map(([name, value]) => [
        name,
        value === null ? null : { name, type: "secret_text", text: value },
      ]),
    ),
  };
  await cf.run({
    plane: "account",
    mode: "json",
    files: { "secrets.json": body },
    args: (files) => [
      "workers",
      "secrets",
      "bulk",
      "--worker",
      workerName,
      "--body",
      `@${files["secrets.json"]!}`,
    ],
  });
}
