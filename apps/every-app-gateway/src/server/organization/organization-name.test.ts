import { describe, expect, it } from "vitest";
import { personalOrganizationName, slugify } from "./organization-name";
import {
  isPersonalOrganizationOf,
  personalOrganizationMetadata,
} from "./personal-marker";

// validOrganizationName itself is the SDK's (packages/sdk/src/internal/organizationName.test.ts).

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
