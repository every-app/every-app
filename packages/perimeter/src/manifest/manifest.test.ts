import { describe, it, expect } from "vitest";
import {
  validateManifest,
  validateManifestStrict,
  assertPublicPathIsSafe,
  ManifestError,
  GATEWAY_WORKER_NAME,
  isRegistryWorkerName,
  isReservedName,
  registryWorkerNameFor,
  resourceNameFor,
  isReservedAppId,
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

  it("takes only JavaScript identifiers as D1 and KV bindings in authored manifests", () => {
    expect(
      validateManifestStrict({
        id: "todo",
        resources: { d1: ["DB", "MY_ARCHIVE"], kv: ["_cache2"] },
      }).resources,
    ).toEqual({ d1: ["DB", "MY_ARCHIVE"], kv: ["_cache2"] });
    for (const binding of ["MY-ARCHIVE", "2DB", "a b", ""]) {
      expect(() =>
        validateManifestStrict({ id: "todo", resources: { d1: [binding] } }),
      ).toThrow(ManifestError);
    }
    // The gateway's tolerant schema still takes what older CLIs sent.
    expect(
      validateManifest({ id: "todo", resources: { d1: ["MY-ARCHIVE"] } }),
    ).toBeTruthy();
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

describe("access, ai and serverFnGuard manifest fields", () => {
  it("accepts them in both the tolerant and strict schemas", () => {
    const input = {
      id: "chef",
      access: "everyone",
      serverFnGuard: false,
      ai: { models: ["gpt-5.2"], routes: ["/v1/files"] },
    };
    expect(validateManifest(input)).toMatchObject(input);
    expect(validateManifestStrict(input)).toMatchObject(input);
  });

  it("rejects unknown access levels and non-API AI routes", () => {
    expect(() => validateManifest({ id: "a", access: "public" })).toThrow(
      ManifestError,
    );
    expect(() =>
      validateManifest({ id: "a", ai: { routes: ["/v1/../admin"] } }),
    ).toThrow(ManifestError);
    expect(() =>
      validateManifestStrict({ id: "a", ai: { routez: ["/v1/files"] } }),
    ).toThrow(ManifestError);
  });
});

describe("mcp manifest field", () => {
  it("accepts gateway or app in both schemas", () => {
    for (const mcp of ["gateway", "app"]) {
      const input = { id: "todo", mcp };
      expect(validateManifest(input)).toMatchObject(input);
      expect(validateManifestStrict(input)).toMatchObject(input);
    }
    expect(() => validateManifest({ id: "todo", mcp: "both" })).toThrow(
      ManifestError,
    );
  });
});

describe("reserved app ids", () => {
  it("refuses the platform's own prefix when an app is authored", () => {
    expect(isReservedAppId("everyapp")).toBe(true);
    expect(isReservedAppId("everyapp-notes")).toBe(false);
    expect(() => validateManifestStrict({ id: "everyapp" })).toThrow(
      'id "everyapp" is reserved',
    );
    expect(validateManifestStrict({ id: "everyapp-notes" }).id).toBe(
      "everyapp-notes",
    );
  });

  it("still reads an already-registered row tolerantly", () => {
    expect(validateManifest({ id: "everyapp" }).id).toBe("everyapp");
  });
});

describe("serverFnBase manifest field", () => {
  it("accepts a plain path in both schemas", () => {
    for (const serverFnBase of ["/app/_serverFn", "/api/fn/", "/_rpc"]) {
      const input = { id: "todo", serverFnBase };
      expect(validateManifest(input)).toMatchObject(input);
      expect(validateManifestStrict(input)).toMatchObject(input);
    }
  });

  it("rejects the root, relative paths and dot segments", () => {
    for (const serverFnBase of ["/", "_serverFn", "/a/../b", "/a/./b", ""]) {
      expect(() => validateManifest({ id: "todo", serverFnBase })).toThrow(
        ManifestError,
      );
    }
  });
});

describe("registry Worker names", () => {
  const legacy = { appId: "todo", orgKey: "acme", legacyNames: true };
  const scoped = { appId: "todo", orgKey: "acme", legacyNames: false };

  it("assigns every-<orgKey>-<appId>, and every-<appId> to legacy rows", () => {
    expect(registryWorkerNameFor(scoped)).toBe("every-acme-todo");
    expect(registryWorkerNameFor(legacy)).toBe("every-todo");
    expect(() => registryWorkerNameFor({ ...scoped, orgKey: null })).toThrow();
  });

  it("accepts only the Worker a row's naming rule gives it", () => {
    expect(
      isRegistryWorkerName({ ...scoped, workerName: "every-acme-todo" }),
    ).toBe(true);
    expect(isRegistryWorkerName({ ...legacy, workerName: "every-todo" })).toBe(
      true,
    );
    // A legacy name on a scoped row, another org's name, another app's.
    expect(isRegistryWorkerName({ ...scoped, workerName: "every-todo" })).toBe(
      false,
    );
    expect(
      isRegistryWorkerName({ ...scoped, workerName: "every-other-todo" }),
    ).toBe(false);
    expect(isRegistryWorkerName({ ...legacy, workerName: "every-chef" })).toBe(
      false,
    );
    expect(
      isRegistryWorkerName({
        ...scoped,
        orgKey: null,
        workerName: "every-null-todo",
      }),
    ).toBe(false);
  });

  it("never accepts the gateway's own names", () => {
    for (const row of [
      { appId: "app-gateway", orgKey: null, legacyNames: true },
      { appId: "gateway", orgKey: "app", legacyNames: false },
      { appId: "gateway-deploy", orgKey: "app", legacyNames: false },
    ]) {
      expect(
        isRegistryWorkerName({
          ...row,
          workerName: registryWorkerNameFor(row),
        }),
      ).toBe(false);
    }
    expect(isReservedName(GATEWAY_WORKER_NAME)).toBe(true);
    expect(isReservedName("every-app-gateway-OAUTH_KV")).toBe(true);
    expect(isReservedName("every-app-gatewayx")).toBe(false);
  });

  it("refuses an org-scoped app id with the resource separator in it", () => {
    expect(
      isRegistryWorkerName({
        ...scoped,
        appId: "notes--archive",
        workerName: "every-acme-notes--archive",
      }),
    ).toBe(false);
    // A legacy row keeps working.
    expect(
      isRegistryWorkerName({
        ...legacy,
        appId: "notes--archive",
        workerName: "every-notes--archive",
      }),
    ).toBe(true);
  });

  it("refuses names longer than Cloudflare allows", () => {
    const appId = "a".repeat(60);
    expect(
      isRegistryWorkerName({
        ...scoped,
        appId,
        workerName: `every-acme-${appId}`,
      }),
    ).toBe(false);
  });

  it("names resources after the Worker", () => {
    expect(resourceNameFor("every-acme-todo", "DB")).toBe("every-acme-todo");
    expect(resourceNameFor("every-acme-todo", "KV")).toBe("every-acme-todo");
    expect(resourceNameFor("every-acme-todo", "CACHE")).toBe(
      "every-acme-todo--cache",
    );
    expect(resourceNameFor("every-acme-todo", "MY_CACHE")).toBe(
      "every-acme-todo--my-cache",
    );
    expect(resourceNameFor("every-todo", "CACHE", { legacyNames: true })).toBe(
      "every-todo-cache",
    );
  });

  it("never gives one app's binding another org-scoped app's name", () => {
    // App `notes` binding ARCHIVE, and app `notes-archive` in the same org.
    const notesArchive = registryWorkerNameFor({
      ...scoped,
      appId: "notes-archive",
    });
    const archive = resourceNameFor(
      registryWorkerNameFor({ ...scoped, appId: "notes" }),
      "ARCHIVE",
    );
    expect(archive).not.toBe(notesArchive);
    expect(archive).not.toBe(resourceNameFor(notesArchive, "DB"));
  });
});
