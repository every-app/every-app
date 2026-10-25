import { describe, expect, it } from "vitest";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import {
  createVectorizeIndex,
  deleteVectorizeIndex,
  describeVectorizeShape,
  getVectorizeIndex,
  hasVectorizeShape,
  listVectorizeIndexes,
} from "./vectorize";

const NAME = "every-acme-notes--vectors";

/** The JSON body a recorded `cf vectorize create` read from its file. */
function bodyOf(account: FakeCloudflare): unknown {
  const call = account.cf.calls.find((c) => c.args[0] === "vectorize" && c.args[1] === "create")!;
  return JSON.parse(call.files["vectorize.json"]!);
}

describe("Vectorize indexes through cf", () => {
  it("creates an index from dimensions and a metric, in a body file", async () => {
    const account = new FakeCloudflare();
    await expect(
      createVectorizeIndex(account.cf, NAME, { dimensions: 768, metric: "cosine" }),
    ).resolves.toMatchObject({ name: NAME, config: { dimensions: 768, metric: "cosine" } });
    expect(bodyOf(account)).toEqual({ name: NAME, config: { dimensions: 768, metric: "cosine" } });
  });

  it("creates an index from a preset in a body file, never as a flag cf would read as a file", async () => {
    const account = new FakeCloudflare();
    const index = await createVectorizeIndex(account.cf, NAME, { preset: "@cf/baai/bge-base-en-v1.5" });
    expect(index.config).toEqual({ dimensions: 768, metric: "cosine", preset: "@cf/baai/bge-base-en-v1.5" });
    expect(bodyOf(account)).toEqual({ name: NAME, config: { preset: "@cf/baai/bge-base-en-v1.5" } });
    expect(account.cf.calls.flatMap((call) => call.args)).not.toContain("--config-preset");
  });

  it("refuses a name that is taken as already_exists", async () => {
    const account = new FakeCloudflare();
    await createVectorizeIndex(account.cf, NAME, { dimensions: 768, metric: "cosine" });
    await expect(
      createVectorizeIndex(account.cf, NAME, { dimensions: 768, metric: "cosine" }),
    ).rejects.toMatchObject({ kind: "already_exists", apiCodes: [3002] });
  });

  it("gets an index by name, null when there is none or it was just deleted", async () => {
    const account = new FakeCloudflare();
    await expect(getVectorizeIndex(account.cf, NAME)).resolves.toBeNull();
    await createVectorizeIndex(account.cf, NAME, { dimensions: 32, metric: "dot-product" });
    await expect(getVectorizeIndex(account.cf, NAME)).resolves.toMatchObject({
      name: NAME,
      config: { dimensions: 32, metric: "dot-product" },
    });
    account.cf.override(["vectorize", "get"], {
      exitCode: 1,
      stderr: `┌ APIError\n│ [3005] vectorize.index.deleted - Index name "${NAME}"\n│ 410  · HTTP /accounts/0123/vectorize/v2/indexes/${NAME}\n└\n`,
    });
    await expect(getVectorizeIndex(account.cf, NAME)).resolves.toBeNull();
  });

  it("lists every index, and deletes one with --force", async () => {
    const account = new FakeCloudflare();
    await createVectorizeIndex(account.cf, NAME, { dimensions: 768, metric: "cosine" });
    await createVectorizeIndex(account.cf, "someone-elses", { preset: "@cf/baai/bge-small-en-v1.5" });
    expect((await listVectorizeIndexes(account.cf)).map((index) => index.name)).toEqual([
      NAME,
      "someone-elses",
    ]);
    await deleteVectorizeIndex(account.cf, NAME);
    expect([...account.vectorizeIndexes.keys()]).toEqual(["someone-elses"]);
    expect(account.cf.calls.at(-1)!.args).toEqual(["vectorize", "delete", NAME, "--force"]);
    await expect(deleteVectorizeIndex(account.cf, NAME)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("compares an index with the manifest's shape, a preset by its name", () => {
    const sized = { name: NAME, config: { dimensions: 768, metric: "cosine" } };
    const preset = {
      name: NAME,
      config: { dimensions: 768, metric: "cosine", preset: "@cf/baai/bge-base-en-v1.5" },
    };
    expect(hasVectorizeShape(sized, { dimensions: 768, metric: "cosine" })).toBe(true);
    expect(hasVectorizeShape(sized, { dimensions: 768, metric: "euclidean" })).toBe(false);
    expect(hasVectorizeShape(sized, { dimensions: 384, metric: "cosine" })).toBe(false);
    expect(hasVectorizeShape(preset, { preset: "@cf/baai/bge-base-en-v1.5" })).toBe(true);
    // Same vectors, but the manifest's dimensions and metric are what it reports.
    expect(hasVectorizeShape(preset, { dimensions: 768, metric: "cosine" })).toBe(true);
    expect(hasVectorizeShape(sized, { preset: "@cf/baai/bge-base-en-v1.5" })).toBe(false);
    expect(describeVectorizeShape(sized.config)).toBe("768 dimensions, cosine");
    expect(describeVectorizeShape(preset.config)).toBe("the preset @cf/baai/bge-base-en-v1.5");
  });
});
