import { describe, expect, it } from "vitest";
import {
  personalOrganizationName,
  slugify,
  validOrganizationName,
} from "./organization-name";
import {
  isPersonalOrganizationOf,
  personalOrganizationMetadata,
} from "./personal-marker";

describe("validOrganizationName", () => {
  it("trims and collapses whitespace", () => {
    expect(validOrganizationName("  Acme   Rockets ")).toBe("Acme Rockets");
  });

  it("refuses empty, overlong and control-character names", () => {
    for (const name of [
      "",
      "   ",
      "x".repeat(65),
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

describe("slugify", () => {
  it("keeps lowercase letters, digits and single dashes", () => {
    expect(slugify(" Acme  Rockets, Inc. ")).toBe("acme-rockets-inc");
    expect(slugify("Every App")).toBe("every-app");
  });
});

describe("personalOrganizationName", () => {
  it("is the person's name, else their email's local part", () => {
    expect(
      personalOrganizationName({
        name: "Ada Lovelace",
        email: "ada@example.com",
      }),
    ).toBe("Ada Lovelace");
    expect(
      personalOrganizationName({
        name: "Ada\nBcc: x",
        email: "ada@example.com",
      }),
    ).toBe("ada");
    expect(
      personalOrganizationName({ name: "", email: "ada@example.com" }),
    ).toBe("ada");
    expect(
      personalOrganizationName({
        name: null,
        email: `${"a".repeat(65)}@x.com`,
      }),
    ).toBe("Personal");
  });
});

describe("personal marker", () => {
  it("marks an organization as one user's, and only theirs", () => {
    const metadata = personalOrganizationMetadata("user-1");
    expect(isPersonalOrganizationOf(metadata, "user-1")).toBe(true);
    expect(isPersonalOrganizationOf(metadata, "user-2")).toBe(false);
    for (const other of [null, undefined, "", "not json", "null", "[]", "{}"]) {
      expect(isPersonalOrganizationOf(other, "user-1")).toBe(false);
    }
  });
});
