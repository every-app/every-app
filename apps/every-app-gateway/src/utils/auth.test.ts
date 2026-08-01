import { describe, it, expect } from "vitest";
import { getSafeRedirect, getSafeReturnTo } from "./auth";

describe("getSafeRedirect", () => {
  it("allows internal paths", () => {
    expect(getSafeRedirect("/admin")).toBe("/admin");
    expect(getSafeRedirect("/admin/apps")).toBe("/admin/apps");
  });

  it("rejects absolute URLs and missing values", () => {
    expect(getSafeRedirect("https://evil.example/x")).toBe("/");
    expect(getSafeRedirect(undefined)).toBe("/");
  });

  it("rejects protocol-relative and backslash-prefixed URLs", () => {
    expect(getSafeRedirect("//evil.example")).toBe("/");
    expect(getSafeRedirect("//evil.example/path")).toBe("/");
    expect(getSafeRedirect("/\\evil.example")).toBe("/");
  });
});

describe("getSafeReturnTo", () => {
  const HOST = "example.com";

  it("allows the gateway host itself", () => {
    expect(getSafeReturnTo("https://example.com/settings", HOST)).toBe(
      "https://example.com/settings",
    );
  });

  it("allows app subdomains of the gateway host", () => {
    expect(getSafeReturnTo("https://todo.example.com/lists?a=1", HOST)).toBe(
      "https://todo.example.com/lists?a=1",
    );
  });

  it("keeps ports significant", () => {
    expect(
      getSafeReturnTo("http://todo.localhost:8787/x", "localhost:8787"),
    ).toBe("http://todo.localhost:8787/x");
    expect(
      getSafeReturnTo("http://todo.localhost:9999/x", "localhost:8787"),
    ).toBeNull();
  });

  it("rejects other hosts, including suffix look-alikes", () => {
    expect(getSafeReturnTo("https://evil.example/x", HOST)).toBeNull();
    expect(getSafeReturnTo("https://evilexample.com/x", HOST)).toBeNull();
    expect(getSafeReturnTo("https://example.com.evil.net/x", HOST)).toBeNull();
  });

  it("rejects non-http schemes, credentials, and garbage", () => {
    expect(getSafeReturnTo("javascript:alert(1)", HOST)).toBeNull();
    expect(
      getSafeReturnTo("https://user:pw@todo.example.com/", HOST),
    ).toBeNull();
    expect(getSafeReturnTo("not a url", HOST)).toBeNull();
    expect(getSafeReturnTo(null, HOST)).toBeNull();
  });
});
