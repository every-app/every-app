import { describe, expect, it } from "vitest";
import { evaluateServerFnRequest, isServerFnPath } from "./serverFunctions";

describe("isServerFnPath", () => {
  it("matches the server-function prefix the way TanStack Start routes it", () => {
    expect(isServerFnPath("/_serverFn/abc")).toBe(true);
    expect(isServerFnPath("/_serverFn")).toBe(true);
    expect(isServerFnPath("/%5FserverFn/abc")).toBe(true);
    expect(isServerFnPath("//_serverFn/abc")).toBe(true);
    expect(isServerFnPath("/a/%2e%2e/_serverFn/abc")).toBe(true);
    expect(isServerFnPath("/_SERVERFN/abc")).toBe(true);
  });

  it("does not match other paths", () => {
    expect(isServerFnPath("/")).toBe(false);
    expect(isServerFnPath("/_serverFnx")).toBe(false);
    expect(isServerFnPath("/api/_serverFn/abc")).toBe(false);
    expect(isServerFnPath("/%E0%A4%A")).toBe(false);
  });

  it("still decodes the valid escapes of a path with a malformed one, as Start does", () => {
    // Start decodes each valid %XX on its own when the whole path won't
    // decode, so these reach its server-function handler.
    expect(isServerFnPath("/%5FserverFn/abc/%ZZ")).toBe(true);
    expect(isServerFnPath("/%5FserverFn/abc%E0%A4%A")).toBe(true);
    expect(isServerFnPath("/%5fserverfn/abc/%")).toBe(true);
    expect(isServerFnPath("/%5FserverFnx/%ZZ")).toBe(false);
  });

  it("matches the server-function base an app declares", () => {
    expect(isServerFnPath("/app/_serverFn/abc", "/app/_serverFn")).toBe(true);
    expect(isServerFnPath("/app/%5FserverFn/abc", "/app/_serverFn/")).toBe(
      true,
    );
    expect(isServerFnPath("/app/_serverFn", "/app/_serverFn")).toBe(true);
    expect(isServerFnPath("/_serverFn/abc", "/app/_serverFn")).toBe(false);
  });
});

describe("evaluateServerFnRequest", () => {
  const ok = { "sec-fetch-site": "same-origin", "x-tsr-serverfn": "true" };

  it("allows a same-origin fetch from the TanStack client", () => {
    expect(evaluateServerFnRequest(new Headers(ok)).allowed).toBe(true);
    // Clients without Fetch Metadata still need the header.
    expect(
      evaluateServerFnRequest(new Headers({ "x-tsr-redirect": "manual" }))
        .allowed,
    ).toBe(true);
  });

  it("rejects navigations even from the same origin", () => {
    const navigations: Record<string, string>[] = [
      { "sec-fetch-mode": "navigate" },
      { "sec-fetch-dest": "document" },
      { "sec-fetch-dest": "iframe" },
    ];
    for (const extra of navigations) {
      expect(
        evaluateServerFnRequest(new Headers({ ...ok, ...extra })).allowed,
      ).toBe(false);
    }
  });

  it("rejects HTML requests that carry no Fetch Metadata", () => {
    expect(
      evaluateServerFnRequest(
        new Headers({ accept: "text/html", "x-tsr-serverfn": "true" }),
      ).allowed,
    ).toBe(false);
  });

  it("rejects anything but same-origin when Sec-Fetch-Site is present", () => {
    for (const site of ["same-site", "cross-site", "none"]) {
      expect(
        evaluateServerFnRequest(new Headers({ ...ok, "sec-fetch-site": site }))
          .allowed,
      ).toBe(false);
    }
  });

  it("requires a TanStack client header", () => {
    expect(
      evaluateServerFnRequest(new Headers({ "sec-fetch-site": "same-origin" }))
        .allowed,
    ).toBe(false);
    expect(
      evaluateServerFnRequest(
        new Headers({ "sec-fetch-site": "same-origin", "x-tsr-serverfn": "1" }),
      ).allowed,
    ).toBe(false);
  });
});
