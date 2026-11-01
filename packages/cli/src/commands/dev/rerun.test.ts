import { describe, expect, it } from "vitest";
import { replaceFlag } from "./rerun";

describe("replaceFlag", () => {
  it("adds the flag when the run had none", () => {
    expect(replaceFlag("--port", "8788", ["dev"])).toBe("pnpm everyapp dev --port 8788");
  });

  it("replaces the value it was given, however spelled", () => {
    expect(replaceFlag("--port", "8788", ["dev", "--port", "8787", "--skip-migrations"])).toBe(
      "pnpm everyapp dev --skip-migrations --port 8788",
    );
    expect(replaceFlag("--port", "8788", ["dev", "--port=8787"])).toBe(
      "pnpm everyapp dev --port 8788",
    );
    expect(
      replaceFlag("--base-host", "everyapp.localhost", ["dev", "--baseHost", "localhost", "--mode", "mirror"]),
    ).toBe("pnpm everyapp dev --mode mirror --base-host everyapp.localhost");
  });
});
