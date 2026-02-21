import { describe, expect, it } from "vitest";
import { shouldBootstrapSession } from "./useEveryAppSession";

describe("shouldBootstrapSession", () => {
  it("returns false for standalone apps without bypass", () => {
    expect(
      shouldBootstrapSession({
        isEmbedded: () => false,
        isBypassGatewayLocalOnly: false,
      }),
    ).toBe(false);
  });

  it("returns true for embedded apps", () => {
    expect(
      shouldBootstrapSession({
        isEmbedded: () => true,
        isBypassGatewayLocalOnly: false,
      }),
    ).toBe(true);
  });

  it("returns true for local bypass mode", () => {
    expect(
      shouldBootstrapSession({
        isEmbedded: () => false,
        isBypassGatewayLocalOnly: true,
      }),
    ).toBe(true);
  });

  it("does not depend on iframe detection for RN webviews", () => {
    expect(
      shouldBootstrapSession({
        isEmbedded: () => true,
        isBypassGatewayLocalOnly: false,
      }),
    ).toBe(true);
  });
});
