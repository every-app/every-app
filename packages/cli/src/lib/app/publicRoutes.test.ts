import { describe, expect, it } from "vitest";
import { listPublicRoutes, publicRoutesOf, storedPublicRoutes } from "./publicRoutes";

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
});
