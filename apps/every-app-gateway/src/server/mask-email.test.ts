import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask-email";

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("ben@example.com")).toBe("b•••@example.com");
    expect(maskEmail("jordan.alexander-whitfield@very-long.example.com")).toBe(
      "j•••@very-long.example.com",
    );
  });

  it("shows only the dots for a one-character local part", () => {
    expect(maskEmail("b@example.com")).toBe("•••@example.com");
  });

  it("normalizes the way sign-in compares addresses", () => {
    expect(maskEmail("  Ben@Example.COM ")).toBe("b•••@example.com");
  });

  it("counts a surrogate pair as one character", () => {
    expect(maskEmail("😀x@example.com")).toBe("😀•••@example.com");
    expect(maskEmail("😀@example.com")).toBe("•••@example.com");
  });

  it("never prints more of the local part than its first character", () => {
    expect(maskEmail("ab@x.y")).toBe("a•••@x.y");
    expect(maskEmail("no-at-sign")).toBe("n•••");
  });
});
