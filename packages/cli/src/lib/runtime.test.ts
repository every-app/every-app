import { describe, expect, it } from "vitest";
import { unsupportedRuntime } from "./runtime";

const node = (version: string) =>
  ({ node: version }) as unknown as NodeJS.ProcessVersions;

describe("unsupportedRuntime", () => {
  it("accepts Node 22.18.0 and newer", () => {
    expect(unsupportedRuntime(node("22.18.0"))).toBeNull();
    expect(unsupportedRuntime(node("22.20.1"))).toBeNull();
    expect(unsupportedRuntime(node("24.1.0"))).toBeNull();
  });

  it("explains why Node 22.17 and older can't run it, and says to install a newer one", () => {
    expect(unsupportedRuntime(node("22.17.1"))).toMatchObject({
      code: "UNSUPPORTED_RUNTIME",
      message: expect.stringMatching(/^everyapp needs Node\.js 22\.18\.0 or newer; this is 22\.17\.1\n/),
      fix: "install Node 22 or 24, then run the command again",
      rerun: undefined,
    });
    expect(unsupportedRuntime(node("20.19.0"))?.message).toMatch(/22\.18\.0/);
  });

  it("refuses Bun", () => {
    expect(
      unsupportedRuntime({
        node: "24.3.0",
        bun: "1.2.0",
      } as unknown as NodeJS.ProcessVersions),
    ).toMatchObject({
      message: expect.stringMatching(/^everyapp runs on Node\.js, not Bun\n/),
      rerunNote: "with Node.js 22.18.0 or newer",
    });
  });
});
