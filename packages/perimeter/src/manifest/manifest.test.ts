import { CATALOG, withOAuthPresets } from "@every-app/sdk/internal";
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
  analyticsDatasetFor,
  artifactsNamespaceFor,
  isArtifactsNamespace,
  MAX_ARTIFACTS_NAMESPACE_LENGTH,
  storeSecretNameFor,
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

/** A Gateway's registry with every OAuth preset registered, as deploying an app that lists one leaves it. */
const PRESETS = { capabilities: withOAuthPresets(CATALOG) };

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

  it("accepts resources and public routes", () => {
    const m = validateManifest({
      id: "todo-app",
      name: "Todos",
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
      expect(() => validateManifestStrict({ id: "todo", providers })).toThrow(
        ManifestError,
      );
    }
  });

  it("treats an omitted provider allowlist as no proxy access", () => {
    expect(validateManifest({ id: "todo" }).providers).toBeUndefined();
  });

  it("has no top-level scopes field: strict refuses the key, the gateway drops it", () => {
    // Personal access tokens take whatever scopes a person types, and the
    // perimeter admits only `*` to app routes, so a manifest declares none.
    expect(() =>
      validateManifestStrict({ id: "todo", scopes: { "mcp:read": "Read" } }),
    ).toThrow(/scopes/);
    // The tolerant path reads stored rows and refuses nothing for a key it
    // doesn't know; it validates nothing about it either.
    expect(() =>
      validateManifest({ id: "todo", scopes: { "*": "Everything" } }),
    ).not.toThrow();
  });

  it("rejects malformed compatibility dates", () => {
    expect(() =>
      validateManifestStrict({ id: "todo", compatibilityDate: "2026/06/01" }),
    ).toThrow(ManifestError);
  });

  it("rejects non-kebab ids", () => {
    expect(() => validateManifestStrict({ id: "Todo_App" })).toThrow(
      ManifestError,
    );
    expect(() => validateManifestStrict({ id: "-todo" })).toThrow(
      ManifestError,
    );
    expect(() => validateManifestStrict({ id: "todo-" })).toThrow(
      ManifestError,
    );
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

describe("access and ai manifest fields", () => {
  it("accepts them in both the tolerant and strict schemas", () => {
    const input = {
      id: "chef",
      access: "everyone",
      ai: { models: ["gpt-5.2"], routes: ["/v1/files"] },
    };
    expect(validateManifest(input)).toMatchObject(input);
    expect(validateManifestStrict(input)).toMatchObject(input);
  });

  it("rejects unknown access levels and non-API AI routes", () => {
    expect(() => validateManifestStrict({ id: "a", access: "public" })).toThrow(
      ManifestError,
    );
    expect(() =>
      validateManifestStrict({ id: "a", ai: { routes: ["/v1/../admin"] } }),
    ).toThrow(ManifestError);
    expect(() =>
      validateManifestStrict({ id: "a", ai: { routez: ["/v1/files"] } }),
    ).toThrow(ManifestError);
  });
});

describe("public routes the perimeter keeps private", () => {
  it("refuses a public route over the server-function endpoint", () => {
    for (const path of ["/_serverFn/**", "/_serverFn/*", "/:any/*"]) {
      expect(() =>
        validateManifestStrict({
          id: "todo",
          public: [{ path, methods: ["POST"] }],
        }),
      ).toThrow("it covers /_serverFn");
    }
    // Public pages and their own data routes stay allowed.
    expect(() =>
      validateManifestStrict({
        id: "todo",
        public: [
          { path: "/share/**" },
          { path: "/:locale/share/**" },
          { path: "/api/public/share/**" },
        ],
      }),
    ).not.toThrow();
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

describe("fields that are gone", () => {
  it("refuses main, devPort, serverFnGuard, serverFnBase and mcp when the manifest is authored", () => {
    for (const field of [
      { main: "src/entry.worker.ts" },
      { devPort: 5173 },
      { serverFnGuard: false },
      { serverFnBase: "/app/_serverFn" },
      { mcp: { by: "gateway", why: "Scripts drive this app alone." } },
    ]) {
      expect(() => validateManifestStrict({ id: "todo", ...field })).toThrow(
        ManifestError,
      );
    }
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

  it("accepts an OAuth provider with the provider's own scopes and why", () => {
    const capabilities = {
      "google-workspace": {
        scopes: ["gmail.modify", "gmail.send"],
        why: "Mirrors your Gmail and sends when you press Send.",
      },
      "microsoft-365": {
        scopes: ["Mail.Read", "https://graph.microsoft.com/Calendars.Read"],
        why: "Reads each member's own mailbox and calendar.",
      },
      slack: {
        scopes: ["channels:read", "chat:write"],
        why: "Posts to the team's channels.",
      },
    };
    expect(
      validateManifestStrict({ id: "mail", capabilities }, PRESETS)
        .capabilities,
    ).toEqual(capabilities);
    expectTypeOf<CapabilityRequest["scopes"]>().toEqualTypeOf<
      string[] | undefined
    >();
  });

  it("accepts an OAuth provider with no scopes, and up to forty", () => {
    const empty = { slack: { scopes: [], why: "Names the workspace." } };
    expect(
      validateManifestStrict({ id: "hello", capabilities: empty }, PRESETS)
        .capabilities,
    ).toEqual(empty);
    const forty = Array.from({ length: 40 }, (_, n) => `scope.${n}`);
    expect(() =>
      validateManifestStrict(
        {
          id: "hello",
          capabilities: { slack: { scopes: forty, why: "Everything." } },
        },
        PRESETS,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "an unknown capability",
      { nope: { access: "read" } },
      /capabilities\.nope: unknown capability \(the gateway offers: dataforseo, context, email, members, stripe, .*, newsapi, google-workspace, microsoft-365, slack, .*, spotify\)/,
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
      "background on an API-key provider",
      { dataforseo: { access: "read", background: true } },
      /capabilities\.dataforseo: Unrecognized key: "background"/,
    ],
    [
      "redirect paths on an API-key provider",
      { dataforseo: { access: "read", redirectPaths: ["/callback"] } },
      /capabilities\.dataforseo: Unrecognized key: "redirectPaths"/,
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
      "scopes on an API-key provider",
      { dataforseo: { access: "read", scopes: ["identity"] } },
      "capabilities.dataforseo.scopes: DataForSEO takes no scopes; list it as { access, why }",
    ],
    [
      "scopes on a gateway service",
      { email: { access: "write", scopes: ["identity"] } },
      /capabilities\.email\.scopes: Email takes no scopes/,
    ],
    [
      "access on an OAuth provider",
      {
        "google-workspace": {
          access: "read",
          scopes: ["gmail.modify"],
          why: "Reads mail.",
        },
      },
      "capabilities.google-workspace.access: OAuth providers take no access: the scopes are the grant. Remove access.",
    ],
    [
      "background on an OAuth provider",
      {
        "google-workspace": {
          scopes: ["gmail.modify"],
          background: { scopes: ["gmail.modify"], why: "Syncs mail." },
          why: "Reads mail.",
        },
      },
      "capabilities.google-workspace.background: background is gone: an app may use a connection made in it at any time. Remove it.",
    ],
    [
      "optionalScopes on an OAuth provider",
      {
        "google-workspace": {
          scopes: ["gmail.modify"],
          optionalScopes: ["gmail.send"],
          why: "Reads mail.",
        },
      },
      "capabilities.google-workspace.optionalScopes: optionalScopes is gone: list every scope under scopes.",
    ],
    [
      "redirect paths on an OAuth provider",
      {
        slack: {
          scopes: ["chat:write"],
          redirectPaths: ["/integrations/slack/callback"],
          why: "Posts.",
        },
      },
      "capabilities.slack.redirectPaths: redirectPaths is gone: the Gateway runs the flow; send people to connectUrl().",
    ],
    [
      "an OAuth provider without scopes",
      { "google-workspace": { why: "Reads mail." } },
      /capabilities\.google-workspace\.scopes: Google needs scopes: the provider's own scopes this app uses/,
    ],
    [
      "scopes that aren't a list",
      { "microsoft-365": { scopes: "Mail.Read", why: "Reads mail." } },
      /capabilities\.microsoft-365\.scopes: Microsoft 365 needs scopes/,
    ],
    [
      "an OAuth provider without why",
      { "google-workspace": { scopes: ["gmail.modify"] } },
      /capabilities\.google-workspace\.why: Google needs why/,
    ],
    [
      "an OAuth provider with an empty why",
      { "google-workspace": { scopes: ["gmail.modify"], why: "" } },
      /capabilities\.google-workspace\.why: Google needs why/,
    ],
    [
      "a scope listed twice",
      {
        "google-workspace": {
          scopes: ["gmail.modify", "gmail.send", "gmail.modify"],
          why: "Reads mail.",
        },
      },
      /capabilities\.google-workspace\.scopes: a scope is listed twice/,
    ],
    [
      "a scope listed twice in two spellings",
      {
        "google-workspace": {
          scopes: [
            "gmail.modify",
            "https://www.googleapis.com/auth/gmail.modify",
          ],
          why: "Reads mail.",
        },
      },
      /capabilities\.google-workspace\.scopes: a scope is listed twice/,
    ],
    [
      "a scope listed twice in two cases",
      {
        "microsoft-365": { scopes: ["Mail.Read", "mail.read"], why: "Mail." },
      },
      /capabilities\.microsoft-365\.scopes: a scope is listed twice/,
    ],
    [
      "two scopes in one string, space-separated",
      {
        "google-workspace": {
          scopes: ["gmail.modify gmail.send"],
          why: "Reads mail.",
        },
      },
      /capabilities\.google-workspace\.scopes\.0: one scope, with no space or comma/,
    ],
    [
      "two scopes in one string, comma-separated",
      { slack: { scopes: ["chat:write,channels:read"], why: "Posts." } },
      /capabilities\.slack\.scopes\.0: one scope, with no space or comma/,
    ],
    [
      "an empty scope",
      { slack: { scopes: [""], why: "Posts." } },
      /capabilities\.slack\.scopes\.0: a scope is 1 to 200 characters/,
    ],
    [
      "a scope over 200 characters",
      { slack: { scopes: ["x".repeat(201)], why: "Posts." } },
      /capabilities\.slack\.scopes\.0: a scope is 1 to 200 characters/,
    ],
    [
      "a scope with a control character",
      { slack: { scopes: ["chat:write\u0000"], why: "Posts." } },
      /capabilities\.slack\.scopes\.0: a scope holds no control characters/,
    ],
    [
      "more than forty scopes",
      {
        slack: {
          scopes: Array.from({ length: 41 }, (_, n) => `scope.${n}`),
          why: "Everything.",
        },
      },
      /capabilities\.slack\.scopes: scopes lists at most 40 scopes/,
    ],
  ])("refuses %s", (_case, capabilities, problem) => {
    expect(() =>
      validateManifestStrict({ id: "seo", capabilities }, PRESETS),
    ).toThrow(problem);
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
    // An OAuth entry has no access; scopes that aren't a list of strings
    // read as undeclared, so the app's calls are refused instead.
    expect(
      validateManifest({
        id: "crm",
        capabilities: {
          "google-workspace": { scopes: ["gmail.readonly"], why: "Mail." },
          "microsoft-365": { scopes: "Mail.Read", why: "Mail." },
          slack: { scopes: [1, 2] },
        },
      }).capabilities,
    ).toEqual({
      "google-workspace": { scopes: ["gmail.readonly"], why: "Mail." },
      "microsoft-365": { scopes: undefined, why: "Mail." },
      slack: { scopes: undefined },
    });
    // A row written before the change keeps its old keys as sent.
    expect(
      validateManifest({
        id: "mail",
        capabilities: {
          "google-workspace": {
            access: "read",
            scopes: ["gmail.read"],
            background: { scopes: ["gmail.read"], why: "Syncs." },
          },
        },
      }).capabilities,
    ).toEqual({
      "google-workspace": {
        access: "read",
        scopes: ["gmail.read"],
        background: { scopes: ["gmail.read"], why: "Syncs." },
      },
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
      "an API-key provider's key, whatever its case, naming the capability",
      ["dataforseo_api_key"],
      /secrets\.0: dataforseo_api_key is a Gateway setting, which `everyapp secret set DATAFORSEO_API_KEY` sets on the Gateway for every app; list `dataforseo` under capabilities instead/,
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

  it("reads a stored row's names as stored; the name rules are the strict schema's", () => {
    expect(
      validateManifest({
        id: "repolens",
        secrets: ["OPENAI_API_KEY", "GATEWAY_URL", "DB"],
      }).secrets,
    ).toEqual(["OPENAI_API_KEY", "GATEWAY_URL", "DB"]);
    expect(() =>
      validateManifestStrict({ id: "repolens", secrets: ["not a name"] }),
    ).toThrow(/secrets\.0: binding names must be JavaScript identifiers/);
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

describe("each setting's need (why, docs)", () => {
  it("accepts providers and secrets by id or as entries, in both schemas", () => {
    const manifest = {
      id: "inbox",
      providers: [
        { id: "workers-ai", why: "Runs the agent." },
        { id: "openrouter", docs: "https://openrouter.ai/settings/keys" },
        "openai",
      ],
      capabilities: {
        email: { access: "write", why: "Sends from mailboxes." },
        context: { access: "read" },
      },
      secrets: [
        "MAIN_SECRET",
        {
          name: "GITHUB_TOKEN",
          why: "Raises GitHub's rate limit.",
          docs: "https://github.com/settings/tokens",
          how: "Settings → Developer settings → Tokens, public_repo read",
        },
        { name: "SIGNING_KEY", generate: true },
      ],
    };
    expect(validateManifestStrict(manifest)).toEqual(manifest);
    expect(validateManifest(manifest)).toEqual(manifest);
  });

  it("refuses optional, anyOf and setup, which features replaced", () => {
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [{ name: "GITHUB_TOKEN", optional: true }],
      }),
    ).toThrow(/secrets\.0: Unrecognized key: "optional"/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [{ id: "openai", anyOf: "AI model" }],
      }),
    ).toThrow(/providers\.0: Unrecognized key: "anyOf"/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [{ name: "MAIN_SECRET", setup: "docs/setup/main-secret.md" }],
      }),
    ).toThrow(/secrets\.0: Unrecognized key: "setup"/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        capabilities: { context: { access: "read", optional: true } },
      }),
    ).toThrow(/capabilities\.context: Unrecognized key/);
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
        secrets: ["GITHUB_TOKEN", { name: "GITHUB_TOKEN", why: "x" }],
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
        secrets: [{ name: "DB", why: "x" }],
      }),
    ).toThrow(/secrets: DB is one of the app's bindings/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: ["openai", { id: "openai", why: "x" }],
      }),
    ).toThrow(/providers\.1: duplicate provider/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        providers: [{ id: "openai" }, "openai"],
      }),
    ).toThrow(/providers\.1: duplicate provider/);
  });

  it("refuses docs that aren't https, and a why or how that is empty or too long", () => {
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
        secrets: [{ name: "A", how: "x".repeat(201) }],
      }),
    ).toThrow(/secrets\.0\.how/);
    expect(() =>
      validateManifestStrict({
        id: "inbox",
        secrets: [{ name: "A", generate: true, file: true }],
      }),
    ).toThrow(
      /secrets\.0\.file: a generated secret isn't a file; drop generate or file/,
    );
  });

  it("counts a secret entry for the dispatch tier like a bare name", () => {
    expect(
      manifestTierProblems(
        { secrets: [{ name: "GITHUB_TOKEN", why: "x" }] },
        "dispatch",
      ),
    ).toEqual([
      "secrets: third-party apps can't have secrets of their own yet",
    ]);
  });
});

describe("features", () => {
  const GITHUB = {
    name: "GitHub",
    required: true,
    why: "Agents push branches and open pull requests through your GitHub App.",
    steps: [
      "Create a GitHub App: https://github.com/settings/apps/new",
      "Webhook URL: {appUrl}/github/webhooks. Permissions: Contents, Pull requests, Checks → Read and write.",
      "Sign-in back to [the Gateway]({gatewayUrl}).",
    ],
    settings: [
      { name: "GITHUB_APP_ID", how: "The App's General page → App ID" },
    ],
    secrets: [
      {
        name: "GITHUB_APP_PRIVATE_KEY",
        file: true,
        how: "General → Private keys → Generate; give the downloaded .pem",
      },
      {
        name: "GITHUB_WEBHOOK_SECRET",
        generate: true,
        how: "Paste this into the App's Webhook secret",
      },
    ],
    capabilities: ["slack"],
    providers: ["openrouter"],
  };
  const base = {
    id: "birds",
    secrets: [{ name: "BIRDS_SECRETS_KEY", generate: true }],
    providers: ["openrouter"],
    capabilities: {
      slack: { scopes: ["chat:write"], why: "Posts to Slack." },
      dataforseo: { access: "read" },
    },
  };
  const strictWith =
    (features: unknown, extra: Record<string, unknown> = {}) =>
    () =>
      validateManifestStrict({ ...base, ...extra, features }, PRESETS);

  it("accepts a feature with steps, settings, secrets and the capabilities it needs, in both schemas", () => {
    const manifest = { ...base, features: { github: GITHUB } };
    expect(validateManifestStrict(manifest, PRESETS)).toEqual(manifest);
    expect(validateManifest(manifest)).toEqual(manifest);
    // A feature with only a capability is a feature too.
    expect(
      strictWith({
        seo: {
          name: "SEO",
          why: "Keyword data.",
          capabilities: ["dataforseo"],
        },
      }),
    ).not.toThrow();
  });

  it("refuses a placeholder it doesn't fill, in steps and in how", () => {
    expect(
      strictWith({ github: { ...GITHUB, steps: ["Open {foo}/x"] } }),
    ).toThrow(
      /features\.github\.steps\.0: \{foo\} isn't a placeholder; use \{appUrl\} or \{gatewayUrl\}/,
    );
    expect(
      strictWith({
        github: {
          ...GITHUB,
          settings: [{ name: "GITHUB_APP_ID", how: "On {appurl}" }],
        },
      }),
    ).toThrow(
      /features\.github\.settings\.0\.how: \{appurl\} isn't a placeholder/,
    );
  });

  it("refuses a bad entry: generate with file, a how too long, an id that isn't a slug, no why", () => {
    expect(
      strictWith({
        github: {
          ...GITHUB,
          secrets: [{ name: "K", generate: true, file: true }],
        },
      }),
    ).toThrow(
      /features\.github\.secrets\.0\.file: a generated secret isn't a file/,
    );
    expect(
      strictWith({
        github: { ...GITHUB, secrets: [{ name: "K", how: "x".repeat(201) }] },
      }),
    ).toThrow(/features\.github\.secrets\.0\.how/);
    expect(strictWith({ GitHub: GITHUB })).toThrow(
      /features\.GitHub: a feature id is a lowercase slug/,
    );
    const { why: _why, ...withoutWhy } = GITHUB;
    expect(strictWith({ github: withoutWhy })).toThrow(/features\.github\.why/);
    expect(strictWith({ github: { ...GITHUB, optional: true } })).toThrow(
      /features\.github: Unrecognized key/,
    );
  });

  it("refuses a feature with nothing to set", () => {
    expect(strictWith({ empty: { name: "Empty", why: "Nothing." } })).toThrow(
      "Invalid everyapp.config: features.empty: lists nothing to set; give it secrets, settings, capabilities or providers, or drop it",
    );
  });

  it("refuses a capability or provider it needs that the manifest doesn't declare, or another feature lists", () => {
    expect(
      strictWith({ github: { ...GITHUB, capabilities: ["email"] } }),
    ).toThrow(
      "Invalid everyapp.config: features.github.capabilities: email isn't declared under capabilities; declare it there too",
    );
    expect(
      strictWith({ github: { ...GITHUB, providers: ["openai"] } }),
    ).toThrow(
      /features\.github\.providers: openai isn't declared under providers/,
    );
    expect(
      strictWith({
        github: GITHUB,
        chat: { name: "Chat", why: "Slack.", capabilities: ["slack"] },
      }),
    ).toThrow(
      /features\.chat\.capabilities: slack is in features\.github too; a capability belongs to one feature/,
    );
  });

  it("declares each name in one place: the top level or one feature", () => {
    expect(
      strictWith({ github: { ...GITHUB, secrets: ["BIRDS_SECRETS_KEY"] } }),
    ).toThrow(
      "Invalid everyapp.config: features.github.secrets: BIRDS_SECRETS_KEY is declared under secrets too; a name goes in one place: the top level or one feature",
    );
    expect(
      strictWith({
        github: GITHUB,
        merge: {
          name: "Merge",
          why: "Merges.",
          settings: [{ name: "GITHUB_APP_ID" }],
        },
      }),
    ).toThrow(
      /features\.merge\.settings: GITHUB_APP_ID is declared under features\.github\.settings too/,
    );
  });

  it("applies the top level's name rules to a feature's values", () => {
    expect(
      strictWith({ github: { ...GITHUB, secrets: ["OPENAI_API_KEY"] } }),
    ).toThrow(/features\.github\.secrets: OPENAI_API_KEY is a Gateway setting/);
    expect(
      strictWith(
        { github: { ...GITHUB, secrets: ["DB"] } },
        { resources: { d1: ["DB"] } },
      ),
    ).toThrow(/secrets: DB is one of the app's bindings/);
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

  it("reads a stored row's entries as stored", () => {
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
  const sized = { name: "VECTORS", dimensions: 768, metric: "cosine" as const };
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

  it("reads a stored row's entries a newer everyapp wrote", () => {
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

describe("Email sending bindings (resources.sendEmail)", () => {
  const SENDERS = { allowedSenderAddresses: ["noreply@example.com"] };
  const notifier = {
    id: "notifier",
    resources: {
      d1: ["DB"],
      sendEmail: [
        {
          name: "EMAIL",
          allowedSenderAddresses: ["noreply@example.com"],
          allowedDestinationAddresses: [
            "ops@example.com",
            "oncall@example.net",
          ],
        },
        {
          name: "ALERTS",
          allowedSenderAddresses: ["alerts@example.com"],
          destinationAddress: "ops@example.com",
        },
        { name: "ANYONE", allowedSenderAddresses: ["noreply@example.com"] },
      ],
    },
  };

  it("accepts bindings with their senders, with or without destinations, in both schemas", () => {
    expect(validateManifestStrict(notifier)).toEqual(notifier);
    expect(validateManifest(notifier)).toEqual(notifier);
  });

  it.each([
    [
      "a destination and a list of destinations together",
      [
        {
          name: "EMAIL",
          ...SENDERS,
          destinationAddress: "ops@example.com",
          allowedDestinationAddresses: ["ops@example.com"],
        },
      ],
      /resources\.sendEmail\.0\.allowedDestinationAddresses: destinationAddress and allowedDestinationAddresses can't both be set/,
    ],
    [
      "a sender that isn't an address",
      [{ name: "EMAIL", allowedSenderAddresses: ["*@example.com"] }],
      /resources\.sendEmail\.0\.allowedSenderAddresses\.0: must be an email address such as noreply@example\.com/,
    ],
    [
      "a destination that isn't an address",
      [{ name: "EMAIL", ...SENDERS, destinationAddress: "ops" }],
      /resources\.sendEmail\.0\.destinationAddress: must be an email address/,
    ],
    [
      "a destination in the list that isn't an address",
      [
        {
          name: "EMAIL",
          ...SENDERS,
          allowedDestinationAddresses: [
            "ops@example.com",
            "Ops <ops@example.com>",
          ],
        },
      ],
      /resources\.sendEmail\.0\.allowedDestinationAddresses\.1: must be an email address/,
    ],
    [
      "an entry without senders",
      [{ name: "EMAIL", destinationAddress: "ops@example.com" }],
      /resources\.sendEmail\.0\.allowedSenderAddresses: list the addresses the binding may send as: without allowedSenderAddresses it could send as any address on the account's Email Sending domains, the Gateway's own sender included/,
    ],
    [
      "an empty sender list",
      [{ name: "EMAIL", allowedSenderAddresses: [] }],
      /resources\.sendEmail\.0\.allowedSenderAddresses: list the addresses the binding may send as/,
    ],
    [
      "an empty destination list",
      [{ name: "EMAIL", ...SENDERS, allowedDestinationAddresses: [] }],
      /resources\.sendEmail\.0\.allowedDestinationAddresses: list at least one address, or leave the list out/,
    ],
    [
      "a binding that isn't an identifier",
      [{ name: "send-email", ...SENDERS }],
      /resources\.sendEmail\.0\.name: binding names must be JavaScript identifiers/,
    ],
    [
      "a key Cloudflare's binding doesn't have",
      [{ name: "EMAIL", ...SENDERS, remote: true }],
      /resources\.sendEmail\.0: Unrecognized key: "remote"/,
    ],
  ])("refuses %s", (_case, sendEmail, problem) => {
    expect(() =>
      validateManifestStrict({ id: "notifier", resources: { sendEmail } }),
    ).toThrow(problem);
  });

  it("counts the binding among the app's names: declared twice, or taken by a secret", () => {
    expect(() =>
      validateManifestStrict({
        id: "notifier",
        resources: {
          kv: ["EMAIL"],
          sendEmail: [{ name: "EMAIL", ...SENDERS }],
        },
      }),
    ).toThrow(/the binding EMAIL is declared twice in resources/);
    expect(() =>
      validateManifestStrict({
        id: "notifier",
        resources: { sendEmail: [{ name: "EMAIL", ...SENDERS }] },
        secrets: ["EMAIL"],
      }),
    ).toThrow(/secrets: EMAIL is one of the app's bindings/);
  });

  it("reads a stored row's lists as stored, the value rules left to the strict schema", () => {
    const loose = {
      id: "notifier",
      resources: {
        sendEmail: [
          {
            name: "send-email",
            allowedSenderAddresses: [],
            destinationAddress: "ops",
            allowedDestinationAddresses: [],
          },
        ],
      },
    };
    expect(validateManifest(loose).resources?.sendEmail).toEqual(
      loose.resources.sendEmail,
    );
  });

  it("refuses the binding on the dispatch tier only", () => {
    expect(manifestTierProblems(notifier, "service_binding")).toEqual([]);
    expect(manifestTierProblems(notifier, "dispatch")).toEqual([
      "resources.sendEmail: Email sending bindings aren't available to apps in a dispatch namespace (they send through the Gateway's email capability)",
    ]);
  });
});

describe("Secrets Store secrets (resources.secretsStore)", () => {
  const shop = {
    id: "shop",
    resources: { d1: ["DB"], secretsStore: [{ name: "STRIPE_KEY" }] },
  };

  it("accepts Secrets Store secrets in both schemas", () => {
    expect(validateManifestStrict(shop)).toEqual(shop);
    expect(validateManifest(shop)).toEqual(shop);
  });

  it.each([
    [
      "a binding that isn't an identifier",
      { resources: { secretsStore: [{ name: "stripe-key" }] } },
      /resources\.secretsStore\.0\.name/,
    ],
    [
      "an entry with a field it doesn't know",
      { resources: { secretsStore: [{ name: "STRIPE_KEY", storeId: "s" }] } },
      /resources\.secretsStore\.0/,
    ],
    [
      "a binding named like a KV namespace",
      {
        resources: {
          kv: ["STRIPE_KEY"],
          secretsStore: [{ name: "STRIPE_KEY" }],
        },
      },
      /the binding STRIPE_KEY is declared twice/,
    ],
    [
      "the same binding twice",
      {
        resources: {
          secretsStore: [{ name: "STRIPE_KEY" }, { name: "STRIPE_KEY" }],
        },
      },
      /the binding STRIPE_KEY is declared twice/,
    ],
    [
      "an app secret named like the binding",
      {
        resources: { secretsStore: [{ name: "STRIPE_KEY" }] },
        secrets: ["STRIPE_KEY"],
      },
      /secrets: STRIPE_KEY is one of the app's bindings/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...shop, ...change })).toThrow(
      problem,
    );
  });

  it("reads a stored row's entries as stored", () => {
    expect(
      validateManifest({
        id: "shop",
        resources: { secretsStore: [{ name: "stripe-key", more: 1 }] },
      }).resources?.secretsStore,
    ).toEqual([{ name: "stripe-key", more: 1 }]);
  });

  it("names the secret after the app's Worker, as the teardown's every- scan finds it", () => {
    expect(storeSecretNameFor("every-acme-shop", "STRIPE_KEY")).toBe(
      "every-acme-shop--stripe-key",
    );
    // No binding takes the Worker's own name, unlike DB, KV and R2.
    expect(storeSecretNameFor("every-acme-shop", "DB")).toBe(
      "every-acme-shop--db",
    );
  });

  it("is refused on the dispatch tier, where the store is the platform account's", () => {
    expect(manifestTierProblems(shop, "dispatch")).toEqual([
      "resources.secretsStore: Secrets Store secrets aren't available to apps in a dispatch namespace (the store is the platform account's)",
    ]);
    expect(manifestTierProblems(shop, "service_binding")).toEqual([]);
    expect(
      manifestTierProblems({ resources: { secretsStore: [] } }, "dispatch"),
    ).toEqual([]);
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

  it("reads a stored row's address list from before 2026-10-19 as undeclared, so the row still routes", () => {
    expect(
      validateManifest({ id: "inbox", email: { inbound: ["*@example.com"] } })
        .email,
    ).toEqual({});
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

  it("reads a malformed capability id as the provider-name rule, at its path", () => {
    const message = problem(validateManifestStrict, {
      id: "a",
      capabilities: { OpenAI: { access: "read", why: "x" } },
    });
    expect(message).toBe(
      "Invalid everyapp.config: capabilities.OpenAI: provider must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
    );
    expect(message).not.toMatch(/Invalid key in record/);
    expect(message).not.toMatch(/OpenAI\.OpenAI/);
  });

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
          "capabilities.members.scopes: Members takes no scopes; list it as { access, why }",
          'capabilities.email: Unrecognized key: "retired"',
        ].join("; "),
    );
    // A stored row: a wrong access level is still refused.
    expect(
      problem(validateManifest, {
        id: "a",
        capabilities: { dataforseo: { access: "nope" } },
      }),
    ).toBe(
      'Invalid manifest: capabilities.dataforseo.access: Invalid option: expected one of "read"|"write"',
    );
  });

  it.each(both)(
    "%s reads a non-object as a (root) problem",
    (_name, validate, prefix) => {
      expect(problem(validate, "todo")).toBe(
        `${prefix}(root): Invalid input: expected object, received string`,
      );
      expect(problem(validate, null)).toMatch(/^.*\(root\): Invalid input/);
      expect(problem(validate, { id: "a", public: "x" })).toBe(
        `${prefix}public: Invalid input: expected array, received string`,
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

  it("reads a stored row's entries as stored", () => {
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

  it("reads a stored row's entries as stored", () => {
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

  it("reads a stored row's setting it doesn't know as stored", () => {
    expect(
      validateManifest({
        id: "notes",
        resources: { aiGateway: [{ name: "AI_GATEWAY", guardrails: true }] },
      }).resources?.aiGateway,
    ).toEqual([{ name: "AI_GATEWAY", guardrails: true }]);
  });
});

describe("Analytics Engine (resources.analyticsEngine)", () => {
  const shop = {
    id: "shop",
    resources: {
      d1: ["DB"],
      analyticsEngine: [
        { name: "EVENTS" },
        { name: "AUDIT", dataset: "audit_log" },
      ],
    },
  };

  it("accepts datasets by binding, named or not, in both schemas", () => {
    expect(validateManifestStrict(shop)).toEqual(shop);
    expect(validateManifest(shop)).toEqual(shop);
  });

  it("names a dataset after the Worker unless the manifest names one", () => {
    expect(analyticsDatasetFor("every-acme-shop", "EVENTS")).toBe(
      "every-acme-shop--events",
    );
    expect(analyticsDatasetFor("every-acme-shop", "PAGE_VIEWS")).toBe(
      "every-acme-shop--page-views",
    );
  });

  it.each([
    [
      "a binding that isn't an identifier",
      { resources: { analyticsEngine: [{ name: "page-views" }] } },
      /resources\.analyticsEngine\.0\.name/,
    ],
    [
      "a binding too long for the dataset named after the Worker",
      { resources: { analyticsEngine: [{ name: "E".repeat(64) }] } },
      /at most 63 characters, so the dataset named after the Worker fits Cloudflare's 128/,
    ],
    [
      "a dataset with a character Cloudflare refuses",
      { resources: { analyticsEngine: [{ name: "EVENTS", dataset: "a.b" }] } },
      /dataset names are letters, digits, dashes and underscores, at most 128 characters/,
    ],
    [
      "a dataset longer than Cloudflare's 128 characters",
      {
        resources: {
          analyticsEngine: [{ name: "EVENTS", dataset: "d".repeat(129) }],
        },
      },
      /at most 128 characters/,
    ],
    [
      "an unknown key",
      {
        resources: { analyticsEngine: [{ name: "EVENTS", retention: 90 }] },
      },
      /Unrecognized key/,
    ],
    [
      "a binding named like a KV namespace",
      { resources: { kv: ["EVENTS"], analyticsEngine: [{ name: "EVENTS" }] } },
      /the binding EVENTS is declared twice/,
    ],
    [
      "a secret named like the binding",
      {
        resources: { analyticsEngine: [{ name: "EVENTS" }] },
        secrets: ["EVENTS"],
      },
      /secrets: EVENTS is one of the app's bindings/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...shop, ...change })).toThrow(
      problem,
    );
  });

  it("reads a stored row's entries as stored", () => {
    expect(
      validateManifest({
        id: "shop",
        resources: { analyticsEngine: [{ name: "page-views", retention: 90 }] },
      }).resources?.analyticsEngine,
    ).toEqual([{ name: "page-views", retention: 90 }]);
  });

  it("is refused on the dispatch tier", () => {
    expect(manifestTierProblems(shop, "dispatch")).toEqual([
      "resources.analyticsEngine: Analytics Engine datasets aren't available to apps in a dispatch namespace (their names are account-wide and their writes bill the platform's account)",
    ]);
    expect(manifestTierProblems(shop, "service_binding")).toEqual([]);
    expect(
      manifestTierProblems({ resources: { analyticsEngine: [] } }, "dispatch"),
    ).toEqual([]);
  });
});

describe("Artifacts (resources.artifacts)", () => {
  const birds = {
    id: "birds",
    resources: {
      d1: ["DB"],
      artifacts: [{ name: "MEMORY" }, { name: "AGENT_FILES" }],
    },
  };

  it("accepts namespaces by binding in both schemas", () => {
    expect(validateManifestStrict(birds)).toEqual(birds);
    expect(validateManifest(birds)).toEqual(birds);
  });

  it("names a namespace after the Worker, with the binding lowercased and _ as -", () => {
    expect(artifactsNamespaceFor("every-acme-birds", "MEMORY")).toBe(
      "every-acme-birds--memory",
    );
    expect(artifactsNamespaceFor("every-acme-birds", "AGENT_FILES")).toBe(
      "every-acme-birds--agent-files",
    );
    // A named Gateway's app Worker already holds the separator.
    expect(artifactsNamespaceFor("every-demo--acme-birds", "MEMORY")).toBe(
      "every-demo--acme-birds--memory",
    );
  });

  it("takes only the namespace names Cloudflare's upload API takes", () => {
    expect(MAX_ARTIFACTS_NAMESPACE_LENGTH).toBe(63);
    expect(isArtifactsNamespace("every-acme-birds--memory")).toBe(true);
    expect(isArtifactsNamespace("a".repeat(63))).toBe(true);
    expect(isArtifactsNamespace("a".repeat(64))).toBe(false);
    expect(isArtifactsNamespace("a")).toBe(false);
    expect(isArtifactsNamespace("every-acme-birds--memory-")).toBe(false);
    expect(isArtifactsNamespace("-every")).toBe(false);
    expect(isArtifactsNamespace("every acme")).toBe(false);
  });

  it.each([
    [
      "a binding that isn't an identifier",
      { resources: { artifacts: [{ name: "agent-files" }] } },
      /resources\.artifacts\.0\.name/,
    ],
    [
      "a binding that ends with _ (the namespace would end with a hyphen)",
      { resources: { artifacts: [{ name: "MEMORY_" }] } },
      /an Artifacts binding can't end with _/,
    ],
    [
      "an unknown key",
      { resources: { artifacts: [{ name: "MEMORY", namespace: "shared" }] } },
      /Unrecognized key/,
    ],
    [
      "a binding named like a D1 database",
      { resources: { d1: ["MEMORY"], artifacts: [{ name: "MEMORY" }] } },
      /the binding MEMORY is declared twice/,
    ],
    [
      "a secret named like the binding",
      { resources: { artifacts: [{ name: "MEMORY" }] }, secrets: ["MEMORY"] },
      /secrets: MEMORY is one of the app's bindings/,
    ],
  ])("refuses %s", (_case, change, problem) => {
    expect(() => validateManifestStrict({ ...birds, ...change })).toThrow(
      problem,
    );
  });

  it("is one of the app's binding names", () => {
    expect(bindingNamesOf(birds)).toContain("AGENT_FILES");
  });

  it("is refused on the dispatch tier, not yet available there", () => {
    expect(manifestTierProblems(birds, "dispatch")).toEqual([
      "resources.artifacts: Artifacts isn't available to apps in a dispatch namespace yet (its repos would live in, and bill, the platform's account)",
    ]);
    expect(manifestTierProblems(birds, "service_binding")).toEqual([]);
    expect(
      manifestTierProblems({ resources: { artifacts: [] } }, "dispatch"),
    ).toEqual([]);
  });
});

describe("bearer routes (public entries with bearer: true)", () => {
  it("accepts globs with the public syntax, in both validators", () => {
    const input = {
      id: "open-zen",
      public: [
        { path: "/health" },
        { path: "/api/**", bearer: true as const },
        { path: "/upload/:id", bearer: true as const },
      ],
    };
    expect(validateManifest(input).public).toEqual(input.public);
    expect(validateManifestStrict(input).public).toEqual(input.public);
  });

  it("refuses methods on a bearer route: it answers every method", () => {
    const input = {
      id: "open-zen",
      public: [{ path: "/api/**", bearer: true as const, methods: ["GET"] }],
    };
    expect(() => validateManifest(input)).toThrow(/answers every method/);
    expect(() => validateManifestStrict(input)).toThrow(/answers every method/);
  });

  it.each([
    ["a catch-all", "/**", /exposes the entire app/],
    ["a relative path", "api/**", /must be absolute/],
    ["the internal namespace", "/__everyapp/**", /reserved/],
    ["/mcp itself", "/mcp", /can't be/],
    ["a pattern covering /mcp", "/:page", /covers \/mcp/],
  ])("refuses %s in both validators", (_what, path, message) => {
    const input = {
      id: "open-zen",
      public: [{ path, bearer: true as const }],
    };
    expect(() => validateManifest(input)).toThrow(message);
    expect(() => validateManifestStrict(input)).toThrow(message);
  });

  it("refuses a path that is also open to anyone, or a public asset", () => {
    for (const input of [
      {
        id: "open-zen",
        public: [
          { path: "/api/**" },
          { path: "/api/**", bearer: true as const },
        ],
      },
      {
        id: "open-zen",
        publicAssets: ["/api/**"],
        public: [{ path: "/api/**", bearer: true as const }],
      },
    ]) {
      expect(() => validateManifest(input)).toThrow(/both a bearer route/);
      expect(() => validateManifestStrict(input)).toThrow(
        /both a bearer route/,
      );
    }
  });
});

describe("events (the app event sink)", () => {
  const why = "Stops a leaver's Agents at once.";

  it("accepts the families an app may read", () => {
    const manifest = validateManifestStrict({
      id: "birds",
      events: {
        subscribe: [
          "member.removed",
          "member.*",
          "group.*",
          "app.tools_changed",
          "app.crm.*",
          "mcp_app.*",
          "connection.revoked",
          "tool.*",
        ],
        why,
      },
    });
    expect(manifest.events?.subscribe).toHaveLength(8);
  });

  it("refuses at deploy every family outside the allowlist", () => {
    for (const pattern of [
      "*",
      "token.*",
      "token.created",
      "subscription.*",
      "provider.*",
      "signin_provider.added",
      "cap.reached",
      "ai.*",
      "access.changed",
      "organization.*",
      "member.password_reset",
      "nope.*",
    ]) {
      expect(
        () =>
          validateManifestStrict({
            id: "birds",
            events: { subscribe: [pattern], why },
          }),
        pattern,
      ).toThrow(/events/);
    }
  });

  it("needs a why and at least one pattern, and takes no other keys", () => {
    expect(() =>
      validateManifestStrict({
        id: "birds",
        events: { subscribe: ["member.*"] },
      }),
    ).toThrow(/events/);
    expect(() =>
      validateManifestStrict({ id: "birds", events: { subscribe: [], why } }),
    ).toThrow(/at least one/);
    expect(() =>
      validateManifestStrict({
        id: "birds",
        events: { subscribe: ["member.*"], why, url: "https://x.example" },
      }),
    ).toThrow(/events/);
    expect(() =>
      validateManifestStrict({ id: "birds", events: ["member.*"] }),
    ).toThrow(/events is \{ subscribe/);
  });
});

describe("previousIds (a rename, docs/design/2026-11-app-rename.md)", () => {
  it("takes the ids the app had before", () => {
    expect(
      validateManifestStrict({ id: "scribe", previousIds: ["talk", "chat"] })
        .previousIds,
    ).toEqual(["talk", "chat"]);
    // A stored row keeps it too.
    expect(
      validateManifest({ id: "scribe", previousIds: ["talk"] }).previousIds,
    ).toEqual(["talk"]);
  });

  it("refuses the app's own id, an id twice, a reserved one and a malformed one", () => {
    for (const [previousIds, message] of [
      [["scribe"], /is the app's id/],
      [["talk", "talk"], /listed twice/],
      [["everyapp"], /reserved for the platform/],
      [["Talk"], /kebab-case/],
    ] as const) {
      expect(() =>
        validateManifestStrict({ id: "scribe", previousIds }),
      ).toThrow(message);
    }
    expect(() =>
      validateManifestStrict({ id: "scribe", previousIds: ["talk"] }),
    ).not.toThrow(ManifestError);
  });
});
