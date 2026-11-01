import { describe, expect, it } from "vitest";
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  validOrganizationName,
} from "./organizationName.js";

describe("validOrganizationName", () => {
  it("trims and collapses whitespace", () => {
    expect(validOrganizationName("  Acme   Rockets ")).toBe("Acme Rockets");
  });

  it("refuses empty, overlong and control-character names", () => {
    for (const name of [
      "",
      "   ",
      "x".repeat(MAX_ORGANIZATION_NAME_LENGTH + 1),
      "Acme\nRockets",
      "Acme\tRockets",
      "Acme\u0000",
      // Bidirectional override and zero-width space.
      "Acme\u202eskcor",
      "Ac\u200bme",
      "Acme\u2028",
    ]) {
      expect(validOrganizationName(name), JSON.stringify(name)).toBeNull();
    }
    expect(validOrganizationName("x".repeat(64))).toBe("x".repeat(64));
    // Counted in characters, not UTF-16 units.
    expect(validOrganizationName("é".repeat(64))).toBe("é".repeat(64));
  });
});
