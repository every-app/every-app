import { describe, expect, it } from "vitest";
import { deployedBy } from "./deployedBy";

describe("deployedBy", () => {
  it("says an API token deployed, never its account id", () => {
    expect(deployedBy("api-token:0123456789abcdef")).toBe(
      "Deployed with an API token",
    );
  });

  it("says a deploy key deployed, never its token id", () => {
    expect(deployedBy("deploy-key:tok_0123456789")).toBe(
      "Deployed with a deploy key",
    );
  });

  it("reads a person's email as is", () => {
    expect(deployedBy("ben@example.com")).toBe("Deployed by ben@example.com");
  });

  it("is nothing for an app nobody has deployed", () => {
    expect(deployedBy(null)).toBeNull();
    expect(deployedBy("")).toBeNull();
  });
});
