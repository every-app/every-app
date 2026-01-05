import { describe, it, expect } from "vitest";
import { isValidAppOrigin } from "./origin-validator";

describe("isValidAppOrigin", () => {
  describe("production URL matching", () => {
    it("accepts exact origin match", () => {
      expect(
        isValidAppOrigin("https://app.example.com", "https://app.example.com"),
      ).toBe(true);
    });

    it("accepts origin when appUrl has trailing path", () => {
      // URL.origin strips the path
      expect(
        isValidAppOrigin(
          "https://app.example.com",
          "https://app.example.com/path",
        ),
      ).toBe(true);
    });

    it("rejects different subdomain", () => {
      expect(
        isValidAppOrigin("https://evil.example.com", "https://app.example.com"),
      ).toBe(false);
    });

    it("rejects different protocol", () => {
      expect(
        isValidAppOrigin("http://app.example.com", "https://app.example.com"),
      ).toBe(false);
    });

    it("rejects different port", () => {
      expect(
        isValidAppOrigin(
          "https://app.example.com:8080",
          "https://app.example.com",
        ),
      ).toBe(false);
    });
  });

  describe("dev URL matching", () => {
    it("accepts matching dev origin", () => {
      expect(
        isValidAppOrigin(
          "http://localhost:3001",
          "https://app.example.com",
          "http://localhost:3001",
        ),
      ).toBe(true);
    });

    it("rejects wrong dev port", () => {
      expect(
        isValidAppOrigin(
          "http://localhost:9999",
          "https://app.example.com",
          "http://localhost:3001",
        ),
      ).toBe(false);
    });

    it("handles null devUrl", () => {
      expect(
        isValidAppOrigin(
          "http://localhost:3001",
          "https://app.example.com",
          null,
        ),
      ).toBe(false);
    });

    it("handles undefined devUrl", () => {
      expect(
        isValidAppOrigin(
          "http://localhost:3001",
          "https://app.example.com",
          undefined,
        ),
      ).toBe(false);
    });
  });

  describe("malformed input handling", () => {
    it("returns false for invalid appUrl", () => {
      expect(isValidAppOrigin("https://app.example.com", "not-a-url")).toBe(
        false,
      );
    });

    it("returns false for invalid devUrl", () => {
      expect(
        isValidAppOrigin(
          "http://localhost:3001",
          "https://app.example.com",
          "not-a-url",
        ),
      ).toBe(false);
    });

    it("returns false for empty appUrl", () => {
      expect(isValidAppOrigin("https://app.example.com", "")).toBe(false);
    });
  });
});
