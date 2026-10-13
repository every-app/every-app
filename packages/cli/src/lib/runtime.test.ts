import { describe, expect, it } from "vitest";
import { unsupportedRuntimeReason } from "./runtime";

const node = (version: string) =>
  ({ node: version }) as unknown as NodeJS.ProcessVersions;

describe("unsupportedRuntimeReason", () => {
  it("accepts Node 22.18.0 and newer", () => {
    expect(unsupportedRuntimeReason(node("22.18.0"))).toBeNull();
    expect(unsupportedRuntimeReason(node("22.20.1"))).toBeNull();
    expect(unsupportedRuntimeReason(node("24.1.0"))).toBeNull();
  });

  it("explains why Node 22.17 and older can't run it", () => {
    expect(unsupportedRuntimeReason(node("22.17.1"))).toMatch(
      /needs Node\.js 22\.18\.0 or newer; this is 22\.17\.1/,
    );
    expect(unsupportedRuntimeReason(node("20.19.0"))).toMatch(/22\.18\.0/);
  });

  it("refuses Bun", () => {
    expect(
      unsupportedRuntimeReason({
        node: "24.3.0",
        bun: "1.2.0",
      } as unknown as NodeJS.ProcessVersions),
    ).toMatch(/not Bun/);
  });
});
