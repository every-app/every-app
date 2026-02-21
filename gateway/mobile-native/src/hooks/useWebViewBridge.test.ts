import { describe, expect, it } from "vitest";
import { isTrustedCurrentUrlForTokenPush } from "./urlTrust";

describe("isTrustedCurrentUrlForTokenPush", () => {
  it("returns true when current URL origin matches active origin", () => {
    expect(
      isTrustedCurrentUrlForTokenPush(
        "https://app.example.com/path?foo=bar",
        "https://app.example.com",
      ),
    ).toBe(true);
  });

  it("returns false when current URL origin drifts to different host", () => {
    expect(
      isTrustedCurrentUrlForTokenPush(
        "https://evil.example.com/path",
        "https://app.example.com",
      ),
    ).toBe(false);
  });

  it("returns false for null or invalid URLs", () => {
    expect(
      isTrustedCurrentUrlForTokenPush(null, "https://app.example.com"),
    ).toBe(false);
    expect(
      isTrustedCurrentUrlForTokenPush("not-a-url", "https://app.example.com"),
    ).toBe(false);
  });
});
