import { describe, it, expect } from "vitest";
import {
  normalizePath,
  isInternalPath,
  isReservedToolsPath,
  isReservedWellKnownPath,
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

describe("isReservedToolsPath", () => {
  // Raw paths as they could arrive on the wire, before any URL parser
  // resolves dot segments (new Request() would normalize most of these).
  it("finds the tools contract under any spelling", () => {
    for (const raw of [
      "/__everyapp/tools",
      "/__everyapp/tools/",
      "/__everyapp/tools/call",
      "/__everyapp/tools/list",
      "/__EVERYAPP/Tools/CALL",
      "/__everyapp//tools//call",
      "/./__everyapp/./tools/list",
      "/x/../__everyapp/tools/call",
      "/x/y/../../__everyapp/tools/call",
      "/../__everyapp/tools/call",
      "/x/%2e%2e/__everyapp/tools/call",
      "/x/%2E%2E/__everyapp/tools/call",
      "/x/..%2f__everyapp/tools/call",
      "/x/..%2F__everyapp%2Ftools%2Fcall",
      "/..%5c__everyapp%5ctools%5ccall",
      "/\\__everyapp\\tools\\call",
      "/__everyapp/tools%2f",
      "/__everyapp%2ftools%2fcall",
      "/__everyapp%252ftools%252fcall",
      "/%5f%5feveryapp/tools/call",
      "/__everyapp/tools/call/%zz",
    ]) {
      expect(isReservedToolsPath(raw), raw).toBe(true);
    }
  });

  it("leaves look-alikes and the rest of the namespace alone", () => {
    for (const raw of [
      "/__everyapp/toolsx",
      "/__everyapp/ping",
      "/tools/call",
      "/api/__everyapp/tools",
      "/x/__everyapp/tools/../../call",
    ]) {
      expect(isReservedToolsPath(raw), raw).toBe(false);
    }
  });
});

describe("isReservedWellKnownPath", () => {
  it("finds the three OAuth discovery documents under any spelling", () => {
    for (const raw of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration/mcp",
      "/.WELL-KNOWN/OAuth-Authorization-Server",
      "/.well-known//openid-configuration",
      "/x/../.well-known/oauth-authorization-server",
      "/x/%2e%2e/.well-known/openid-configuration",
      "/%2ewell-known/oauth-authorization-server",
      "/.well-known%2foauth-authorization-server",
      "/.well-known%252fopenid-configuration",
      "/.well-known\\oauth-authorization-server",
      "/.well-known/openid-configuration/%zz",
    ]) {
      expect(isReservedWellKnownPath(raw), raw).toBe(true);
    }
  });

  it("finds the path-appended form the MCP SDK tries last, /mcp/.well-known/<document>", () => {
    for (const raw of [
      "/mcp/.well-known/openid-configuration",
      "/mcp/.well-known/openid-configuration/",
      "/mcp/.well-known/openid-configuration/x",
      "/mcp/.well-known/oauth-authorization-server",
      "/mcp/.well-known/oauth-protected-resource",
      "/MCP/.Well-Known/OpenID-Configuration",
      "/mcp//.well-known/openid-configuration",
      "/mcp/x/../.well-known/openid-configuration",
      "/mcp/%2ewell-known/openid-configuration",
      "/mcp%2f.well-known%2fopenid-configuration",
      "/mcp\\.well-known\\openid-configuration",
      "/x/../mcp/.well-known/openid-configuration",
    ]) {
      expect(isReservedWellKnownPath(raw), raw).toBe(true);
    }
  });

  it("leaves the rest of /.well-known/ and look-alikes alone", () => {
    for (const raw of [
      "/.well-known",
      "/.well-known/apple-app-site-association",
      "/.well-known/webfinger",
      "/.well-known/oauth-authorization-server-notes",
      "/.well-known/openid-configuration.json",
      "/.well-known/oauth-protected-resource2",
      "/api/.well-known/openid-configuration",
      "/x/.well-known/oauth-authorization-server/../../x",
      "/mcp",
      "/mcp/.well-known",
      "/mcp/.well-known/webfinger",
      "/mcp2/.well-known/openid-configuration",
      "/api/mcp/.well-known/openid-configuration",
    ]) {
      expect(isReservedWellKnownPath(raw), raw).toBe(false);
    }
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
