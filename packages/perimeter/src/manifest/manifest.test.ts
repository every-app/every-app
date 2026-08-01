import { describe, it, expect } from "vitest";
import {
  validateManifest,
  validateManifestStrict,
  assertPublicPathIsSafe,
  ManifestError,
} from "./manifest";

describe("validateManifest", () => {
  it("accepts a minimal manifest", () => {
    const m = validateManifest({ id: "todo" });
    expect(m.id).toBe("todo");
  });

  it("accepts a single-character app id", () => {
    expect(validateManifest({ id: "a" }).id).toBe("a");
  });

  it("parses a manifest without flexible toolchain fields unchanged", () => {
    const input = {
      id: "todo",
      name: "Todos",
      resources: { d1: ["DB"], kv: ["KV"] },
      public: [{ path: "/health" }],
    };

    expect(validateManifest(input)).toEqual(input);
    expect(validateManifestStrict(input)).toEqual(input);
  });

  it("accepts resources, main, and public routes", () => {
    const m = validateManifest({
      id: "todo-app",
      name: "Todos",
      main: "src/entry.worker.ts",
      compatibilityDate: "2026-06-01",
      resources: {
        d1: ["DB"],
        durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
      },
      public: [{ path: "/health" }, { path: "/blog/*", methods: ["GET"] }],
    });
    expect(m.public).toHaveLength(2);
    expect(m.compatibilityDate).toBe("2026-06-01");
  });

  it("accepts a duplicate-free provider allowlist", () => {
    const input = { id: "todo", providers: ["openai", "anthropic-v2"] };

    expect(validateManifest(input).providers).toEqual(input.providers);
    expect(validateManifestStrict(input).providers).toEqual(input.providers);
  });

  it("rejects malformed or duplicate provider names", () => {
    for (const providers of [
      ["OpenAI"],
      ["open_ai"],
      ["2openai"],
      ["openai", "openai"],
    ]) {
      expect(() => validateManifest({ id: "todo", providers })).toThrow(
        ManifestError,
      );
      expect(() => validateManifestStrict({ id: "todo", providers })).toThrow(
        ManifestError,
      );
    }
  });

  it("treats an omitted provider allowlist as no proxy access", () => {
    expect(validateManifest({ id: "todo" }).providers).toBeUndefined();
  });

  it("accepts declared app-domain scopes", () => {
    const m = validateManifestStrict({
      id: "todo",
      scopes: {
        "mcp:read": "Read MCP resources",
        api_write: "Write API records",
      },
    });

    expect(m.scopes?.["mcp:read"]).toBe("Read MCP resources");
  });

  it("rejects reserved scope declarations in strict mode", () => {
    expect(() =>
      validateManifestStrict({
        id: "todo",
        scopes: { "provider:openai": "OpenAI egress" },
      }),
    ).toThrow(ManifestError);
    expect(() =>
      validateManifestStrict({
        id: "todo",
        scopes: { "*": "Everything" },
      }),
    ).toThrow(ManifestError);
  });

  it("rejects reserved scope declarations in tolerant (gateway) mode too", () => {
    expect(() =>
      validateManifest({
        id: "todo",
        scopes: { "provider:openai": "OpenAI egress" },
      }),
    ).toThrow(ManifestError);
  });

  it("rejects malformed compatibility dates", () => {
    expect(() =>
      validateManifest({ id: "todo", compatibilityDate: "2026/06/01" }),
    ).toThrow(ManifestError);
  });

  it("rejects non-kebab ids", () => {
    expect(() => validateManifest({ id: "Todo_App" })).toThrow(ManifestError);
    expect(() => validateManifest({ id: "-todo" })).toThrow(ManifestError);
    expect(() => validateManifest({ id: "todo-" })).toThrow(ManifestError);
  });

  it("tolerates unknown keys from a newer CLI (forward compatibility)", () => {
    // The deployed gateway must not brick registration when the CLI's
    // manifest gains additive fields.
    const m = validateManifest({ id: "todo", futureField: 1 });
    expect(m.id).toBe("todo");
  });

  it("still rejects malformed known fields", () => {
    expect(() =>
      validateManifest({ id: "todo", public: [{ path: "no-slash" }] }),
    ).toThrow(ManifestError);
    expect(() =>
      validateManifest({ id: "todo", resources: { d1: [1] } }),
    ).toThrow(ManifestError);
  });

  it("accepts flexible CLI toolchain fields", () => {
    const m = validateManifestStrict({
      id: "todo",
      build: "yarn open-next build",
      dev: "yarn dev --hostname 127.0.0.1",
      install: "yarn install --immutable",
      migrations: { engine: "d1-sql", dir: "migrations", binding: "DB" },
    });

    expect(m.build).toBe("yarn open-next build");
    expect(m.dev).toBe("yarn dev --hostname 127.0.0.1");
    expect(m.install).toBe("yarn install --immutable");
    expect(m.migrations).toEqual({
      engine: "d1-sql",
      dir: "migrations",
      binding: "DB",
    });
  });

  it("accepts disabling dependency install", () => {
    expect(validateManifestStrict({ id: "todo", install: false }).install).toBe(
      false,
    );
  });

  it("rejects invalid flexible CLI toolchain fields", () => {
    expect(() => validateManifestStrict({ id: "todo", build: "" })).toThrow(
      /build/,
    );
    expect(() => validateManifestStrict({ id: "todo", dev: "" })).toThrow(
      /dev/,
    );
    expect(() => validateManifestStrict({ id: "todo", install: "" })).toThrow(
      /install/,
    );
    expect(() => validateManifestStrict({ id: "todo", install: true })).toThrow(
      /install/,
    );
  });

  it("rejects d1-sql migrations without a safe relative dir", () => {
    expect(() =>
      validateManifestStrict({
        id: "todo",
        migrations: { engine: "d1-sql" },
      }),
    ).toThrow(/dir is required/);
    expect(() =>
      validateManifestStrict({
        id: "todo",
        migrations: { engine: "d1-sql", dir: "../migrations" },
      }),
    ).toThrow(/relative path/);
    expect(() =>
      validateManifestStrict({
        id: "todo",
        migrations: { engine: "d1-sql", dir: "/tmp/migrations" },
      }),
    ).toThrow(/relative path/);
  });

  it("rejects an empty migrations binding", () => {
    expect(() =>
      validateManifestStrict({
        id: "todo",
        migrations: { engine: "d1-sql", dir: "migrations", binding: "" },
      }),
    ).toThrow(/binding/);
  });
});

describe("assertPublicPathIsSafe", () => {
  it("hard-errors on catch-all routes", () => {
    for (const p of ["/*", "/**", "*", "/"]) {
      expect(() => assertPublicPathIsSafe(p)).toThrow(ManifestError);
    }
  });

  it("hard-errors on the internal namespace", () => {
    expect(() => assertPublicPathIsSafe("/__everyapp")).toThrow(ManifestError);
    expect(() => assertPublicPathIsSafe("/__everyapp/tools")).toThrow(
      ManifestError,
    );
  });

  it("hard-errors on percent-encoding, backslashes, dot segments", () => {
    expect(() => assertPublicPathIsSafe("/a%2e")).toThrow(ManifestError);
    expect(() => assertPublicPathIsSafe("/a\\b")).toThrow(ManifestError);
    expect(() => assertPublicPathIsSafe("/a/../b")).toThrow(ManifestError);
  });

  it("requires absolute paths", () => {
    expect(() => assertPublicPathIsSafe("health")).toThrow(ManifestError);
  });

  it("accepts valid named public-route segments", () => {
    expect(() => assertPublicPathIsSafe("/:user/:type")).not.toThrow();
    expect(() => assertPublicPathIsSafe("/booking/:uid")).not.toThrow();
  });

  it("rejects malformed named public-route segments", () => {
    expect(() => assertPublicPathIsSafe("/:")).toThrow(ManifestError);
    expect(() => assertPublicPathIsSafe("/:user-id")).toThrow(ManifestError);
  });

  it("accepts ordinary public paths", () => {
    expect(() => assertPublicPathIsSafe("/health")).not.toThrow();
    expect(() => assertPublicPathIsSafe("/blog/*")).not.toThrow();
    expect(() => assertPublicPathIsSafe("/assets/**")).not.toThrow();
  });

  it("validateManifest rejects a manifest containing a catch-all", () => {
    expect(() =>
      validateManifest({ id: "todo", public: [{ path: "/*" }] }),
    ).toThrow(ManifestError);
  });
});
