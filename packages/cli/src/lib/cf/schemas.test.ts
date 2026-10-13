import { describe, expect, it } from "vitest";
import { D1MigrationsApplyOutput } from "./schemas";

describe("D1MigrationsApplyOutput", () => {
  it("reads cf's local migration output", () => {
    // cf 1.0.0-beta.14, first and second run of `cf d1 migrations apply --local`.
    expect(
      D1MigrationsApplyOutput.parse([
        { name: "0000_dry_bloodaxe.sql", status: "✅" },
      ]),
    ).toEqual([{ name: "0000_dry_bloodaxe.sql", status: "✅" }]);
    expect(D1MigrationsApplyOutput.parse([])).toEqual([]);
  });

  it("rejects the list command's shape", () => {
    // `cf d1 migrations list` prints `[{ "Name": … }]`, which isn't a result.
    expect(
      D1MigrationsApplyOutput.safeParse([{ Name: "0000_dry_bloodaxe.sql" }])
        .success,
    ).toBe(false);
  });
});
