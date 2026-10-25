/**
 * Secrets Store secrets (`resources.secretsStore`) on the live test
 * account, through the deploy's own provisioning (provisionAppResources,
 * with an in-memory ledger): with no store in the account (cf can't make
 * one; a person does once in the dashboard), it stops with
 * SECRETS_STORE_MISSING and the rest is skipped, saying so. With a store:
 * the secret ensured twice (the second time creates nothing), a prebuilt
 * Worker binding it uploaded through the deploy path and read back, then
 * the Worker and the secret deleted and checked gone. The value is a
 * throwaway and never printed. Skipped without
 * EVERYAPP_LIVE_PROVISIONERS=1 (see ./live.ts):
 *
 *   EVERYAPP_LIVE_PROVISIONERS=1 pnpm -C packages/cli exec vitest run test/provisioners/secrets-store.live.test.ts
 */
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { readOwnedResources } from "@/lib/app/ownership";
import { provisionAppResources } from "@/lib/app/resources";
import { CfError } from "@/lib/cf/errors";
import {
  chooseSecretsStore,
  deleteStoreSecret,
  findStoreSecret,
  listSecretsStores,
} from "@/lib/cf/secretsStore";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { createSqliteD1 } from "@/test/sqliteD1";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

const WORKER = `${LIVE_PREFIX}secrets-store`;
const BINDING = "STRIPE_KEY";
const SECRET = `${WORKER}--stripe-key`;

describeLive("Secrets Store secrets (resources.secretsStore), live", () => {
  it("ensures the secret once, binds it on a Worker, reads it back and deletes everything (or stops on a store-less account)", async () => {
    const live = await liveAccount();
    const shown = (text: string) => text.replaceAll(live.accountId, "<account>");
    const report = (label: string, value: unknown) =>
      console.log(`${label}:\n${shown(typeof value === "string" ? value : JSON.stringify(value, null, 2))}`);
    const gatewayDb = createSqliteD1();
    const ensure = () =>
      provisionAppResources({
        cf: live.cf,
        gatewayDb,
        registration: { workerName: WORKER, resources: { d1: {}, kv: {}, r2: {} } },
        manifest: { id: "provisioners-secrets-store", resources: { secretsStore: [{ name: BINDING }] } },
        secrets: { [BINDING]: `live-${randomBytes(12).toString("hex")}` },
        accountId: live.accountId,
      } as Parameters<typeof provisionAppResources>[0]);

    const stores = await listSecretsStores(live.cf);
    report("cf secrets-store stores list", stores);
    const store = chooseSecretsStore(stores);
    if (!store) {
      await expect(ensure()).rejects.toMatchObject({
        code: "SECRETS_STORE_MISSING",
        message: expect.stringContaining("Secrets Store → Create store"),
      });
      console.log(
        `SKIPPED the rest: ${live.name} has no Secrets Store (cf can't create one). Make one once in the dashboard (Secrets Store → Create store), then run this again.`,
      );
      return;
    }

    try {
      // A leftover of an earlier run that stopped would read as taken.
      expect(await findStoreSecret(live.cf, store.id, SECRET)).toBeNull();
      const first = await ensure();
      const secret = await findStoreSecret(live.cf, store.id, SECRET);
      report("the secret, listed (no value)", secret);
      expect(secret).toMatchObject({ name: SECRET });
      expect(first.secretsStore).toEqual({ [BINDING]: { storeId: store.id, secretName: SECRET } });
      const again = await ensure();
      expect(again.secretsStore).toEqual(first.secretsStore);
      expect((await findStoreSecret(live.cf, store.id, SECRET))?.id).toBe(secret!.id);
      expect(await readOwnedResources(gatewayDb, WORKER)).toEqual([
        expect.objectContaining({
          kind: "secrets-store-secret",
          binding: BINDING,
          name: SECRET,
          resourceId: `${store.id}/${secret!.id}`,
        }),
      ]);

      const versionId = await uploadPrebuilt(live, {
        workerName: WORKER,
        env: { [BINDING]: { type: "secrets-store-secret", storeId: store.id, secretName: SECRET } },
      });
      expect(await getWorkerDeployment(live.cf, WORKER)).toMatchObject({ versionId });
      const bindings = await readWorkerBindings(live, WORKER);
      report("the Worker's bindings, read back", bindings);
      expect(bindings).toContainEqual(
        expect.objectContaining({ name: BINDING, store_id: store.id, secret_name: SECRET }),
      );
    } finally {
      await deleteWorkerQuietly(live, WORKER);
      const left = await findStoreSecret(live.cf, store.id, SECRET);
      if (left) await deleteStoreSecret(live.cf, store.id, left.id);
    }

    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
    expect(await findStoreSecret(live.cf, store.id, SECRET)).toBeNull();
    try {
      await deleteStoreSecret(live.cf, store.id, "0".repeat(32));
      throw new Error("cf didn't refuse a delete of a secret that doesn't exist");
    } catch (error) {
      if (!(error instanceof CfError)) throw error;
      report("a delete of a secret that doesn't exist", error.message);
      expect(error.kind).toBe("not_found");
    }
  }, 300_000);
});
