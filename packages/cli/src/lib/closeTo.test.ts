import { describe, expect, it } from "vitest";
import { closestTo, closeTo } from "./closeTo";

const IDS = ["github", "github-oauth", "gitlab", "google-workspace", "hubspot", "hubspot-oauth", "openrouter"];

describe("closestTo", () => {
  it("names the id that holds what was typed: one that starts with it first, the shortest of those", () => {
    expect(closestTo("google", IDS)).toBe("google-workspace");
    expect(closestTo("workspace", IDS)).toBe("google-workspace");
    expect(closestTo("hub", IDS)).toBe("hubspot");
    expect(closestTo("GitHub-", IDS)).toBe("github-oauth");
  });

  it("falls back to a typo's match, and has none for an unrelated or too short word", () => {
    expect(closestTo("opnrouter", IDS)).toBe("openrouter");
    expect(closestTo("stripe", IDS)).toBeUndefined();
    // Two letters are in most ids: not a part worth matching.
    expect(closestTo("ub", IDS)).toBeUndefined();
  });
});

describe("closeTo", () => {
  it("takes a typo within two edits, the nearest first, and never a part of a name", () => {
    expect(closeTo("gitlb", IDS)).toBe("gitlab");
    expect(closeTo("google", IDS)).toBeUndefined();
  });
});
