import { describe, expect, it } from "vitest";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { findHyperdrive, listHyperdrive } from "./hyperdrive";
import { FakeCf } from "./fakeCf";

const origin = { scheme: "postgres", host: "h", port: 5432, database: "d", user: "u" };

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
