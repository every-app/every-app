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
  bucketNameFor,
  isReservedAppId,
  manifestTierProblems,
  DISPATCH_INBOUND_PROBLEM,
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
      { github: { access: "read" } },
      /capabilities\.github: unknown capability \(the gateway offers: dataforseo, context, email, members, linkedin, facebook, .*, microsoft-365\)/,
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
      /Unrecognized key\(s\) in object: 'as'/,
    ],
    [
      "the retired `background` key",
      { dataforseo: { access: "read", background: true } },
      /Unrecognized key\(s\) in object: 'background'/,
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
      /Unrecognized key\(s\) in object: 'senders'/,
    ],
    [
      "a leftover senders list",
      { email: { access: "write", senders: ["*@mail.example.com"] } },
      /capabilities\.email\.senders: senders moved out of the manifest: set them with `everyapp email set --sender <pattern>`/,
    ],
    [
      "senders on a capability that doesn't send mail",
      { dataforseo: { access: "read", senders: ["*@mail.example.com"] } },
      /capabilities\.dataforseo: Unrecognized key\(s\) in object: 'senders'/,
    ],
    [
      "an OAuth client for reading",
      { linkedin: { access: "read" } },
      /capabilities\.linkedin\.access: LinkedIn offers write access/,
    ],
    [
      "a field an OAuth client doesn't take",
      { mastodon: { access: "write", scopes: ["write:statuses"] } },
      /capabilities\.mastodon: Unrecognized key\(s\) in object: 'scopes'/,
    ],
  ])("refuses %s", (_case, capabilities, problem) => {
    expect(() => validateManifestStrict({ id: "seo", capabilities })).toThrow(
      problem,
    );
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
      /Unrecognized key\(s\) in object: 'routes'/,
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
