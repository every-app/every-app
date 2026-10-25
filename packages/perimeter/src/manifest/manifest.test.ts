import { describe, it, expect, expectTypeOf } from "vitest";
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
  bucketNameFor,
  queueNameFor,
  isValidQueueName,
  MAX_QUEUE_NAME_LENGTH,
  vectorizeNameFor,
  MAX_VECTORIZE_NAME_LENGTH,
  isReservedAppId,
  manifestTierProblems,
  DISPATCH_INBOUND_PROBLEM,
  type CapabilityRequest,
  aiGatewayIdFor,
  isAiGatewayId,
  bindingNamesOf,
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

  it("takes only JavaScript identifiers as D1, KV and Workflow bindings in authored manifests", () => {
    const workflows = [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }];
    expect(
      validateManifestStrict({
        id: "todo",
        resources: { d1: ["DB", "MY_ARCHIVE"], kv: ["_cache2"], workflows },
      }).resources,
    ).toEqual({ d1: ["DB", "MY_ARCHIVE"], kv: ["_cache2"], workflows });
    for (const binding of ["MY-ARCHIVE", "2DB", "a b", ""]) {
      expect(() =>
        validateManifestStrict({ id: "todo", resources: { d1: [binding] } }),
      ).toThrow(ManifestError);
      expect(() =>
        validateManifestStrict({
          id: "todo",
          resources: { workflows: [{ name: binding, className: "Flow" }] },
        }),
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
  it("takes { by, why } with by gateway or app, in both schemas", () => {
    for (const by of ["gateway", "app"]) {
      const input = {
        id: "todo",
        mcp: { by, why: "Scripts drive this app alone." },
      };
      expect(validateManifest(input)).toMatchObject(input);
      expect(validateManifestStrict(input)).toMatchObject(input);
    }
    expect(validateManifest({ id: "todo" }).mcp).toBeUndefined();
  });

  it("refuses the old string form with the new shape, in both schemas", () => {
    for (const mcp of ["gateway", "app", "both"]) {
      for (const validate of [validateManifest, validateManifestStrict]) {
        expect(() => validate({ id: "todo", mcp })).toThrow(
          'mcp: mcp is { by: "gateway" | "app", why: "..." }',
        );
      }
    }
  });

  it("needs a why that is plain text of at most 200 characters", () => {
    const strict = (mcp: unknown) =>
      validateManifestStrict({ id: "todo", mcp });
    expect(() => strict({ by: "gateway" })).toThrow("mcp.why");
    expect(() => strict({ by: "gateway", why: "" })).toThrow(
      "say why the app needs /mcp on its own host",
    );
    expect(() => strict({ by: "gateway", why: "x".repeat(201) })).toThrow(
      "mcp.why",
    );
    expect(() => strict({ by: "gateway", why: "a\u202eb" })).toThrow(
      "no control characters",
    );
    expect(() => strict({ by: "both", why: "ok" })).toThrow("mcp.by");
    expect(() => strict({ by: "app", why: "ok", extra: 1 })).toThrow(
      ManifestError,
    );
    // The stored form tolerates an unknown key, like every other section.
    expect(
      validateManifest({ id: "todo", mcp: { by: "app", why: "ok", extra: 1 } })
        .mcp,
    ).toMatchObject({ by: "app", why: "ok" });
  });

  it("refuses a public /mcp route when the manifest is authored", () => {
    for (const path of ["/mcp", "/mcp/*", "/mcp/sse"]) {
      expect(() =>
        validateManifestStrict({ id: "todo", public: [{ path }] }),
      ).toThrow(`public: ${path} can't be public`);
    }
    // A pattern that covers /mcp is the same hole under any of its methods.
    for (const route of [
      { path: "/:page" },
      { path: "/:page", methods: ["POST"] },
    ]) {
      expect(() =>
        validateManifestStrict({ id: "todo", public: [route] }),
      ).toThrow("public: /:page can't be public (it covers /mcp)");
    }
    expect(
      validateManifestStrict({ id: "todo", public: [{ path: "/share/:id" }] })
        .public,
    ).toEqual([{ path: "/share/:id" }]);
    // A stored manifest with one still parses: the perimeter decides.
    expect(
      validateManifest({ id: "todo", public: [{ path: "/mcp" }] }).public,
    ).toEqual([{ path: "/mcp" }]);
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
  const scoped = { appId: "todo", orgKey: "acme" };

  it("assigns every-<orgKey>-<appId>", () => {
    expect(registryWorkerNameFor(scoped)).toBe("every-acme-todo");
    expect(() => registryWorkerNameFor({ ...scoped, orgKey: null })).toThrow();
  });

  it("accepts only the Worker a row's naming rule gives it", () => {
    expect(
      isRegistryWorkerName({ ...scoped, workerName: "every-acme-todo" }),
    ).toBe(true);
    // A name without the org key, another org's name, another app's.
    expect(isRegistryWorkerName({ ...scoped, workerName: "every-todo" })).toBe(
      false,
    );
    expect(
      isRegistryWorkerName({ ...scoped, workerName: "every-other-todo" }),
    ).toBe(false);
    expect(
      isRegistryWorkerName({ ...scoped, workerName: "every-acme-chef" }),
    ).toBe(false);
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
      { appId: "gateway", orgKey: "app" },
      { appId: "gateway-kv", orgKey: "app" },
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

describe("capabilities manifest field", () => {
  it("accepts the capabilities the gateway offers, with why", () => {
    const capabilities = {
      dataforseo: { access: "read", why: "Keyword research" },
      context: { access: "read" },
    };
    expect(
      validateManifestStrict({ id: "seo", capabilities }).capabilities,
    ).toEqual(capabilities);
  });

  it.each([
    [
      "an unknown capability",
      { nope: { access: "read" } },
      /capabilities\.nope: unknown capability \(the gateway offers: dataforseo, context, email, members, linkedin, facebook, .*, microsoft-365, stripe, .*, newsapi\)/,
    ],
    [
      "an access level the capability doesn't offer",
      { dataforseo: { access: "write" } },
      /capabilities\.dataforseo\.access: DataForSEO offers read access/,
    ],
    [
      "an entry without access",
      { dataforseo: {} },
      /capabilities\.dataforseo\.access/,
    ],
    [
      "the retired `as` key",
      { dataforseo: { as: "org", access: "read" } },
      /Unrecognized key: "as"/,
    ],
    [
      "the retired `background` key",
      { dataforseo: { access: "read", background: true } },
      /Unrecognized key: "background"/,
    ],
    ["an empty why", { dataforseo: { access: "read", why: "" } }, /why/],
    [
      "email for reading",
      { email: { access: "read" } },
      /capabilities\.email\.access: Email offers write access/,
    ],
    [
      "members for writing",
      { members: { access: "write" } },
      /capabilities\.members\.access: Members offers read access/,
    ],
    [
      "senders on members",
      { members: { access: "read", senders: ["*@mail.example.com"] } },
      /Unrecognized key: "senders"/,
    ],
    [
      "a leftover senders list",
      { email: { access: "write", senders: ["*@mail.example.com"] } },
      /capabilities\.email\.senders: senders moved out of the manifest: set them with `everyapp email set --sender <pattern>`/,
    ],
    [
      "senders on a capability that doesn't send mail",
      { dataforseo: { access: "read", senders: ["*@mail.example.com"] } },
      /capabilities\.dataforseo: Unrecognized key: "senders"/,
    ],
    [
      "an OAuth client for reading",
      { linkedin: { access: "read" } },
      /capabilities\.linkedin\.access: LinkedIn offers write access/,
    ],
    [
      "scope sets on an OAuth client without a scope policy",
      { mastodon: { access: "write", scopes: ["write:statuses"] } },
      /capabilities\.mastodon\.scopes: Mastodon takes no scopes; list it as \{ access: \.\.\., why \}/,
    ],
    [
      "scope sets on a second client without a scope policy",
      { linkedin: { access: "write", scopes: ["identity"] } },
      /capabilities\.linkedin\.scopes: LinkedIn takes no scopes/,
    ],
    [
      "scope sets on an API-key provider",
      { dataforseo: { access: "read", scopes: ["identity"] } },
      /capabilities\.dataforseo\.scopes: DataForSEO takes no scopes/,
    ],
    [
      "scope sets on a gateway service",
      { email: { access: "write", scopes: ["identity"] } },
      /capabilities\.email\.scopes: Email takes no scopes/,
    ],
    [
      "a client with scope sets listed without them",
      { "google-workspace": { access: "write", why: "Reads mail." } },
      /capabilities\.google-workspace\.scopes: Google \(Gmail, Calendar, Search Console and Analytics\) needs scopes: one or more of identity, gmail\.read, calendar\.read, search-console\.read, analytics\.read/,
    ],
    [
      "a client with scope sets listed with none",
      { "google-workspace": { access: "write", scopes: [] } },
      /capabilities\.google-workspace\.scopes: Google \(Gmail, Calendar, Search Console and Analytics\) needs scopes: one or more of identity, gmail\.read, calendar\.read, search-console\.read, analytics\.read/,
    ],
    [
      "scope sets that aren't a list",
      { "microsoft-365": { access: "write", scopes: "mail.read" } },
      /capabilities\.microsoft-365\.scopes: Microsoft 365 \(Outlook mail and calendar\) needs scopes: one or more of identity, mail\.read, calendar\.read/,
    ],
    [
      "a scope set the client doesn't offer, at its index",
      {
        "google-workspace": {
          access: "write",
          scopes: ["gmail.read", "gmail.send"],
        },
      },
      /capabilities\.google-workspace\.scopes\.1: unknown scope set \(Google \(Gmail, Calendar, Search Console and Analytics\) offers: identity, gmail\.read, calendar\.read, search-console\.read, analytics\.read\)/,
    ],
    [
      "a provider scope where a set name goes",
      {
        "microsoft-365": {
          access: "write",
          scopes: ["https://graph.microsoft.com/Mail.Read"],
        },
      },
      /capabilities\.microsoft-365\.scopes\.0: unknown scope set \(Microsoft 365 \(Outlook mail and calendar\) offers: identity, mail\.read, calendar\.read\)/,
    ],
    [
      "a prototype property as a scope set",
      { "google-workspace": { access: "write", scopes: ["constructor"] } },
      /capabilities\.google-workspace\.scopes\.0: unknown scope set/,
    ],
    [
      "a scope set listed twice",
      {
        "google-workspace": {
          access: "write",
          scopes: ["gmail.read", "calendar.read", "gmail.read"],
        },
      },
      /capabilities\.google-workspace\.scopes: a scope set is listed twice/,
    ],
  ])("refuses %s", (_case, capabilities, problem) => {
    expect(() => validateManifestStrict({ id: "seo", capabilities })).toThrow(
      problem,
    );
  });

  it("accepts the OAuth clients with scope policies, with their scope sets", () => {
    const capabilities = {
      "google-workspace": {
        access: "write",
        scopes: ["gmail.read", "calendar.read"],
        why: "Reads each member's own mailbox and calendar.",
      },
      "microsoft-365": { access: "write", scopes: ["identity", "mail.read"] },
    };
    expect(
      validateManifestStrict({ id: "crm", capabilities }).capabilities,
    ).toEqual(capabilities);
    expectTypeOf<CapabilityRequest["scopes"]>().toEqualTypeOf<
      string[] | undefined
    >();
  });

  it("accepts a client the Gateway runs the flow for with access: read and its sets", () => {
    const capabilities = {
      "google-workspace": {
        access: "read",
        optional: true,
        scopes: ["identity", "search-console.read", "analytics.read"],
        why: "Search Console and GA4 reads through the Gateway's connection.",
      },
      slack: { access: "read", scopes: ["channels.read", "users.read"] },
    };
    expect(
      validateManifestStrict({ id: "seo", capabilities }).capabilities,
    ).toEqual(capabilities);
  });

  it("accepts the OAuth clients for writing, with why", () => {
    const capabilities = {
      linkedin: { access: "write", why: "Connects LinkedIn channels." },
      "tiktok-business": { access: "write" },
      mastodon: { access: "write", why: "Connects Mastodon accounts." },
    };
    expect(
      validateManifestStrict({ id: "postiz", capabilities }).capabilities,
    ).toEqual(capabilities);
  });

  it("accepts email as a declaration only", () => {
    const capabilities = {
      email: {
        access: "write",
        why: "Sends mail from the organization's mailboxes.",
      },
    };
    expect(
      validateManifestStrict({ id: "inbox", capabilities }).capabilities,
    ).toEqual(capabilities);
    // The senders are the installation's (`everyapp email set --sender`).
    expect(
      validateManifestStrict({
        id: "inbox",
        capabilities: { email: { access: "write" } },
      }).capabilities,
    ).toEqual({ email: { access: "write" } });
  });

  it("accepts members for reading", () => {
    const capabilities = {
      members: { access: "read", why: "Whom scheduled reports go to." },
    };
    expect(
      validateManifestStrict({ id: "analytics", capabilities }).capabilities,
    ).toEqual(capabilities);
  });

  it("refuses the old `integrations` key", () => {
    expect(() =>
      validateManifestStrict({
        id: "seo",
        integrations: { dataforseo: { access: "read" } },
      }),
    ).toThrow(/integrations/);
  });

  it("stays tolerant at registration, so a newer CLI's capability never bricks a gateway", () => {
    expect(
      validateManifest({
        id: "seo",
        capabilities: { "new-provider": { access: "read", scopes: ["x"] } },
      }).capabilities,
    ).toEqual({ "new-provider": { access: "read", scopes: ["x"] } });
    // A set name this gateway doesn't know is kept for the token endpoint
    // to refuse; a value that isn't a list of names reads as undeclared.
    expect(
      validateManifest({
        id: "crm",
        capabilities: {
          "google-workspace": { access: "write", scopes: ["not-a-set"] },
          "microsoft-365": { access: "write", scopes: "mail.read" },
        },
      }).capabilities,
    ).toEqual({
      "google-workspace": { access: "write", scopes: ["not-a-set"] },
      "microsoft-365": { access: "write", scopes: undefined },
    });
    // And the gateway keeps an entry's fields as sent, senders included.
    expect(
      validateManifest({
        id: "inbox",
        capabilities: {
          email: { access: "write", senders: ["*@mail.example.com"] },
        },
      }).capabilities,
    ).toEqual({ email: { access: "write", senders: ["*@mail.example.com"] } });
  });
});

describe("secrets manifest field", () => {
  it("accepts the app's own secret names in both schemas", () => {
    const secrets = ["GITHUB_TOKEN", "STRIPE_KEY", "BETTER_AUTH_SECRET"];
    expect(validateManifestStrict({ id: "repolens", secrets }).secrets).toEqual(
      secrets,
    );
    expect(validateManifest({ id: "repolens", secrets }).secrets).toEqual(
      secrets,
    );
    expect(validateManifestStrict({ id: "repolens" }).secrets).toBeUndefined();
  });

  it.each([
    [
      "a name that isn't an identifier",
      ["GITHUB-TOKEN"],
      /secrets\.0: binding names must be JavaScript identifiers/,
    ],
    [
      "a duplicate",
      ["GITHUB_TOKEN", "GITHUB_TOKEN"],
      /secrets\.1: duplicate secret GITHUB_TOKEN/,
    ],
    [
      "a name the deploy sets",
      ["GATEWAY_URL"],
      /secrets\.0: GATEWAY_URL is set by everyapp itself/,
    ],
    [
      "a name in the platform's namespaces, whatever its case",
      ["every_app_org_id"],
      /secrets\.0: every_app_org_id is set by everyapp itself/,
    ],
    [
      "the gateway binding's namespace",
      ["APP__todo"],
      /secrets\.0: APP__todo is set by everyapp itself/,
    ],
    [
      "an AI provider's key, naming the provider to list",
      ["OPENAI_API_KEY"],
      /secrets\.0: OPENAI_API_KEY is a Gateway setting, which `everyapp secret set OPENAI_API_KEY` sets on the Gateway for every app; list `openai` under providers instead/,
    ],
    [
      "an OAuth client's secret, whatever its case, naming the capability",
      ["linkedin_client_secret"],
      /secrets\.0: linkedin_client_secret is a Gateway setting, which `everyapp secret set LINKEDIN_CLIENT_SECRET` sets on the Gateway for every app; list `linkedin` under capabilities instead/,
    ],
    [
      "a Gateway switch no capability owns",
      ["MCP_OAUTH_ENABLED"],
      /secrets\.0: MCP_OAUTH_ENABLED is a Gateway setting, which `everyapp secret set MCP_OAUTH_ENABLED` sets on the Gateway for every app; give the app's secret another name/,
    ],
  ])("refuses %s when authored", (_what, secrets, message) => {
    expect(() => validateManifestStrict({ id: "repolens", secrets })).toThrow(
      message,
    );
  });

  it("refuses an app secret in the sign-in family", () => {
    // `<ID>_SIGNIN_<FIELD>` is the sign-in providers' family, catalog entry
    // or not: an app can never hold the Gateway's Google client secret, nor
    // reserve a name a future provider would read.
    for (const name of [
      "GOOGLE_SIGNIN_CLIENT_SECRET",
      "okta_signin_client_id",
    ]) {
      expect(() =>
        validateManifestStrict({ id: "repolens", secrets: [name] }),
      ).toThrow(
        new RegExp(
          `secrets\\.0: ${name} is a sign-in provider's setting name \\(every <ID>_SIGNIN_<FIELD> name is the Gateway's, set with \`everyapp signin add\`\\); give the app's secret another name`,
        ),
      );
    }
  });

  it("refuses a secret named like one of the app's bindings", () => {
    const manifest = {
      id: "seo",
      resources: {
        d1: ["DB"],
        kv: ["KV"],
        workflows: [{ name: "RUN", className: "Run" }],
      },
      workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
      database: { provider: "d1" },
    };
    for (const name of [
      "DB",
      "KV",
      "RUN",
      "AUDIT_ENGINE",
      "DATABASE_PROVIDER",
      "ASSETS",
    ]) {
      expect(
        () => validateManifestStrict({ ...manifest, secrets: [name] }),
        name,
      ).toThrow(`secrets: ${name} is one of the app's bindings`);
    }
    expect(
      validateManifestStrict({ ...manifest, secrets: ["GITHUB_TOKEN"] })
        .secrets,
    ).toEqual(["GITHUB_TOKEN"]);
  });

  it("stays tolerant at registration, within bounds", () => {
    expect(
      validateManifest({
        id: "repolens",
        secrets: ["OPENAI_API_KEY", "GATEWAY_URL", "DB"],
      }).secrets,
    ).toEqual(["OPENAI_API_KEY", "GATEWAY_URL", "DB"]);
    expect(() =>
      validateManifest({ id: "repolens", secrets: ["not a name"] }),
    ).toThrow(/secrets\.0: a secret's name is an identifier/);
  });

  it("is refused for third-party apps on the dispatch tier", () => {
    expect(
      manifestTierProblems({ secrets: ["GITHUB_TOKEN"] }, "dispatch"),
    ).toEqual([
      "secrets: third-party apps can't have secrets of their own yet",
    ]);
    expect(manifestTierProblems({ secrets: [] }, "dispatch")).toEqual([]);
    expect(
      manifestTierProblems({ secrets: ["GITHUB_TOKEN"] }, "service_binding"),
    ).toEqual([]);
  });
});

describe("each setting's need (optional, anyOf, why, docs)", () => {
  it("accepts providers and secrets by id or as entries, in both schemas", () => {
    const manifest = {
      id: "inbox",
      providers: [
        { id: "workers-ai", anyOf: "AI model", why: "Runs the agent." },
        {
          id: "openrouter",
          anyOf: "AI model",
          docs: "https://openrouter.ai/settings/keys",
        },
        "openai",
      ],
      capabilities: {
        email: { access: "write", why: "Sends from mailboxes." },
        context: { access: "read", optional: true },
      },
      secrets: [
        "MAIN_SECRET",
        {
          name: "GITHUB_TOKEN",
          optional: true,
          why: "Raises GitHub's rate limit.",
          docs: "https://github.com/settings/tokens",
        },
      ],
    };
    expect(validateManifestStrict(manifest)).toEqual(manifest);
    expect(validateManifest(manifest)).toEqual(manifest);
  });

  it("lets an app's own secret name its setup guide, and providers and capabilities not", () => {
    expect(
      validateManifestStrict({
        id: "analytics",
        secrets: [{ name: "MAIN_SECRET", setup: "setup/main-secret.md" }],
      }).secrets,
    ).toEqual([{ name: "MAIN_SECRET", setup: "setup/main-secret.md" }]);
    expect(() =>
      validateManifestStrict({
        id: "analytics",
        secrets: [{ name: "MAIN_SECRET", setup: "docs/secret.md" }],
      }),
    ).toThrow(/secrets\.0\.setup: must be a guide in the everyapp skill/);
    expect(() =>
      validateManifestStrict({
        id: "analytics",
        providers: [{ id: "openai", setup: "setup/openai.md" }],
      }),
    ).toThrow(/providers\.0: Unrecognized key/);
    expect(() =>
      validateManifestStrict({
        id: "analytics",
        capabilities: { email: { access: "write", setup: "setup/email.md" } },
      }),
    ).toThrow(/capabilities\.email: Unrecognized key/);
  });

  it("passes an entry's unknown fields through at registration, as a newer CLI's manifest may carry them", () => {
    const registered = validateManifest({
      id: "inbox",
      providers: [{ id: "openai", later: true }],
      secrets: [{ name: "MAIN_SECRET", later: true }],
    });
    expect(registered.providers).toEqual([{ id: "openai", later: true }]);
    expect(registered.secrets).toEqual([{ name: "MAIN_SECRET", later: true }]);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [{ id: "openai", later: true }],
      }),
    ).toThrow(/providers\.0: Unrecognized key/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [{ name: "MAIN_SECRET", later: true }],
      }),
    ).toThrow(/secrets\.0: Unrecognized key/);
  });

  it("applies the name rules to an entry's name as to a bare name", () => {
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: ["GITHUB_TOKEN", { name: "GITHUB_TOKEN", optional: true }],
      }),
    ).toThrow(/secrets\.1: duplicate secret GITHUB_TOKEN/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [{ name: "OPENAI_API_KEY" }],
      }),
    ).toThrow(/secrets\.0: OPENAI_API_KEY is a Gateway setting/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        resources: { d1: ["DB"] },
        secrets: [{ name: "DB", optional: true }],
      }),
    ).toThrow(/secrets: DB is one of the app's bindings/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: ["openai", { id: "openai", optional: true }],
      }),
    ).toThrow(/providers\.1: duplicate provider/);
    expect(() =>
      validateManifest({
        id: "inbox",
        providers: [{ id: "openai" }, "openai"],
      }),
    ).toThrow(/providers\.1: duplicate provider/);
  });

  it("refuses docs that aren't https, and a why or group that is empty or too long", () => {
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [{ name: "GITHUB_TOKEN", docs: "http://github.com" }],
      }),
    ).toThrow(/secrets\.0\.docs: must be an https URL/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [{ id: "openai", docs: "settings/keys" }],
      }),
    ).toThrow(/providers\.0\.docs/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        capabilities: { context: { access: "read", why: "" } },
      }),
    ).toThrow(/capabilities\.context\.why/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [
          { name: "A", anyOf: "x".repeat(41) },
          { name: "B", anyOf: "x".repeat(41) },
        ],
      }),
    ).toThrow(/secrets\.0\.anyOf/);
  });

  it("refuses an entry that is both optional and in a any-of group", () => {
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [
          { id: "workers-ai", anyOf: "AI model", optional: true },
          { id: "openrouter", anyOf: "AI model" },
        ],
      }),
    ).toThrow(
      'providers: workers-ai is both optional and in the any-of group "AI model"; a group\'s member is optional by itself, so drop one of them.',
    );
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        capabilities: {
          email: { access: "write", anyOf: "mail", optional: true },
          members: { access: "read", anyOf: "mail" },
        },
      }),
    ).toThrow(
      /capabilities\.email is both optional and in the any-of group "mail"/,
    );
  });

  it("refuses a any-of group with one member, and counts members across providers, capabilities and secrets", () => {
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [{ id: "openrouter", anyOf: "AI model" }],
      }),
    ).toThrow(
      'the any-of group "AI model" has one member (providers: openrouter); an any-of group needs two or more. Drop anyOf, or mark it optional.',
    );
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [{ id: "openrouter", anyOf: "AI model" }],
        secrets: [{ name: "NORTHWIND_API_KEY", anyOf: "AI model" }],
      }),
    ).not.toThrow();
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        capabilities: { context: { access: "read", anyOf: "research" } },
        secrets: [{ name: "FIRECRAWL_KEY", anyOf: " research " }],
      }),
    ).not.toThrow();
  });

  it("counts a secret entry for the dispatch tier like a bare name", () => {
    expect(
      manifestTierProblems(
        { secrets: [{ name: "GITHUB_TOKEN", optional: true }] },
        "dispatch",
      ),
    ).toEqual([
      "secrets: third-party apps can't have secrets of their own yet",
    ]);
  });
});

describe("helper Workers", () => {
  const withAudit = {
    id: "seo",
    workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
    resources: {
      durableObjects: [
        { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
      ],
      workflows: [
        { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
      ],
    },
  };

  it("accepts helper Workers and the classes they define", () => {
    const manifest = validateManifestStrict(withAudit);
    expect(manifest.workers).toEqual([
      { name: "audit", binding: "AUDIT_ENGINE" },
    ]);
    expect(manifest.resources?.workflows).toEqual([
      { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
    ]);
  });

  it("keeps the defining Worker at registration", () => {
    expect(validateManifest(withAudit).resources?.durableObjects).toEqual([
      { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
    ]);
  });

  it.each([
    [
      "a class on an undeclared Worker",
      { ...withAudit, workers: [] },
      /SCRATCHPAD is defined by Worker "audit", which workers doesn't declare/,
    ],
    [
      "a Worker declared twice",
      { ...withAudit, workers: [{ name: "audit" }, { name: "audit" }] },
      /workers lists "audit" twice/,
    ],
    [
      "a name that would break the Worker's name apart",
      { id: "seo", workers: [{ name: "audit--x" }] },
      /kebab-case/,
    ],
    [
      "a binding that isn't a JavaScript identifier",
      { id: "seo", workers: [{ name: "audit", binding: "AUDIT-ENGINE" }] },
      /binding names must be JavaScript identifiers/,
    ],
    [
      "an unknown key on a helper Worker",
      { id: "seo", workers: [{ name: "audit", routes: ["/x"] }] },
      /Unrecognized key: "routes"/,
    ],
  ])("refuses %s", (_case, manifest, problem) => {
    expect(() => validateManifestStrict(manifest)).toThrow(problem);
  });
});

describe("Postgres, Hyperdrive and Worker limits", () => {
  const openseo = {
    id: "openseo",
    resources: {
      kv: ["KV"],
      hyperdrive: [
        { name: "HYPERDRIVE" },
        { name: "CRAWL_DB", worker: "audit" },
      ],
    },
    workers: [
      { name: "audit", binding: "AUDIT_ENGINE", limits: { cpuMs: 300_000 } },
    ],
    database: { provider: "postgres", region: "aws:us-east-1" },
    limits: { cpuMs: 30_000 },
    migrations: {
      engine: "drizzle",
      dialect: "postgresql",
      dir: "drizzle/pg",
      config: "drizzle/pg.config.ts",
    },
  };

  it("accepts Hyperdrive for the app's Workers, a Postgres database and CPU limits", () => {
    expect(validateManifestStrict(openseo)).toEqual(openseo);
    expect(validateManifest(openseo)).toEqual(openseo);
  });

  it.each([
    [
      "a Hyperdrive config bound by an undeclared helper",
      {
        resources: { hyperdrive: [{ name: "HYPERDRIVE", worker: "crawler" }] },
      },
      /Hyperdrive HYPERDRIVE is bound by Worker "crawler"/,
    ],
    [
      "a Hyperdrive binding that isn't an identifier",
      { resources: { hyperdrive: [{ name: "hyper-drive" }] } },
      /resources\.hyperdrive\.0\.name/,
    ],
    [
      "a Hyperdrive binding named like a D1 database",
      { resources: { d1: ["DB"], hyperdrive: [{ name: "DB" }] } },
      /the binding DB is declared twice/,
    ],
    [
      "Postgres migrations without a Postgres database",
      { database: { provider: "d1" } },
      /need database: \{ provider: "postgres" \}/,
    ],
    [
      "Postgres migrations on the d1-sql engine",
      { migrations: { engine: "d1-sql", dialect: "postgresql", dir: "sql" } },
      /migrations\.engine: Postgres migrations run on the "drizzle" or "prisma" engine/,
    ],
    [
      "Postgres migrations naming a D1 binding",
      {
        migrations: { engine: "drizzle", dialect: "postgresql", binding: "DB" },
      },
      /migrations\.binding/,
    ],
    [
      "a drizzle config outside the app",
      {
        migrations: {
          engine: "drizzle",
          dialect: "postgresql",
          config: "../pg.config.ts",
        },
      },
      /migrations\.config/,
    ],
    [
      "a CPU limit over Cloudflare's 5 minutes",
      { limits: { cpuMs: 300_001 } },
      /limits\.cpuMs/,
    ],
    ["an unknown limit", { limits: { memoryMb: 256 } }, /limits/],
    [
      "a region that isn't a cloud region",
      { database: { provider: "postgres", region: "Virginia" } },
      /database\.region/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...openseo, ...change })).toThrow(
      problem,
    );
  });

  it("refuses Hyperdrive and R2 on the dispatch tier, and any tier it doesn't know", () => {
    expect(manifestTierProblems(openseo, "service_binding")).toEqual([]);
    expect(manifestTierProblems(openseo, "dispatch")).toEqual([
      expect.stringMatching(/at most 25 configs/),
    ]);
    expect(
      manifestTierProblems({ resources: { kv: ["KV"] } }, "dispatch"),
    ).toEqual([]);
    expect(
      manifestTierProblems({ resources: { r2: ["R2"] } }, "dispatch"),
    ).toEqual([
      "resources.r2: R2 buckets aren't available to apps in a dispatch namespace yet",
    ]);
    expect(
      manifestTierProblems({ resources: { r2: ["R2"] } }, "service_binding"),
    ).toEqual([]);
    expect(manifestTierProblems({}, "edge")).toEqual([
      'apps on tier "edge" can\'t be deployed',
    ]);
  });
});

describe("Prisma migrations, Hyperdrive caching and R2 buckets", () => {
  // Postiz's Postgres variant (plan increment I10).
  const postiz = {
    id: "postiz",
    resources: {
      r2: ["R2", "MEDIA"],
      hyperdrive: [{ name: "HYPERDRIVE", caching: "off" }],
    },
    database: { provider: "postgres" },
    migrations: {
      engine: "prisma",
      dialect: "postgresql",
      config: "prisma.config.ts",
    },
  };

  it("accepts Prisma on Postgres, a caching choice and declared buckets in both schemas", () => {
    expect(validateManifestStrict(postiz)).toEqual(postiz);
    expect(validateManifest(postiz)).toEqual(postiz);
    const cached = {
      ...postiz,
      resources: { hyperdrive: [{ name: "HYPERDRIVE", caching: "default" }] },
      migrations: {
        engine: "prisma",
        dialect: "postgresql",
        dir: "prisma/migrations",
      },
    };
    expect(validateManifestStrict(cached)).toEqual(cached);
  });

  it.each([
    [
      "Prisma migrations without a dialect (D1)",
      { migrations: { engine: "prisma" } },
      /migrations\.engine: Prisma migrations run on Postgres \(dialect "postgresql"\); D1 takes the generated SQL through "d1-sql"/,
    ],
    [
      "Prisma migrations on sqlite",
      { migrations: { engine: "prisma", dialect: "sqlite" } },
      /Prisma migrations run on Postgres/,
    ],
    [
      "Prisma migrations naming a D1 binding",
      {
        migrations: { engine: "prisma", dialect: "postgresql", binding: "DB" },
      },
      /migrations\.binding/,
    ],
    [
      "a Prisma config outside the app",
      {
        migrations: {
          engine: "prisma",
          dialect: "postgresql",
          config: "../../libraries/prisma.config.ts",
        },
      },
      /migrations\.config/,
    ],
    [
      "a caching choice Hyperdrive doesn't have",
      { resources: { hyperdrive: [{ name: "HYPERDRIVE", caching: "on" }] } },
      /resources\.hyperdrive\.0\.caching/,
    ],
    [
      "an R2 binding that isn't an identifier",
      { resources: { r2: ["media-files"] } },
      /resources\.r2\.0/,
    ],
    [
      "an R2 binding named like a D1 database",
      { resources: { d1: ["DB"], r2: ["DB"] } },
      /the binding DB is declared twice/,
    ],
    [
      "an R2 binding named like a Hyperdrive config",
      {
        resources: { r2: ["HYPERDRIVE"], hyperdrive: [{ name: "HYPERDRIVE" }] },
      },
      /the binding HYPERDRIVE is declared twice/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...postiz, ...change })).toThrow(
      problem,
    );
  });

  it("keeps Prisma on D1 on d1-sql, with Prisma's generated SQL", () => {
    const d1 = {
      id: "postiz",
      resources: { d1: ["DB"] },
      database: { provider: "d1" },
      migrations: { engine: "d1-sql", dir: "migrations", binding: "DB" },
    };
    expect(validateManifestStrict(d1)).toEqual(d1);
  });

  it("stays tolerant of R2 entries at registration", () => {
    expect(
      validateManifest({ id: "postiz", resources: { r2: ["media-files"] } })
        .resources?.r2,
    ).toEqual(["media-files"]);
  });

  it("names buckets after the Worker: R2 takes its name, others <worker>--<binding>", () => {
    expect(bucketNameFor("every-acme-postiz", "R2")).toBe("every-acme-postiz");
    expect(bucketNameFor("every-acme-postiz", "MEDIA_FILES")).toBe(
      "every-acme-postiz--media-files",
    );
    // DB and KV are database and namespace names, not bucket names.
    expect(bucketNameFor("every-acme-postiz", "DB")).toBe(
      "every-acme-postiz--db",
    );
  });
});

describe("Workers AI (resources.ai)", () => {
  const assistant = { id: "assistant", resources: { d1: ["DB"], ai: ["AI"] } };

  it("accepts Workers AI bindings in both schemas, beside the AI proxy's own ai field", () => {
    expect(validateManifestStrict(assistant)).toEqual(assistant);
    expect(validateManifest(assistant)).toEqual(assistant);
    const both = {
      ...assistant,
      resources: { ai: ["AI", "AI_BATCH"] },
      providers: ["workers-ai"],
      ai: { models: ["@cf/meta/llama-3.1-8b-instruct"] },
    };
    expect(validateManifestStrict(both)).toEqual(both);
  });

  it.each([
    [
      "a binding that isn't an identifier",
      { resources: { ai: ["workers-ai"] } },
      /resources\.ai\.0/,
    ],
    [
      "a binding named like a KV namespace",
      { resources: { kv: ["AI"], ai: ["AI"] } },
      /the binding AI is declared twice/,
    ],
    [
      "the same binding twice",
      { resources: { ai: ["AI", "AI"] } },
      /the binding AI is declared twice/,
    ],
    [
      "a secret named like the binding",
      { resources: { ai: ["AI"] }, secrets: ["AI"] },
      /secrets: AI is one of the app's bindings/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...assistant, ...change })).toThrow(
      problem,
    );
  });

  it("stays tolerant of entries at registration", () => {
    expect(
      validateManifest({ id: "assistant", resources: { ai: ["workers-ai"] } })
        .resources?.ai,
    ).toEqual(["workers-ai"]);
  });

  it("is refused on the dispatch tier, where it would bill the platform's account", () => {
    expect(manifestTierProblems(assistant, "dispatch")).toEqual([
      "resources.ai: the Workers AI binding isn't available to apps in a dispatch namespace (it bills the platform's account); list the workers-ai provider instead",
    ]);
    expect(manifestTierProblems(assistant, "service_binding")).toEqual([]);
    expect(manifestTierProblems({ resources: { ai: [] } }, "dispatch")).toEqual(
      [],
    );
  });
});

describe("Vectorize indexes (resources.vectorize)", () => {
  const sized = { name: "VECTORS", dimensions: 768, metric: "cosine" };
  const preset = { name: "DOCS", preset: "@cf/baai/bge-small-en-v1.5" };

  it("takes { name, dimensions, metric } or { name, preset }", () => {
    const manifest = { id: "notes", resources: { vectorize: [sized, preset] } };
    expect(validateManifestStrict(manifest)).toEqual(manifest);
    expect(validateManifest(manifest)).toEqual(manifest);
    for (const metric of ["cosine", "euclidean", "dot-product"]) {
      expect(() =>
        validateManifestStrict({
          id: "notes",
          resources: { vectorize: [{ ...sized, metric }] },
        }),
      ).not.toThrow();
    }
  });

  it.each([
    [
      "both forms",
      [{ ...sized, preset: preset.preset }],
      /VECTORS: a preset sets the index's dimensions and metric itself/,
    ],
    [
      "a preset with a metric",
      [{ ...preset, metric: "cosine" }],
      /DOCS: a preset sets the index's dimensions and metric itself/,
    ],
    [
      "neither form",
      [{ name: "VECTORS" }],
      /VECTORS needs dimensions and metric \(e\.g\. 768 and "cosine"\), or a preset/,
    ],
    [
      "dimensions without a metric",
      [{ name: "VECTORS", dimensions: 768 }],
      /VECTORS needs dimensions and metric/,
    ],
    [
      "dimensions below Cloudflare's range",
      [{ ...sized, dimensions: 16 }],
      /resources\.vectorize\.0\.dimensions: a Vectorize index has 32 to 1536 dimensions/,
    ],
    [
      "dimensions above Cloudflare's range",
      [{ ...sized, dimensions: 1537 }],
      /a Vectorize index has 32 to 1536 dimensions/,
    ],
    [
      "fractional dimensions",
      [{ ...sized, dimensions: 76.8 }],
      /resources\.vectorize\.0\.dimensions/,
    ],
    [
      "a metric Vectorize doesn't have",
      [{ ...sized, metric: "manhattan" }],
      /resources\.vectorize\.0\.metric/,
    ],
    [
      "a preset Vectorize doesn't have",
      [{ name: "DOCS", preset: "@cf/baai/bge-m3" }],
      /resources\.vectorize\.0\.preset/,
    ],
    [
      "a binding that isn't an identifier",
      [{ ...sized, name: "my-vectors" }],
      /resources\.vectorize\.0\.name: binding names must be JavaScript identifiers/,
    ],
    ["an unknown key", [{ ...sized, worker: "crawler" }], /Unrecognized key/],
  ])("refuses %s", (_case, vectorize, problem) => {
    expect(() =>
      validateManifestStrict({ id: "notes", resources: { vectorize } }),
    ).toThrow(problem);
  });

  it("refuses a binding declared twice, and a secret named like one", () => {
    expect(() =>
      validateManifestStrict({
        id: "notes",
        resources: { d1: ["VECTORS"], vectorize: [sized] },
      }),
    ).toThrow(/the binding VECTORS is declared twice/);
    expect(() =>
      validateManifestStrict({
        id: "notes",
        resources: { vectorize: [sized] },
        secrets: ["VECTORS"],
      }),
    ).toThrow(/secrets: VECTORS is one of the app's bindings/);
  });

  it("stays tolerant of entries a newer CLI writes, at registration", () => {
    const newer = {
      id: "notes",
      resources: { vectorize: [{ name: "VECTORS", preset: "@cf/new-model" }] },
    };
    expect(validateManifest(newer).resources?.vectorize).toEqual(
      newer.resources.vectorize,
    );
  });

  it("is refused on the dispatch tier", () => {
    const manifest = { resources: { vectorize: [sized] } };
    expect(manifestTierProblems(manifest, "service_binding")).toEqual([]);
    expect(manifestTierProblems(manifest, "dispatch")).toEqual([
      "resources.vectorize: Vectorize indexes aren't available to apps in a dispatch namespace yet",
    ]);
  });

  it("names an index <worker>--<binding>, in Cloudflare's characters, within 64", () => {
    expect(vectorizeNameFor("every-acme-notes", "VECTORS")).toBe(
      "every-acme-notes--vectors",
    );
    expect(vectorizeNameFor("every-acme-notes", "DOC_CHUNKS")).toBe(
      "every-acme-notes--doc-chunks",
    );
    // Never the Worker's own name, unlike DB, KV and R2.
    expect(vectorizeNameFor("every-acme-notes", "DB")).toBe(
      "every-acme-notes--db",
    );
    expect(vectorizeNameFor("every-acme-notes", "Doc_Chunks_2")).toMatch(
      /^[a-z][a-z0-9-]*$/,
    );
    expect(MAX_VECTORIZE_NAME_LENGTH).toBe(64);
  });
});

describe("Queues (resources.queues)", () => {
  const crawl = {
    id: "crawl",
    resources: {
      queues: [
        { name: "EMAILS" },
        { name: "JOBS", consumer: true as const },
        {
          name: "CRAWLS",
          consumer: {
            worker: "crawler",
            maxBatchSize: 5,
            maxBatchTimeout: 2,
            maxRetries: 4,
            maxConcurrency: null,
            retryDelay: 30,
            visibilityTimeoutMs: 1000,
            deadLetterQueue: "FAILED_CRAWLS",
          },
        },
        { name: "FAILED_CRAWLS", consumer: { maxConcurrency: 2 } },
      ],
    },
    workers: [{ name: "crawler" }],
  };

  it("accepts producers, a consumer on the app's Worker and one on a helper with a dead-letter queue", () => {
    expect(validateManifestStrict(crawl)).toEqual(crawl);
    expect(validateManifest(crawl)).toEqual(crawl);
  });

  it.each([
    [
      "a consumer helper workers doesn't declare",
      {
        resources: {
          queues: [{ name: "JOBS", consumer: { worker: "ghost" } }],
        },
      },
      'Invalid everyapp.config: Queue JOBS is consumed by Worker "ghost", which workers doesn\'t declare.',
    ],
    [
      "a dead-letter queue resources.queues doesn't declare",
      {
        resources: {
          queues: [
            {
              name: "JOBS",
              consumer: { deadLetterQueue: "every-acme-other--dlq" },
            },
          ],
        },
      },
      "Invalid everyapp.config: Queue JOBS's deadLetterQueue \"every-acme-other--dlq\" isn't one of resources.queues; declare it there and name its binding.",
    ],
    [
      "a queue that is its own dead-letter queue",
      {
        resources: {
          queues: [{ name: "JOBS", consumer: { deadLetterQueue: "JOBS" } }],
        },
      },
      "Invalid everyapp.config: Queue JOBS can't be its own dead-letter queue; name another of resources.queues.",
    ],
    [
      "a queue binding that isn't an identifier",
      { resources: { queues: [{ name: "job-queue" }] } },
      /resources\.queues\.0\.name: binding names must be JavaScript identifiers/,
    ],
    [
      "a queue binding ending in _",
      { resources: { queues: [{ name: "JOBS_" }] } },
      /resources\.queues\.0\.name: a queue's binding can't end with _/,
    ],
    [
      "a queue binding named like a D1 database",
      { resources: { d1: ["JOBS"], queues: [{ name: "JOBS" }] } },
      /the binding JOBS is declared twice/,
    ],
    [
      "consumer: false",
      { resources: { queues: [{ name: "JOBS", consumer: false }] } },
      /resources\.queues\.0\.consumer/,
    ],
    [
      "a setting Cloudflare doesn't have",
      { resources: { queues: [{ name: "JOBS", consumer: { batchSize: 5 } }] } },
      /Unrecognized key: "batchSize"/,
    ],
    [
      "a batch of no messages",
      {
        resources: {
          queues: [{ name: "JOBS", consumer: { maxBatchSize: 0 } }],
        },
      },
      /resources\.queues\.0\.consumer/,
    ],
    [
      "an unknown key on a queue",
      { resources: { queues: [{ name: "JOBS", deliveryDelay: 5 }] } },
      /Unrecognized key: "deliveryDelay"/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...crawl, ...change })).toThrow(
      problem,
    );
  });

  it("keeps a secret off a queue's binding name", () => {
    expect(() =>
      validateManifestStrict({ ...crawl, secrets: ["JOBS"] }),
    ).toThrow("secrets: JOBS is one of the app's bindings");
  });

  it("names each queue after the app's Worker, within Cloudflare's rule", () => {
    expect(queueNameFor("every-acme-crawl", "FAILED_CRAWLS")).toBe(
      "every-acme-crawl--failed-crawls",
    );
    expect(MAX_QUEUE_NAME_LENGTH).toBe(63);
    expect(isValidQueueName(`every-acme--${"q".repeat(51)}`)).toBe(true);
    expect(isValidQueueName(`every-acme--${"q".repeat(52)}`)).toBe(false);
    expect(isValidQueueName("every-acme-crawl--jobs-")).toBe(false);
    expect(isValidQueueName("every-acme-crawl--JOBS")).toBe(false);
  });

  it("refuses Queues on the dispatch tier", () => {
    expect(manifestTierProblems(crawl, "service_binding")).toEqual([]);
    expect(manifestTierProblems(crawl, "dispatch")).toEqual([
      "resources.queues: Queues aren't available to apps in a dispatch namespace yet",
    ]);
  });
});

describe("email.inbound manifest field", () => {
  const inbox = { id: "agentic-inbox", email: { inbound: true } };

  it("accepts the declaration in both schemas", () => {
    expect(validateManifestStrict(inbox).email).toEqual({ inbound: true });
    expect(
      validateManifestStrict({ id: "inbox", email: { inbound: false } }).email,
    ).toEqual({ inbound: false });
    expect(validateManifestStrict({ id: "inbox", email: {} }).email).toEqual(
      {},
    );
    expect(
      validateManifest({ id: "inbox", email: { inbound: true, later: 1 } })
        .email,
    ).toEqual({ inbound: true, later: 1 });
  });

  it.each([
    ["an address list", ["*@example.com"]],
    ["a string", "yes"],
  ])("refuses %s, naming the command", (_case, inbound) => {
    expect(() =>
      validateManifestStrict({ id: "inbox", email: { inbound } }),
    ).toThrow(
      /email\.inbound: inbound is true .* `everyapp email set --inbound <address>`/,
    );
  });

  it("reads an old row's address list as undeclared at registration", () => {
    const email = validateManifest({
      id: "inbox",
      email: { inbound: ["*@example.com"], later: 1 },
    }).email;
    expect(email?.inbound).toBeUndefined();
    expect(email).toEqual({ inbound: undefined, later: 1 });
  });

  it("refuses unknown email keys when authored", () => {
    expect(() =>
      validateManifestStrict({ id: "inbox", email: { outbound: [] } }),
    ).toThrow(/email/);
  });

  it("refuses inbound mail on the dispatch tier", () => {
    expect(manifestTierProblems(inbox, "service_binding")).toEqual([]);
    expect(manifestTierProblems(inbox, "dispatch")).toEqual([
      DISPATCH_INBOUND_PROBLEM,
    ]);
    expect(
      manifestTierProblems({ email: { inbound: false } }, "dispatch"),
    ).toEqual([]);
    // An old row's address list is not a declaration.
    expect(
      manifestTierProblems(
        {
          email: validateManifest({
            id: "x",
            email: { inbound: ["a@b.example"] },
          }).email,
        },
        "dispatch",
      ),
    ).toEqual([]);
  });
});

describe("what a problem reads as", () => {
  // The CLI ships this schema under its own zod (its tsup inlines the
  // perimeter but leaves zod external), so the messages are pinned here
  // under the major both declare. A record's key is checked in the
  // record's refinement, not by a key schema: zod 4 would report that as
  // `Invalid key in record` and stop at the first one.
  const problem = (validate: (input: unknown) => unknown, input: unknown) => {
    try {
      validate(input);
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestError);
      return (error as Error).message;
    }
    throw new Error("accepted");
  };
  const both = [
    ["validateManifest", validateManifest, "Invalid manifest: "],
    [
      "validateManifestStrict",
      validateManifestStrict,
      "Invalid everyapp.config: ",
    ],
  ] as const;

  it.each(both)(
    "%s reads a malformed capability id as the provider-name rule, at its path",
    (_name, validate, prefix) => {
      const message = problem(validate, {
        id: "a",
        capabilities: { OpenAI: { access: "read", why: "x" } },
      });
      expect(message).toBe(
        `${prefix}capabilities.OpenAI: provider must start with a lowercase letter and contain only lowercase letters, digits, and hyphens`,
      );
      expect(message).not.toMatch(/Invalid key in record/);
      expect(message).not.toMatch(/OpenAI\.OpenAI/);
    },
  );

  it.each(both)(
    "%s reads a malformed scope id as `invalid scope id` and `*` as reserved",
    (_name, validate, prefix) => {
      expect(problem(validate, { id: "a", scopes: { "Bad Id": "x" } })).toBe(
        `${prefix}scopes.Bad Id: invalid scope id`,
      );
      expect(problem(validate, { id: "a", scopes: { "*": "x" } })).toBe(
        `${prefix}scopes.*: reserved scope id`,
      );
      expect(
        problem(validate, { id: "a", scopes: { "provider:openai": "x" } }),
      ).toBe(`${prefix}scopes.provider:openai: reserved scope id`);
    },
  );

  it("reports a malformed id and its siblings' problems in one pass", () => {
    const message = problem(validateManifestStrict, {
      id: "a",
      capabilities: {
        OpenAI: { access: "read" },
        members: { access: "read", scopes: ["x"] },
        email: { access: "write", retired: true },
      },
    });
    expect(message).toBe(
      "Invalid everyapp.config: " +
        [
          "capabilities.OpenAI: provider must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
          "capabilities.members.scopes: Members takes no scopes; list it as { access: ..., why }",
          'capabilities.email: Unrecognized key: "retired"',
        ].join("; "),
    );
    // Likewise a scope whose value is wrong beside a key that is.
    expect(
      problem(validateManifestStrict, {
        id: "a",
        scopes: { "Bad Id": "x", "*": "y", ok: "" },
      }),
    ).toBe(
      "Invalid everyapp.config: scopes.ok: Too small: expected string to have >=1 characters; scopes.Bad Id: invalid scope id; scopes.*: reserved scope id",
    );
    // At registration a sibling's wrong access level doesn't hide the id.
    expect(
      problem(validateManifest, {
        id: "a",
        capabilities: {
          OpenAI: { access: "read" },
          dataforseo: { access: "nope" },
        },
      }),
    ).toBe(
      'Invalid manifest: capabilities.dataforseo.access: Invalid option: expected one of "read"|"write"; capabilities.OpenAI: provider must start with a lowercase letter and contain only lowercase letters, digits, and hyphens',
    );
  });

  it.each(both)(
    "%s reads a non-object as a (root) problem",
    (_name, validate, prefix) => {
      expect(problem(validate, "todo")).toBe(
        `${prefix}(root): Invalid input: expected object, received string`,
      );
      expect(problem(validate, null)).toMatch(/^.*\(root\): Invalid input/);
      expect(problem(validate, { id: "a", scopes: "x" })).toBe(
        `${prefix}scopes: Invalid input: expected record, received string`,
      );
    },
  );

  it("names the command for an inbound address list (the message zod 4 reads from `error`)", () => {
    expect(
      problem(validateManifestStrict, {
        id: "a",
        email: { inbound: ["*@example.com"] },
      }),
    ).toBe(
      "Invalid everyapp.config: email.inbound: inbound is true (the Worker exports an email() handler) or left out; the addresses moved out of the manifest: set them with `everyapp email set --inbound <address>` in the app's directory after its first deploy",
    );
  });

  it("stores a docs URL trimmed (zod 4's url check trims; zod 3 refused the padding)", () => {
    expect(
      validateManifestStrict({
        id: "a",
        secrets: [{ name: "TOKEN", docs: "  https://example.com/docs  " }],
      }).secrets,
    ).toEqual([{ name: "TOKEN", docs: "https://example.com/docs" }]);
  });
});

describe("Browser Rendering (resources.browser)", () => {
  const crawler = {
    id: "crawler",
    resources: { d1: ["DB"], browser: ["BROWSER"] },
  };

  it("accepts Browser Rendering bindings in both schemas", () => {
    expect(validateManifestStrict(crawler)).toEqual(crawler);
    expect(validateManifest(crawler)).toEqual(crawler);
    const two = { ...crawler, resources: { browser: ["BROWSER", "PDF"] } };
    expect(validateManifestStrict(two)).toEqual(two);
  });

  it.each([
    [
      "a binding that isn't an identifier",
      { resources: { browser: ["my-browser"] } },
      /resources\.browser\.0/,
    ],
    [
      "a binding named like a D1 database",
      { resources: { d1: ["BROWSER"], browser: ["BROWSER"] } },
      /the binding BROWSER is declared twice/,
    ],
    [
      "the same binding twice",
      { resources: { browser: ["BROWSER", "BROWSER"] } },
      /the binding BROWSER is declared twice/,
    ],
    [
      "a secret named like the binding",
      { resources: { browser: ["BROWSER"] }, secrets: ["BROWSER"] },
      /secrets: BROWSER is one of the app's bindings/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...crawler, ...change })).toThrow(
      problem,
    );
  });

  it("stays tolerant of entries at registration", () => {
    expect(
      validateManifest({
        id: "crawler",
        resources: { browser: ["my-browser"] },
      }).resources?.browser,
    ).toEqual(["my-browser"]);
  });

  it("is refused on the dispatch tier, where it would bill the platform's account", () => {
    expect(manifestTierProblems(crawler, "dispatch")).toEqual([
      "resources.browser: Browser Rendering isn't available to apps in a dispatch namespace (it bills the platform's account)",
    ]);
    expect(manifestTierProblems(crawler, "service_binding")).toEqual([]);
    expect(
      manifestTierProblems({ resources: { browser: [] } }, "dispatch"),
    ).toEqual([]);
  });
});

describe("Images (resources.images)", () => {
  const gallery = {
    id: "gallery",
    resources: { d1: ["DB"], images: ["IMAGES"] },
  };

  it("accepts Images bindings in both schemas", () => {
    expect(validateManifestStrict(gallery)).toEqual(gallery);
    expect(validateManifest(gallery)).toEqual(gallery);
    const two = { ...gallery, resources: { images: ["IMAGES", "THUMBS"] } };
    expect(validateManifestStrict(two)).toEqual(two);
  });

  it.each([
    [
      "a binding that isn't an identifier",
      { resources: { images: ["my-images"] } },
      /resources\.images\.0/,
    ],
    [
      "a binding named like a D1 database",
      { resources: { d1: ["IMAGES"], images: ["IMAGES"] } },
      /the binding IMAGES is declared twice/,
    ],
    [
      "the same binding twice",
      { resources: { images: ["IMAGES", "IMAGES"] } },
      /the binding IMAGES is declared twice/,
    ],
    [
      "a secret named like the binding",
      { resources: { images: ["IMAGES"] }, secrets: ["IMAGES"] },
      /secrets: IMAGES is one of the app's bindings/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...gallery, ...change })).toThrow(
      problem,
    );
  });

  it("stays tolerant of entries at registration", () => {
    expect(
      validateManifest({
        id: "gallery",
        resources: { images: ["my-images"] },
      }).resources?.images,
    ).toEqual(["my-images"]);
  });

  it("is refused on the dispatch tier, where it would bill the platform's account", () => {
    expect(manifestTierProblems(gallery, "dispatch")).toEqual([
      "resources.images: the Images binding isn't available to apps in a dispatch namespace (it bills the platform's account)",
    ]);
    expect(manifestTierProblems(gallery, "service_binding")).toEqual([]);
    expect(
      manifestTierProblems({ resources: { images: [] } }, "dispatch"),
    ).toEqual([]);
  });
});

describe("AI Gateways (resources.aiGateway)", () => {
  const notes = {
    id: "notes",
    resources: {
      aiGateway: [
        { name: "AI_GATEWAY" },
        { name: "SUMMARIES", collectLogs: false, cacheTtl: 3600 },
      ],
    },
  };

  it("accepts gateways with their settings in both schemas", () => {
    expect(validateManifestStrict(notes)).toEqual(notes);
    expect(validateManifest(notes)).toEqual(notes);
  });

  it("names a gateway <worker>-<binding>, one hyphen, since an id can't hold --", () => {
    expect(aiGatewayIdFor("every-acme-notes", "AI_GATEWAY")).toBe(
      "every-acme-notes-ai-gateway",
    );
    expect(aiGatewayIdFor("every-notes", "SUMMARIES")).toBe(
      "every-notes-summaries",
    );
    expect(isAiGatewayId("every-acme-notes-ai-gateway")).toBe(true);
  });

  it.each([
    ["two hyphens in a row", "every-acme-notes--ai"],
    ["an underscore", "every_acme"],
    ["an uppercase letter", "Every-acme"],
    ["a trailing hyphen", "every-acme-"],
    ["65 characters", "a".repeat(65)],
  ])("knows Cloudflare refuses an id with %s", (_case, id) => {
    expect(isAiGatewayId(id)).toBe(false);
  });

  it("accepts an id of exactly 64 characters", () => {
    expect(isAiGatewayId("a".repeat(64))).toBe(true);
  });

  it.each([
    [
      "a binding with a leading underscore (the id would hold --)",
      { aiGateway: [{ name: "_GATEWAY" }] },
      /resources\.aiGateway\.0\.name: an AI Gateway's binding is letters and digits joined by single underscores/,
    ],
    [
      "a binding with two underscores in a row",
      { aiGateway: [{ name: "AI__GATEWAY" }] },
      /resources\.aiGateway\.0\.name/,
    ],
    [
      "a binding with a trailing underscore",
      { aiGateway: [{ name: "GATEWAY_" }] },
      /resources\.aiGateway\.0\.name/,
    ],
    [
      "a binding that isn't an identifier",
      { aiGateway: [{ name: "ai-gateway" }] },
      /resources\.aiGateway\.0\.name/,
    ],
    [
      "a negative cache TTL",
      { aiGateway: [{ name: "AI_GATEWAY", cacheTtl: -1 }] },
      /resources\.aiGateway\.0\.cacheTtl/,
    ],
    [
      "a fractional cache TTL",
      { aiGateway: [{ name: "AI_GATEWAY", cacheTtl: 1.5 }] },
      /resources\.aiGateway\.0\.cacheTtl/,
    ],
    [
      "a setting the kind doesn't have",
      { aiGateway: [{ name: "AI_GATEWAY", authentication: true }] },
      /Unrecognized key/,
    ],
    [
      "a gateway named like a D1 database",
      { d1: ["DB"], aiGateway: [{ name: "DB" }] },
      /the binding DB is declared twice/,
    ],
  ])("refuses %s", (_case, resources, problem) => {
    expect(() => validateManifestStrict({ id: "notes", resources })).toThrow(
      problem,
    );
  });

  it("refuses a binding whose id could pass 64 characters with the longest org key", () => {
    // every-<12-char org key>-<id>-<suffix>: 20 characters before the id.
    const id = "a".repeat(30);
    const fits = { id, resources: { aiGateway: [{ name: "G".repeat(14) }] } };
    expect(validateManifestStrict(fits)).toEqual(fits);
    expect(() =>
      validateManifestStrict({
        id,
        resources: { aiGateway: [{ name: "G".repeat(15) }] },
      }),
    ).toThrow(
      `resources.aiGateway: ${"G".repeat(15)} would make an AI Gateway id of up to 65 characters (every-<orgKey>-${id}-${"g".repeat(15)}), longer than Cloudflare's 64; shorten the binding name.`,
    );
  });

  it("counts a gateway's binding among the app's, so no secret takes it", () => {
    expect(bindingNamesOf(notes).has("AI_GATEWAY")).toBe(true);
    expect(() =>
      validateManifestStrict({ ...notes, secrets: ["AI_GATEWAY"] }),
    ).toThrow(/secrets: AI_GATEWAY is one of the app's bindings/);
  });

  it("is refused on the dispatch tier only", () => {
    expect(manifestTierProblems(notes, "service_binding")).toEqual([]);
    expect(manifestTierProblems(notes, "dispatch")).toEqual([
      "resources.aiGateway: AI Gateways aren't available to apps in a dispatch namespace yet",
    ]);
  });

  it("doesn't refuse a gateway setting it doesn't know at registration", () => {
    expect(
      validateManifest({
        id: "notes",
        resources: { aiGateway: [{ name: "AI_GATEWAY", guardrails: true }] },
      }).resources?.aiGateway,
    ).toEqual([{ name: "AI_GATEWAY" }]);
  });
});
