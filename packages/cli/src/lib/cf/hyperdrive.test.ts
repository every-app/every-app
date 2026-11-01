import { describe, expect, it } from "vitest";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import {
  cachesAs,
  createHyperdrive,
  findHyperdrive,
  listHyperdrive,
  updateHyperdrive,
} from "./hyperdrive";
import { FakeCf } from "./fakeCf";

const origin = { scheme: "postgres", host: "h", port: 5432, database: "d", user: "u" };
const withPassword = { ...origin, scheme: "postgres" as const, password: "p" };

/** The JSON body a recorded `cf hyperdrive create|update` read from its file. */
function bodyOf(cf: FakeCf, action: string): Record<string, unknown> {
  const call = cf.calls.find((c) => c.args[0] === "hyperdrive" && c.args[1] === action)!;
  return JSON.parse(call.files["hyperdrive.json"]!) as Record<string, unknown>;
}

describe("listHyperdrive", () => {
  it("reads every page of the account's configs", async () => {
    const account = new FakeCloudflare();
    for (let index = 0; index < 25; index += 1) {
      account.hyperdrive.set(`id-${index}`, { name: `config-${index}`, origin, password: "p" });
    }
    expect(await listHyperdrive(account.cf)).toHaveLength(25);
    await expect(findHyperdrive(account.cf, "config-24")).resolves.toMatchObject({
      id: "id-24",
      origin: { host: "h" },
    });
    await expect(findHyperdrive(account.cf, "config-2")).resolves.toMatchObject({ id: "id-2" });
  });

  it("stops when a page brings nothing new, as from an API that ignores pages", async () => {
    const page = Array.from({ length: 20 }, (_, index) => ({ id: `id-${index}`, name: `c-${index}` }));
    const cf = new FakeCf().on(["hyperdrive", "list"], { stdout: JSON.stringify(page) });
    expect(await listHyperdrive(cf)).toHaveLength(20);
    expect(cf.calls).toHaveLength(2);
  });
});

describe("Hyperdrive query caching", () => {
  it("creates a config that caches nothing, unless asked for Cloudflare's default", async () => {
    const account = new FakeCloudflare();
    await createHyperdrive(account.cf, "every-acme-seo--hyperdrive", withPassword);
    expect(bodyOf(account.cf, "create")).toEqual({
      name: "every-acme-seo--hyperdrive",
      origin: withPassword,
      caching: { disabled: true },
    });
    expect(account.hyperdriveConfig("every-acme-seo--hyperdrive")!.caching).toEqual({
      disabled: true,
    });

    const cached = new FakeCloudflare();
    await createHyperdrive(cached.cf, "every-acme-seo--hyperdrive", withPassword, "default");
    expect(bodyOf(cached.cf, "create")).toEqual({
      name: "every-acme-seo--hyperdrive",
      origin: withPassword,
    });
    await expect(findHyperdrive(cached.cf, "every-acme-seo--hyperdrive")).resolves.toMatchObject({
      caching: { disabled: false },
    });
  });

  it("changes only what it is given: the origin, the caching, or both", async () => {
    const cf = new FakeCf().on(["hyperdrive", "update"], {
      stdout: JSON.stringify({ id: "hd-1", name: "c" }),
    });
    await updateHyperdrive(cf, "hd-1", { origin: withPassword });
    await updateHyperdrive(cf, "hd-1", { caching: "off" });
    await updateHyperdrive(cf, "hd-1", { origin: withPassword, caching: "default" });
    expect(cf.calls.map((call) => [call.args, JSON.parse(call.files["hyperdrive.json"]!)])).toEqual([
      [["hyperdrive", "update", "hd-1", "--body", "@/fake-cf-files/hyperdrive.json"], { origin: withPassword }],
      [["hyperdrive", "update", "hd-1", "--body", "@/fake-cf-files/hyperdrive.json"], { caching: { disabled: true } }],
      [
        ["hyperdrive", "update", "hd-1", "--body", "@/fake-cf-files/hyperdrive.json"],
        { origin: withPassword, caching: { disabled: false } },
      ],
    ]);
  });

  it("reads a config's caching as Cloudflare lists it", () => {
    const config = (caching: unknown) => ({ id: "hd-1", name: "c", caching }) as never;
    expect(cachesAs(config({ disabled: true }), "off")).toBe(true);
    expect(cachesAs(config({ disabled: false, max_age: 60 }), "off")).toBe(false);
    expect(cachesAs(config(undefined), "off")).toBe(false);
    expect(cachesAs(config(undefined), "default")).toBe(true);
    expect(cachesAs(config({ disabled: true }), "default")).toBe(false);
  });
});
