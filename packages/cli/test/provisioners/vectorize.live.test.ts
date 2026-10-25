/**
 * Vectorize indexes on the live test account, through the CLI's own module
 * (lib/cf/vectorize.ts): an index ensured twice in each form (the second
 * time creates nothing, and the shape read back is the one declared), a
 * prebuilt Worker binding both uploaded through the deploy path and read
 * back, then the Worker and the indexes deleted and checked gone. Prints
 * what Cloudflare answered (`get`'s JSON, the error texts), the account id
 * replaced by `<account>`. Skipped without EVERYAPP_LIVE_PROVISIONERS=1
 * (see ./live.ts):
 *
 *   EVERYAPP_LIVE_PROVISIONERS=1 pnpm -C packages/cli exec vitest run test/provisioners/vectorize.live.test.ts
 */
import { expect, it } from "vitest";
import { CfError } from "@/lib/cf/errors";
import { runCfJson } from "@/lib/cf/runner";
import { VectorizeIndexOutput, type VectorizeIndex } from "@/lib/cf/schemas";
import {
  createVectorizeIndex,
  deleteVectorizeIndex,
  getVectorizeIndex,
  hasVectorizeShape,
  type VectorizeShape,
} from "@/lib/cf/vectorize";
import { getWorkerDeployment } from "@/lib/cf/workers";
import {
  deleteWorkerQuietly,
  describeLive,
  liveAccount,
  LIVE_PREFIX,
  readWorkerBindings,
  uploadPrebuilt,
} from "./live";

const WORKER = `${LIVE_PREFIX}vectorize`;
const INDEXES: Array<{ binding: string; name: string; shape: VectorizeShape }> = [
  { binding: "VECTORS", name: `${WORKER}--vectors`, shape: { dimensions: 32, metric: "cosine" } },
  // A preset starts with @, which cf would read as a file in a flag: the module sends a body file.
  { binding: "DOC_CHUNKS", name: `${WORKER}--doc-chunks`, shape: { preset: "@cf/baai/bge-small-en-v1.5" } },
];

describeLive("Vectorize indexes, live", () => {
  it("ensures each index once, binds both on a Worker, reads them back and deletes everything", async () => {
    const live = await liveAccount();
    const shown = (text: string) => text.replaceAll(live.accountId, "<account>");
    const report = (label: string, value: unknown) =>
      console.log(`${label}:\n${shown(typeof value === "string" ? value : JSON.stringify(value, null, 2))}`);
    /** What cf said when it refused, as a person reads it. */
    const refusal = async (run: () => Promise<unknown>): Promise<CfError> => {
      try {
        await run();
      } catch (error) {
        if (error instanceof CfError) return error;
        throw error;
      }
      throw new Error("cf didn't refuse");
    };
    let creates = 0;
    /** The deploy's order: get, and create only when there is none. */
    const ensure = async ({ name, shape }: (typeof INDEXES)[number]): Promise<VectorizeIndex> => {
      const existing = await getVectorizeIndex(live.cf, name);
      if (existing) return existing;
      creates += 1;
      return createVectorizeIndex(live.cf, name, shape);
    };

    try {
      for (const index of INDEXES) {
        // A leftover of an earlier run that stopped would read as already there.
        expect(await getVectorizeIndex(live.cf, index.name)).toBeNull();
        const created = await ensure(index);
        const again = await ensure(index);
        expect(again.name).toBe(index.name);
        expect(hasVectorizeShape(again, index.shape)).toBe(true);
        report(`cf vectorize get ${index.name}`, again);
        expect(created.config).toEqual(again.config);
      }
      expect(creates).toBe(INDEXES.length);
      expect((await getVectorizeIndex(live.cf, INDEXES[1]!.name))?.config).toMatchObject({
        dimensions: 384,
        metric: "cosine",
        preset: "@cf/baai/bge-small-en-v1.5",
      });

      const duplicate = await refusal(() => createVectorizeIndex(live.cf, INDEXES[0]!.name, INDEXES[0]!.shape));
      report("a second create of the name", duplicate.message);
      expect(duplicate.kind).toBe("already_exists");

      const versionId = await uploadPrebuilt(live, {
        workerName: WORKER,
        env: Object.fromEntries(INDEXES.map(({ binding, name }) => [binding, { type: "vectorize", name }])),
      });
      expect(await getWorkerDeployment(live.cf, WORKER)).toMatchObject({ versionId });
      const bindings = await readWorkerBindings(live, WORKER);
      report("the Worker's bindings, read back", bindings);
      for (const { binding, name } of INDEXES) {
        expect(bindings).toContainEqual(expect.objectContaining({ name: binding, type: "vectorize", index_name: name }));
      }
    } finally {
      await deleteWorkerQuietly(live, WORKER);
      for (const { name } of INDEXES) {
        try {
          await deleteVectorizeIndex(live.cf, name);
        } catch (error) {
          if (!(error instanceof CfError && error.kind === "not_found")) throw error;
        }
      }
    }

    expect(await getWorkerDeployment(live.cf, WORKER)).toBeNull();
    for (const { name } of INDEXES) {
      // Gone: 410 for a while after the delete, then 404; both read as none.
      expect(await getVectorizeIndex(live.cf, name)).toBeNull();
    }
    const gone = await refusal(() =>
      runCfJson(live.cf, { plane: "account", args: ["vectorize", "get", INDEXES[0]!.name] }, VectorizeIndexOutput),
    );
    report("a get of a deleted index", gone.message);
    expect(gone.kind).toBe("not_found");
    const missing = await refusal(() =>
      runCfJson(live.cf, { plane: "account", args: ["vectorize", "get", `${WORKER}--never-made`] }, VectorizeIndexOutput),
    );
    report("a get of an index that never existed", missing.message);
    expect(missing.kind).toBe("not_found");
    const deleteAgain = await refusal(() => deleteVectorizeIndex(live.cf, INDEXES[0]!.name));
    report("a delete of a deleted index", deleteAgain.message);
    expect(deleteAgain.kind).toBe("not_found");
  }, 300_000);
});
