import { describe, expect, it } from "vitest";
import {
  listPublicRoutes,
  publicRoutesOf,
  storedBearerRoutes,
  storedPublicRoutes,
  type PublicRouteSummary,
} from "./publicRoutes";

describe("an app's public routes", () => {
  it("reads a manifest's routes in its order, with GET alone for a route that names no method", () => {
    expect(publicRoutesOf({ public: [{ path: "/hooks/*" }, { path: "/collect", methods: ["post"] }] })).toEqual([
      { path: "/hooks/*", methods: ["GET"] },
      { path: "/collect", methods: ["POST"] },
    ]);
    expect(publicRoutesOf({ public: [] })).toEqual([]);
    expect(publicRoutesOf({})).toEqual([]);
    expect(publicRoutesOf(null)).toEqual([]);
  });

  it("reads the same from a stored manifest, and nothing from one it can't read", () => {
    const stored = JSON.stringify({
      id: "hooks",
      public: [{ path: "/hooks/*" }, { path: "/uploads/**", methods: ["GET", "head"] }, { methods: ["POST"] }],
    });
    expect(storedPublicRoutes(stored)).toEqual([
      { path: "/hooks/*", methods: ["GET"] },
      { path: "/uploads/**", methods: ["GET", "HEAD"] },
    ]);
    expect(storedPublicRoutes(JSON.stringify({ id: "todo" }))).toEqual([]);
    expect(storedPublicRoutes(JSON.stringify({ id: "todo", public: "/*" }))).toEqual([]);
    expect(storedPublicRoutes("{not json")).toEqual([]);
    expect(storedPublicRoutes(null)).toEqual([]);
  });

  it("reads a stored manifest's bearer routes, and nothing from one it can't read", () => {
    expect(storedBearerRoutes(JSON.stringify({ id: "openzen", bearerRoutes: { paths: ["/api/**", 7, "/v1/*"], why: "Mac app" } }))).toEqual([
      "/api/**",
      "/v1/*",
    ]);
    expect(storedBearerRoutes(JSON.stringify({ id: "todo" }))).toEqual([]);
    expect(storedBearerRoutes(JSON.stringify({ id: "todo", bearerRoutes: ["/api/**"] }))).toEqual([]);
    expect(storedBearerRoutes("{not json")).toEqual([]);
    expect(storedBearerRoutes(null)).toEqual([]);
  });

  it("lists them as a person reads them: methods joined with /, the first six, and how many more", () => {
    const routes = publicRoutesOf({
      public: [
        { path: "/hooks/*" },
        { path: "/collect", methods: ["POST"] },
        { path: "/uploads/**", methods: ["GET", "HEAD"] },
      ],
    });
    expect(listPublicRoutes(routes)).toEqual({
      shown: "GET /hooks/*, POST /collect, GET/HEAD /uploads/**",
      more: 0,
    });
    const nine = publicRoutesOf({
      public: Array.from({ length: 9 }, (_, index) => ({ path: `/r${index + 1}` })),
    });
    expect(listPublicRoutes(nine)).toEqual({
      shown: "GET /r1, GET /r2, GET /r3, GET /r4, GET /r5, GET /r6",
      more: 3,
    });
    expect(listPublicRoutes([])).toEqual({ shown: "", more: 0 });
  });

  it("adds the publicAssets patterns after the routes, as GET/HEAD assets", () => {
    const manifest = { public: [{ path: "/collect", methods: ["POST"] }], publicAssets: ["/favicon.ico", "/assets/**"] };
    const expected: PublicRouteSummary[] = [
      { path: "/collect", methods: ["POST"] },
      { path: "/favicon.ico", methods: ["GET", "HEAD"], asset: true },
      { path: "/assets/**", methods: ["GET", "HEAD"], asset: true },
    ];
    expect(publicRoutesOf(manifest)).toEqual(expected);
    expect(storedPublicRoutes(JSON.stringify({ id: "a", ...manifest, publicAssets: [...manifest.publicAssets, 7] }))).toEqual(
      expected,
    );
    expect(storedPublicRoutes(JSON.stringify({ id: "a", publicAssets: "/favicon.ico" }))).toEqual([]);
    expect(listPublicRoutes(expected).shown).toBe("POST /collect, asset /favicon.ico, asset /assets/**");
  });
});
