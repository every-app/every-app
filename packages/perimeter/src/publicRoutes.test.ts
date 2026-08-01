import { describe, it, expect } from "vitest";
import {
  normalizePath,
  isInternalPath,
  matchPublicRoute,
} from "./publicRoutes";
import type { PublicRoute } from "./manifest/manifest";

describe("normalizePath", () => {
  it("passes through clean paths", () => {
    expect(normalizePath("/health")).toEqual({
      canonical: "/health",
      ambiguous: false,
    });
    expect(normalizePath("/a/b/c")).toMatchObject({
      canonical: "/a/b/c",
      ambiguous: false,
    });
  });

  it("collapses redundant slashes and dot segments", () => {
    expect(normalizePath("/a//b/./c")).toMatchObject({
      canonical: "/a/b/c",
      ambiguous: false,
    });
    expect(normalizePath("/a/b/")).toMatchObject({ canonical: "/a/b" });
  });

  it("resolves .. within bounds", () => {
    expect(normalizePath("/a/b/../c")).toMatchObject({
      canonical: "/a/c",
      ambiguous: false,
    });
  });

  it("flags traversal above root as ambiguous", () => {
    expect(normalizePath("/../etc/passwd").ambiguous).toBe(true);
    expect(normalizePath("/a/../../x").ambiguous).toBe(true);
  });

  it("flags encoded traversal (%2e%2e) as ambiguous", () => {
    const r = normalizePath("/p/%2e%2e/__everyapp/tools/call");
    expect(r.ambiguous).toBe(true);
  });

  it("flags encoded path separators (%2f, %5c) as ambiguous", () => {
    expect(normalizePath("/a%2f..%2fb").ambiguous).toBe(true);
    expect(normalizePath("/a%5cb").ambiguous).toBe(true);
  });

  it("flags double-encoding as ambiguous", () => {
    // %252e -> %2e after one decode (still percent-shaped)
    expect(normalizePath("/p/%252e%252e/x").ambiguous).toBe(true);
  });

  it("flags backslashes and control chars as ambiguous", () => {
    expect(normalizePath("/a\\b").ambiguous).toBe(true);
    expect(normalizePath("/a\x00b").ambiguous).toBe(true);
    expect(normalizePath("/a%00b").ambiguous).toBe(true);
  });

  it("flags non-absolute / empty paths as ambiguous", () => {
    expect(normalizePath("").ambiguous).toBe(true);
    expect(normalizePath("relative").ambiguous).toBe(true);
  });
});

describe("isInternalPath", () => {
  it("detects the reserved namespace", () => {
    expect(isInternalPath("/__everyapp")).toBe(true);
    expect(isInternalPath("/__everyapp/tools/call")).toBe(true);
    expect(isInternalPath("/__everyappx")).toBe(false);
    expect(isInternalPath("/health")).toBe(false);
  });
});

describe("matchPublicRoute", () => {
  const routes: PublicRoute[] = [
    { path: "/health" },
    { path: "/blog/*", methods: ["GET"] },
    { path: "/api/webhook", methods: ["POST"] },
    { path: "/assets/**" },
  ];

  it("defaults to deny with no routes", () => {
    expect(matchPublicRoute(undefined, "GET", "/health").public).toBe(false);
    expect(matchPublicRoute([], "GET", "/health").public).toBe(false);
  });

  it("matches an exact GET route", () => {
    expect(matchPublicRoute(routes, "GET", "/health").public).toBe(true);
  });

  it("defaults methods to GET only", () => {
    expect(matchPublicRoute(routes, "POST", "/health").public).toBe(false);
  });

  it("honors declared methods", () => {
    expect(matchPublicRoute(routes, "POST", "/api/webhook").public).toBe(true);
    expect(matchPublicRoute(routes, "GET", "/api/webhook").public).toBe(false);
  });

  it("single-segment * does not cross slashes", () => {
    expect(matchPublicRoute(routes, "GET", "/blog/post-1").public).toBe(true);
    expect(matchPublicRoute(routes, "GET", "/blog/a/b").public).toBe(false);
  });

  it("** crosses slashes", () => {
    expect(matchPublicRoute(routes, "GET", "/assets/css/app.css").public).toBe(
      true,
    );
  });

  it("never treats /__everyapp/* as public, even via traversal", () => {
    const withInternal: PublicRoute[] = [{ path: "/blog/*" }];
    // direct
    expect(
      matchPublicRoute(withInternal, "POST", "/__everyapp/tools/call").public,
    ).toBe(false);
    // smuggled via encoded traversal from a public prefix
    expect(
      matchPublicRoute(
        [{ path: "/p/**" }],
        "POST",
        "/p/%2e%2e/__everyapp/tools/call",
      ).public,
    ).toBe(false);
  });

  it("denies ambiguous paths even if a glob would match", () => {
    expect(matchPublicRoute([{ path: "/a/**" }], "GET", "/a/%2fb").public).toBe(
      false,
    );
  });

  it("normalizes before matching (trailing slash, dot segments)", () => {
    expect(matchPublicRoute(routes, "GET", "/blog/post/").public).toBe(true);
    expect(matchPublicRoute(routes, "GET", "/blog/./post").public).toBe(true);
  });

  it("matches cal.diy-style named route segments", () => {
    const calRoutes: PublicRoute[] = [
      { path: "/:user", methods: ["GET"] },
      { path: "/:user/:type", methods: ["GET", "POST"] },
      { path: "/booking/:uid", methods: ["GET"] },
    ];

    expect(matchPublicRoute(calRoutes, "GET", "/alice").public).toBe(true);
    expect(matchPublicRoute(calRoutes, "GET", "/alice/intro").public).toBe(
      true,
    );
    expect(matchPublicRoute(calRoutes, "POST", "/alice/intro").public).toBe(
      true,
    );
    expect(matchPublicRoute(calRoutes, "GET", "/booking/abc").public).toBe(
      true,
    );
    expect(
      matchPublicRoute(calRoutes, "GET", "/alice/intro/extra").public,
    ).toBe(false);
    expect(matchPublicRoute(calRoutes, "POST", "/alice").public).toBe(false);
  });
});
