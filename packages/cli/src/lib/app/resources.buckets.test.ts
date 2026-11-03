import { EveryAppError } from "@/lib/errors";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { createSqliteD1 } from "@/test/sqliteD1";
import { beforeEach, describe, expect, it } from "vitest";
import { resourceInstaller } from "./resources";
import { readOwnedResources, recordOwnedResource, recordUploadedVersion } from "./ownership";

let account: FakeCloudflare;
let adopted: string[];
let gatewayDb: ReturnType<typeof createSqliteD1>;

beforeEach(() => {
  account = new FakeCloudflare();
  gatewayDb = createSqliteD1();
  adopted = [];
});

const ensure = (names: string[]) =>
  resourceInstaller.ensureAppBuckets({
    cf: account.cf,
    gatewayDb,
    registration: {
      workerName: "every-acme-crm",
      resources: { d1: {}, kv: {}, r2: {} },
    },
    names,
    appId: "crm",
    onAdopted: (name) => void adopted.push(name),
  });

describe("ensureAppBuckets", () => {
  it("creates the buckets the Workers bind that don't exist, once each", async () => {
    account.buckets.set("every-acme-crm--cache", { objects: 3 });
    await recordOwnedResource(gatewayDb, "every-acme-crm", {
      kind: "r2",
      binding: "every-acme-crm--cache",
      name: "every-acme-crm--cache",
      resourceId: "every-acme-crm--cache",
    });
    const created = await ensure(["every-acme-crm", "every-acme-crm--cache", "every-acme-crm"]);
    expect(created).toEqual(["every-acme-crm"]);
    expect([...account.buckets.keys()].sort()).toEqual(["every-acme-crm", "every-acme-crm--cache"]);
    // The one that was there keeps its objects: nothing recreates or empties it.
    expect(account.buckets.get("every-acme-crm--cache")).toEqual({
      objects: 3,
    });
    expect(account.cf.calls.filter((call) => call.args[0] === "r2" && call.args[2] === "create")).toHaveLength(1);
  });

  it("finds a bucket by its exact name, not one that merely contains it", async () => {
    account.buckets.set("every-acme-crm-old", { objects: 0 });
    await ensure(["every-acme-crm"]);
    expect(account.buckets.has("every-acme-crm")).toBe(true);
  });

  it("refuses a matching bucket without recorded ownership and keeps its objects", async () => {
    account.buckets.set("every-acme-crm", { objects: 3 });
    await expect(ensure(["every-acme-crm"])).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
    });
    expect(account.buckets.get("every-acme-crm")).toEqual({ objects: 3 });
    expect(account.cf.calls.filter((call) => call.args[0] === "r2" && call.args[2] === "create")).toHaveLength(0);
  });

  describe("a bucket an earlier deploy made before buckets were recorded", () => {
    const recordWorker = async ({ uploaded = true } = {}) => {
      await recordOwnedResource(gatewayDb, "every-acme-crm", {
        kind: "worker",
        binding: "",
        name: "every-acme-crm",
        resourceId: "every-acme-crm",
      });
      if (uploaded) await recordUploadedVersion(gatewayDb, "every-acme-crm", "v-1");
    };
    const r2Creates = () => account.cf.calls.filter((call) => call.args[0] === "r2" && call.args[2] === "create");

    it("is adopted when it has the app's name and the app's Worker is recorded", async () => {
      await recordWorker();
      account.buckets.set("every-acme-crm", { objects: 3 });
      expect(await ensure(["every-acme-crm"])).toEqual([]);
      expect(account.buckets.get("every-acme-crm")).toEqual({ objects: 3 });
      expect(r2Creates()).toHaveLength(0);
      expect(await readOwnedResources(gatewayDb, "every-acme-crm")).toContainEqual(
        expect.objectContaining({ kind: "r2", binding: "every-acme-crm", name: "every-acme-crm", resourceId: "every-acme-crm" }),
      );
      expect(adopted).toEqual(["every-acme-crm"]);
      // Recorded now: the next deploy uses it without adopting again.
      adopted = [];
      await ensure(["every-acme-crm"]);
      expect(adopted).toEqual([]);
    });

    it("is refused when another app records it", async () => {
      await recordWorker();
      account.buckets.set("every-acme-crm", { objects: 3 });
      await recordOwnedResource(gatewayDb, "every-acme-other", {
        kind: "r2",
        binding: "FILES",
        name: "every-acme-crm",
        resourceId: "every-acme-crm",
      });
      await expect(ensure(["every-acme-crm"])).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
      expect(r2Creates()).toHaveLength(0);
    });

    it("is refused when its name isn't exactly the app's assigned bucket name", async () => {
      await recordWorker();
      account.buckets.set("every-acme-crm--cache", { objects: 3 });
      await expect(ensure(["every-acme-crm--cache"])).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
      expect(await readOwnedResources(gatewayDb, "every-acme-crm")).not.toContainEqual(
        expect.objectContaining({ kind: "r2" }),
      );
    });

    it("is refused when the app's Worker isn't recorded on this Gateway", async () => {
      account.buckets.set("every-acme-crm", { objects: 3 });
      await expect(ensure(["every-acme-crm"])).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    });

    it("is refused on a first deploy, which has claimed the Worker but uploaded nothing yet", async () => {
      await recordWorker({ uploaded: false });
      account.buckets.set("every-acme-crm", { objects: 3 });
      await expect(ensure(["every-acme-crm"])).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    });
  });

  it("creates and records the bucket on a fresh install, adopting nothing", async () => {
    expect(await ensure(["every-acme-crm"])).toEqual(["every-acme-crm"]);
    expect(await readOwnedResources(gatewayDb, "every-acme-crm")).toEqual([
      expect.objectContaining({ kind: "r2", name: "every-acme-crm", resourceId: "every-acme-crm" }),
    ]);
    expect(adopted).toEqual([]);
  });

  it("does nothing with no buckets to bind", async () => {
    expect(await ensure([])).toEqual([]);
    expect(account.cf.calls.filter((call) => call.args[0] === "r2")).toHaveLength(0);
  });

  it("stops with R2_NOT_ENABLED when the account never enabled R2", async () => {
    account.r2NotEnabled = true;
    const error = await ensure(["every-acme-crm"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EveryAppError);
    expect((error as EveryAppError).code).toBe("R2_NOT_ENABLED");
    expect((error as EveryAppError).message).toContain("crm needs an R2 bucket (every-acme-crm)");
    expect((error as EveryAppError).message).toContain("R2 Object Storage");
  });
});
