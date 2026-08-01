import { describe, it, expect } from "vitest";
import { evaluateCsrf } from "./csrf";

const HOST = "todo.example.com";

describe("evaluateCsrf", () => {
  it("always allows safe methods", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(evaluateCsrf(m, HOST, null, null).allowed).toBe(true);
    }
  });

  it("allows non-GET when Sec-Fetch-Site is same-origin", () => {
    expect(evaluateCsrf("POST", HOST, null, "same-origin").allowed).toBe(true);
  });

  it("denies non-GET when Sec-Fetch-Site is cross-site or none", () => {
    expect(evaluateCsrf("POST", HOST, null, "cross-site").allowed).toBe(false);
    expect(evaluateCsrf("POST", HOST, null, "same-site").allowed).toBe(false);
    expect(evaluateCsrf("POST", HOST, null, "none").allowed).toBe(false);
  });

  it("default-denies non-GET with no origin signals at all", () => {
    expect(evaluateCsrf("POST", HOST, null, null).allowed).toBe(false);
    expect(evaluateCsrf("DELETE", HOST, null, null).allowed).toBe(false);
  });

  it("allows when Origin matches the app host", () => {
    expect(
      evaluateCsrf("POST", HOST, "https://todo.example.com", null).allowed,
    ).toBe(true);
  });

  it("denies when Origin is a different host", () => {
    expect(
      evaluateCsrf("POST", HOST, "https://evil.example.com", null).allowed,
    ).toBe(false);
    expect(
      evaluateCsrf("POST", HOST, "https://chef.example.com", null).allowed,
    ).toBe(false);
  });

  it("denies a malformed Origin", () => {
    expect(evaluateCsrf("POST", HOST, "not a url", null).allowed).toBe(false);
  });

  it("prefers Sec-Fetch-Site over a matching Origin", () => {
    // cross-site sec-fetch-site wins even if Origin looks same-host
    expect(
      evaluateCsrf("POST", HOST, "https://todo.example.com", "cross-site")
        .allowed,
    ).toBe(false);
  });
});
