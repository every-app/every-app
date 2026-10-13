import { describe, expect, it } from "vitest";
import { createArgumentsDigester } from "./digest";

describe("createArgumentsDigester", () => {
  it("fingerprints arguments without revealing them", async () => {
    const digest = createArgumentsDigester("secret-1", "ctx:v1");
    const value = await digest({ title: "buy milk", n: 1 });

    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(value).not.toContain("milk");
    expect(await digest({ n: 1, title: "buy milk" })).toBe(value);
    expect(await digest({ title: "buy eggs", n: 1 })).not.toBe(value);
    expect(
      await createArgumentsDigester(
        "secret-2",
        "ctx:v1",
      )({ title: "buy milk", n: 1 }),
    ).not.toBe(value);
    expect(
      await createArgumentsDigester(
        "secret-1",
        "ctx:v2",
      )({ title: "buy milk", n: 1 }),
    ).not.toBe(value);
  });
});
