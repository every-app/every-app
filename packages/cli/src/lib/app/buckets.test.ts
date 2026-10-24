import { beforeEach, describe, expect, it } from "vitest";
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { ensureR2Buckets } from "./buckets";

let account: FakeCloudflare;
let events: Array<Parameters<EventSink["emit"]>[0]>;
let out: EventSink;

beforeEach(() => {
  account = new FakeCloudflare();
  events = [];
  out = {
    emit: (event) => void events.push(event),
    exitCode: 0,
    verbose: false,
  };
});

const ensure = (names: string[]) => ensureR2Buckets({ cf: account.cf, names, appId: "crm", out });

describe("ensureR2Buckets", () => {
  it("creates the buckets the Workers bind that don't exist, once each, and says so", async () => {
    account.buckets.set("every-acme-crm--cache", { objects: 3 });
    const created = await ensure(["every-acme-crm", "every-acme-crm--cache", "every-acme-crm"]);
    expect(created).toEqual(["every-acme-crm"]);
    expect([...account.buckets.keys()].sort()).toEqual(["every-acme-crm", "every-acme-crm--cache"]);
    // The one that was there keeps its objects: nothing recreates or empties it.
    expect(account.buckets.get("every-acme-crm--cache")).toEqual({ objects: 3 });
    expect(events).toEqual([
      expect.objectContaining({ type: "progress", step: "app.build", message: 'Created R2 bucket "every-acme-crm".' }),
    ]);
    expect(account.cf.calls.filter((call) => call.args[0] === "r2" && call.args[2] === "create")).toHaveLength(1);
  });

  it("finds a bucket by its exact name, not one that merely contains it", async () => {
    account.buckets.set("every-acme-crm-old", { objects: 0 });
    await ensure(["every-acme-crm"]);
    expect(account.buckets.has("every-acme-crm")).toBe(true);
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
