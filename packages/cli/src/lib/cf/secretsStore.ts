export { chooseSecretsStore } from "@every-app/perimeter/install";
/**
 * Cloudflare Secrets Store through `cf secrets-store`: the account's
 * stores, and the secrets in one by exact name. A secret's value goes to cf
 * only in a request body file (a private temp file, `--body @<file>`),
 * never on the command line, and Cloudflare never returns it.
 *
 * cf 1.0.0-beta.14 can list stores but not create one (no `stores create`;
 * checked 2026-10-24), so a store is the person's to make once, in the
 * dashboard (Secrets Store → Create store).
 */
import { listAll, runCfJson, type CfRunner } from "./runner";
import {
  SecretsStoreListOutput,
  SecretsStoreSecretListOutput,
  type SecretsStore,
  type SecretsStoreSecret,
} from "./schemas";

/** Every Secrets Store in the account. */
export function listSecretsStores(cf: CfRunner): Promise<SecretsStore[]> {
  return listAll(cf, ["secrets-store", "stores", "list"], SecretsStoreListOutput, {
    perPage: 100,
    maxPages: 10,
  });
}

/**
 * The secrets of a store whose name or comment holds `search` (Cloudflare's
 * filter), as Cloudflare lists them.
 */
export function listStoreSecrets(
  cf: CfRunner,
  storeId: string,
  search: string,
): Promise<SecretsStoreSecret[]> {
  return listAll(
    cf,
    ["secrets-store", "secrets", "list", "--store-id", storeId, "--search", search],
    SecretsStoreSecretListOutput,
    { perPage: 100, maxPages: 10 },
  );
}

/** The store's secret named exactly `name`, or null. */
export async function findStoreSecret(
  cf: CfRunner,
  storeId: string,
  name: string,
): Promise<SecretsStoreSecret | null> {
  return (
    (await listStoreSecrets(cf, storeId, name)).find(
      (secret) => secret.name === name && secret.status !== "deleted",
    ) ?? null
  );
}

/**
 * Create a secret Workers may bind (scope `workers`); fails
 * (`already_exists`) when the store has one of the name. Returns its id.
 */
export async function createStoreSecret(cf: CfRunner, storeId: string, name: string, value: string): Promise<string> {
  const created = await runCfJson(
    cf,
    {
      plane: "account",
      files: {
        "secret.json": [{ name, value, scopes: ["workers"], comment: "Created by everyapp deploy" }],
      },
      args: (files) => ["secrets-store", "secrets", "create", storeId, "--body", `@${files["secret.json"]!}`],
    },
    SecretsStoreSecretListOutput,
  );
  const secret = created.find((entry) => entry.name === name) ?? created[0];
  if (!secret) throw new Error(`cf created no Secrets Store secret named ${name}`);
  return secret.id;
}

/**
 * Delete a secret, decided as for deleteD1 (lib/cf/resources.ts). Throws
 * `not_found` when it is gone already.
 */
export async function deleteStoreSecret(
  cf: CfRunner,
  storeId: string,
  secretId: string,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["secrets-store", "secrets", "delete", secretId, "--store-id", storeId, "--force"],
  });
}
