import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import {
  BUILD_SENTINEL,
  EVERYAPP_OBSERVABILITY,
  everyAppAuxiliaryWorker,
  everyAppWorker,
  localD1Id,
  localD1Path,
  resourceSentinel,
  sentinelDeployTarget,
  type D1Binding,
  type DurableObjectBinding,
  type DurableObjectExport,
  type EveryAppDevEnv,
  type EveryAppWorkerReference,
  type HyperdriveBinding,
  type KvBinding,
  type ServiceBinding,
  type WorkflowBinding,
  type WorkflowExport,
} from "./index";
import { DEV_ISSUER, DEV_PUBLIC_KEY_PEM } from "../dev/index";
import { aiProviderSettings, DEV_AI_PROVIDERS } from "../internal/aiProviders";
import { devGatewaySettingsFor } from "../internal/devGatewaySettings";
import { isReservedAppSecretName } from "../internal/gatewaySettings";
import { CAPABILITIES, capabilitySettings } from "../internal/capabilities";
import { EMAIL_SENDERS_ENV } from "../internal/email";

/** The placeholder Worker name every production build has. */
const BUILT = BUILD_SENTINEL.workerName;

const manifest = {
  id: "todo",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
  public: [],
} as const;

const entrypoint = { default: "/app/src/entry.worker.ts" };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-sdk-cf-"));
  // What `everyapp deploy` sets around a production build.
  vi.stubEnv("EVERYAPP_BUILD", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("everyAppWorker in development", () => {
  const worker = () =>
    everyAppWorker({
      manifest,
      entrypoint,
      ctx: { mode: "development" },
      root,
    });

  it("declares a private Worker named after the app", () => {
    expect(worker()).toMatchObject({
      name: "every-todo",
      entrypoint,
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: false,
      previewUrls: false,
      observability: EVERYAPP_OBSERVABILITY,
    });
  });

  it("carries the well-known dev identity as text and opts into dev tokens", () => {
    // Text, not secrets: cf dev needs no .dev.vars, and never looks for the
    // identity in .env files or the environment.
    expect(worker().env).toMatchObject({
      EVERYAPP_APP_ID: { type: "text", value: "todo" },
      EVERYAPP_DEV: { type: "text", value: "1" },
      EVERYAPP_IDENTITY_PUBLIC_KEYS: {
        type: "text",
        value: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
      },
      EVERYAPP_IDENTITY_ISSUER: { type: "text", value: DEV_ISSUER },
      CF_VERSION_METADATA: { type: "version-metadata" },
    });
    expect(worker().env).not.toHaveProperty("EVERY_APP_GATEWAY");
    // `everyapp dev` mints for the app id, which the SDK accepts in its place
    // only under EVERYAPP_DEV.
    expect(worker().env).not.toHaveProperty("EVERYAPP_AUDIENCE");
  });

  it("gives each D1 database the local id cf d1 --local can address", () => {
    const id = localD1Id("every-todo", "DB");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(worker().env["DB"]).toEqual({ type: "d1", name: "every-todo", id });
    expect(worker().env["KV"]).toEqual({ type: "kv" });
  });

  it("binds Durable Objects through declarative sqlite exports", () => {
    expect(worker().env["USER_SYNC"]).toEqual({
      type: "durable-object",
      worker: {
        name: "every-todo",
        compatibilityDate: "2026-06-01",
        entrypoint,
      },
      exportName: "UserSyncDO",
    });
    expect(worker().exports).toEqual({
      UserSyncDO: { type: "durable-object", storage: "sqlite" },
    });
  });

  it("treats cf commands without a mode as development", () => {
    const config = everyAppWorker({
      manifest,
      entrypoint,
      ctx: { mode: undefined },
      root,
    });
    expect(config.env).toMatchObject({
      EVERYAPP_DEV: { type: "text", value: "1" },
    });
  });

  it("types each manifest binding under its own name, for cf's Env inference", () => {
    const config = worker();
    expectTypeOf(config.env.DB).toEqualTypeOf<D1Binding>();
    expectTypeOf(config.env.KV).toEqualTypeOf<KvBinding>();
    expectTypeOf(config.env.USER_SYNC).toEqualTypeOf<
      DurableObjectBinding<
        EveryAppWorkerReference<typeof entrypoint>,
        "UserSyncDO"
      >
    >();
    expectTypeOf(config.exports).toEqualTypeOf<{
      UserSyncDO: DurableObjectExport;
    }>();
  });

  it("names itself in its own classes' bindings by definition, so cf types each namespace with its class", () => {
    class UserSyncDO {
      ping(): string {
        return "pong";
      }
    }
    // A `cf-worker` import of the entry module, as cf hands it to the config.
    const workerModule = {
      default: { fetch: () => new Response() },
      UserSyncDO,
    };
    // What cf's InferEnv makes of a durable-object binding: the class's
    // instance when `worker` is a definition whose module exports it, an
    // untyped namespace when `worker` is a name.
    type CfNamespace<B> = B extends {
      worker: infer W;
      exportName: infer E extends string;
    }
      ? W extends string
        ? "untyped"
        : W extends { entrypoint: infer TModule }
          ? E extends keyof TModule
            ? TModule[E] extends new (...args: never[]) => infer I
              ? I
              : never
            : never
          : never
      : never;

    const typed = everyAppWorker({
      manifest,
      entrypoint: workerModule,
      ctx: { mode: "development" },
      root,
    });
    expect(typed.env.USER_SYNC.worker).toEqual({
      name: "every-todo",
      compatibilityDate: "2026-06-01",
      entrypoint: workerModule,
    });
    expectTypeOf<
      CfNamespace<typeof typed.env.USER_SYNC>
    >().toEqualTypeOf<UserSyncDO>();
    // Serializable: no cycle back to the Worker definition.
    expect(() => JSON.stringify(typed)).not.toThrow();

    // A path entrypoint gives cf no module to read the class from.
    const byPath = everyAppWorker({
      manifest,
      entrypoint: "./src/entry.worker.ts",
      ctx: { mode: "development" },
      root,
    });
    expect(byPath.env.USER_SYNC).toEqual({
      type: "durable-object",
      worker: "every-todo",
      exportName: "UserSyncDO",
    });
    expectTypeOf(byPath.env.USER_SYNC).toEqualTypeOf<DurableObjectBinding>();
    expectTypeOf<
      CfNamespace<typeof byPath.env.USER_SYNC>
    >().toEqualTypeOf<"untyped">();
  });

  it("honors the manifest's compatibility date", () => {
    expect(
      everyAppWorker({
        manifest: { id: "todo", compatibilityDate: "2026-09-01" },
        entrypoint,
        ctx: { mode: "development" },
      }).compatibilityDate,
    ).toBe("2026-09-01");
  });

  it("returns observability settings the caller may change safely", () => {
    const config = worker();
    config.observability.logs.enabled = false;
    expect(EVERYAPP_OBSERVABILITY.logs.enabled).toBe(true);
  });
});

describe("localD1Path", () => {
  it("names the sqlite file cf dev keeps a local D1 database in", () => {
    // Pinned: miniflare names the file after the Durable Object id that
    // idFromName(<database id>) gives in its D1 namespace.
    expect(localD1Path("/app", localD1Id("every-todo", "DB"))).toBe(
      "/app/.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/6c6898e95bbb2d113f5d13a82c755843e6d92f528645620a69a4d3d49dc0e221.sqlite",
    );
    expect(localD1Path("/gw", localD1Id("every-app-gateway", "DB"))).toBe(
      "/gw/.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/00c5731e4bf6076d494879b9013ac4063ab8cd87f9803f518a34c9ac10293718.sqlite",
    );
  });
});

describe("everyAppWorker in production", () => {
  const worker = () =>
    everyAppWorker({
      manifest,
      entrypoint,
      ctx: { mode: "production" },
      root,
    });

  it("refuses to build unless `everyapp deploy` runs the build", () => {
    vi.stubEnv("EVERYAPP_BUILD", "");
    expect(worker).toThrow(/EVERYAPP_BUILD=1/);
    expect(worker).toThrow(/everyapp deploy/);
  });

  it("builds tenant-neutral: placeholders for everything install-specific", () => {
    const config = worker();

    expect(config.name).toBe(BUILT);
    expect(config.env).toEqual({
      EVERYAPP_APP_ID: { type: "text", value: "todo" },
      CF_VERSION_METADATA: { type: "version-metadata" },
      EVERYAPP_AUDIENCE: { type: "text", value: BUILT },
      EVERYAPP_IDENTITY_PUBLIC_KEYS: {
        type: "text",
        value: JSON.stringify([BUILD_SENTINEL.publicKey]),
      },
      EVERYAPP_IDENTITY_ISSUER: {
        type: "text",
        value: BUILD_SENTINEL.gatewayUrl,
      },
      EVERY_APP_GATEWAY: {
        type: "worker",
        worker: "every-app-gateway",
        exportName: "AppGateway",
        props: {
          organizationId: BUILD_SENTINEL.organizationId,
          appId: "todo",
          workerName: BUILT,
        },
      },
      GATEWAY_URL: { type: "secret" },
      // Always: installing a shared app swaps it for EVERYAPP_SHARED.
      EVERY_APP_ORG_ID: { type: "secret" },
      DB: {
        type: "d1",
        name: resourceSentinel("DB"),
        id: resourceSentinel("DB"),
      },
      KV: { type: "kv", id: resourceSentinel("KV") },
      USER_SYNC: {
        type: "durable-object",
        worker: {
          name: BUILT,
          compatibilityDate: "2026-06-01",
          entrypoint,
        },
        exportName: "UserSyncDO",
      },
    });
    expect(config.workersDev).toBe(false);
    expect(config.previewUrls).toBe(false);
    // Tombstones for deleted classes are the installer's too.
    expect(config.exports).toEqual({
      UserSyncDO: { type: "durable-object", storage: "sqlite" },
    });
  });

  it("builds the same Worker whoever builds it, wherever", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-sdk-cf-"));
    try {
      fs.writeFileSync(path.join(other, ".dev.vars"), "EVERYAPP_X=1\n");
      expect(
        everyAppWorker({
          manifest,
          entrypoint,
          ctx: { mode: "production" },
          root: other,
        }),
      ).toEqual(worker());
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("builds from sentinelDeployTarget(), the placeholders installers rewrite", () => {
    const target = sentinelDeployTarget(manifest);
    const env = worker().env as Record<string, { id?: string; name?: string }>;
    expect(env["DB"]).toMatchObject(target.resources.d1!["DB"]!);
    expect(env["KV"]).toMatchObject(target.resources.kv!["KV"]!);
    expect(target).toMatchObject({
      workerName: BUILT,
      organizationId: BUILD_SENTINEL.organizationId,
      gatewayUrl: BUILD_SENTINEL.gatewayUrl,
      identityPublicKeys: [BUILD_SENTINEL.publicKey],
    });
  });

  it("never enables dev identities", () => {
    const env = worker().env;
    expect(env).not.toHaveProperty("EVERYAPP_DEV");
    expect(JSON.stringify(env)).not.toContain(DEV_ISSUER);
    expect(JSON.stringify(env)).not.toContain(
      JSON.stringify(DEV_PUBLIC_KEY_PEM).slice(1, -1),
    );
  });
});

describe("everyAppWorker Workflows", () => {
  const withWorkflow = {
    ...manifest,
    resources: {
      ...manifest.resources,
      workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }],
    },
  } as const;

  it("defines and binds each Workflow, named after the Worker, in dev and production", () => {
    const dev = everyAppWorker({
      manifest: withWorkflow,
      entrypoint,
      ctx: { mode: "development" },
      root,
    });
    expect(dev.env.RANK_CHECK).toEqual({
      type: "workflow",
      name: "every-todo--rank-check",
      worker: "every-todo",
      exportName: "RankCheckWorkflow",
    });
    expect(dev.exports.RankCheckWorkflow).toEqual({
      type: "workflow",
      name: "every-todo--rank-check",
    });
    expectTypeOf(dev.env.RANK_CHECK).toEqualTypeOf<WorkflowBinding>();
    expectTypeOf(dev.exports).toEqualTypeOf<{
      UserSyncDO: DurableObjectExport;
      RankCheckWorkflow: WorkflowExport;
    }>();

    const deployed = everyAppWorker({
      manifest: withWorkflow,
      entrypoint,
      ctx: { mode: "production" },
      root,
    });
    expect(deployed.env.RANK_CHECK).toMatchObject({
      name: `${BUILT}--rank-check`,
      worker: BUILT,
    });
    expect(deployed.exports.RankCheckWorkflow).toEqual({
      type: "workflow",
      name: `${BUILT}--rank-check`,
    });
  });

  it.each([
    [
      "a binding the Worker has",
      { name: "DB", className: "DbWorkflow" },
      /reuses/,
    ],
    [
      "a Durable Object's class",
      { name: "SYNC", className: "UserSyncDO" },
      /reuses/,
    ],
    [
      "a name over Cloudflare's limit",
      { name: "A".repeat(60), className: "LongWorkflow" },
      /longer than Cloudflare's 64 characters/,
    ],
  ])("refuses a Workflow with %s", (_case, workflow, error) => {
    expect(() =>
      everyAppWorker({
        manifest: {
          ...manifest,
          resources: { ...manifest.resources, workflows: [workflow] },
        },
        entrypoint,
        ctx: { mode: "development" },
        root,
      }),
    ).toThrow(error);
  });
});

describe("everyAppWorker crons and the app's own secrets", () => {
  it("runs the scheduled handler on the given crons, in dev and production", () => {
    const crons = ["17 */6 * * *"];
    expect(
      everyAppWorker({
        manifest,
        entrypoint,
        ctx: { mode: "development" },
        root,
        crons,
      }).triggers,
    ).toEqual([{ type: "scheduled", schedule: "17 */6 * * *" }]);
    expect(
      everyAppWorker({
        manifest,
        entrypoint,
        ctx: { mode: "production" },
        root,
        crons,
      }).triggers,
    ).toEqual([{ type: "scheduled", schedule: "17 */6 * * *" }]);
    expect(
      everyAppWorker({
        manifest,
        entrypoint,
        ctx: { mode: "production" },
        root,
      }).triggers,
    ).toBeUndefined();
  });

  it("refuses a schedule that isn't a cron", () => {
    for (const schedule of ["", "hourly", "* * * *"]) {
      expect(() =>
        everyAppWorker({
          manifest,
          entrypoint,
          ctx: { mode: "development" },
          root,
          crons: [schedule],
        }),
      ).toThrow(/five-field cron schedule/);
    }
  });

  it("declares a secret of the manifest in development only once it is set locally", () => {
    const env = (mode: "development" | "production") =>
      everyAppWorker({
        manifest: { ...manifest, secrets: ["SDK_TEST_API_KEY", "STRIPE_KEY"] },
        entrypoint,
        ctx: { mode },
        root,
      }).env as Record<string, unknown>;

    expect(env("development")["SDK_TEST_API_KEY"]).toBeUndefined();

    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "SDK_TEST_API_KEY=dev-value\n",
    );
    expect(env("development")["SDK_TEST_API_KEY"]).toEqual({ type: "secret" });
    expect(env("development")["STRIPE_KEY"]).toBeUndefined();

    // A deployed Worker keeps the secret `everyapp secret set` sent.
    expect(env("production")["SDK_TEST_API_KEY"]).toBeUndefined();
  });

  it("reads .env files and the environment when there is no .dev.vars", () => {
    fs.writeFileSync(
      path.join(root, ".env.local"),
      "SDK_TEST_API_KEY=env-value\n",
    );
    const worker = everyAppWorker({
      manifest: { ...manifest, secrets: ["SDK_TEST_API_KEY"] },
      entrypoint,
      ctx: { mode: "development" },
      root,
    });
    expect((worker.env as Record<string, unknown>)["SDK_TEST_API_KEY"]).toEqual(
      {
        type: "secret",
      },
    );
  });

  it("declares the developer's own keys for the manifest's providers and capabilities", () => {
    const gatewayManifest = {
      ...manifest,
      providers: ["openrouter"],
      capabilities: { dataforseo: { access: "read" } },
    } as const;
    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "OPENROUTER_API_KEY=or\nDATAFORSEO_API_KEY=dfs\nOPENAI_API_KEY=oa\n",
    );
    const env = (mode: "development" | "production") =>
      everyAppWorker({
        manifest: gatewayManifest,
        entrypoint,
        ctx: { mode },
        root,
      }).env as Record<string, unknown>;

    expect(env("development")).toMatchObject({
      OPENROUTER_API_KEY: { type: "secret" },
      DATAFORSEO_API_KEY: { type: "secret" },
    });
    // Only the keys of what the manifest asks for.
    expect(env("development")["OPENAI_API_KEY"]).toBeUndefined();
    expectTypeOf<EveryAppDevEnv<typeof gatewayManifest>>().toHaveProperty(
      "DATAFORSEO_API_KEY",
    );

    // Deployed, the gateway holds them.
    expect(env("production")["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(env("production")["DATAFORSEO_API_KEY"]).toBeUndefined();
  });

  it("knows every setting of every provider and capability the SDK reaches in dev", () => {
    const keys = new Set([
      ...Object.values(DEV_AI_PROVIDERS).flatMap(aiProviderSettings),
      ...Object.values(CAPABILITIES).flatMap(capabilitySettings),
    ]);
    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      [...keys, "UNRELATED_SETTING"].map((key) => `${key}=set`).join("\n"),
    );
    const everything = {
      ...manifest,
      providers: Object.keys(DEV_AI_PROVIDERS),
      capabilities: Object.fromEntries(
        Object.entries(CAPABILITIES).map(([id, { access }]) => [
          id,
          { access: access[0] },
        ]),
      ),
    };
    const env = everyAppWorker({
      manifest: everything,
      entrypoint,
      ctx: { mode: "development" },
      root,
    }).env as Record<string, unknown>;
    // Exactly these: whatever else .dev.vars sets stays undeclared.
    const declared = Object.entries(env)
      .filter(([, binding]) => (binding as { type?: string }).type === "secret")
      .map(([name]) => name);
    expect(new Set(declared)).toEqual(keys);
    // And what `everyapp dev` checks .dev.vars for is the same list.
    expect(
      new Set(devGatewaySettingsFor(everything).map((need) => need.name)),
    ).toEqual(keys);
  });

  it("declares the email settings in dev when .dev.vars sets them, and the stand-in senders", () => {
    const mailer = {
      ...manifest,
      capabilities: { email: { access: "write" } },
    } as const;
    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "EMAIL_FROM=noreply@example.com\nEMAIL_REST_API_TOKEN=token\nCLOUDFLARE_ACCOUNT_ID=acc123\nEVERYAPP_EMAIL_SENDERS=*@mail.example.com\n",
    );
    const env = (mode: string) =>
      everyAppWorker({
        manifest: mailer,
        entrypoint,
        ctx: { mode },
        root,
      }).env as Record<string, unknown>;

    expect(env("development")).toMatchObject({
      EMAIL_FROM: { type: "secret" },
      EMAIL_REST_API_TOKEN: { type: "secret" },
      CLOUDFLARE_ACCOUNT_ID: { type: "secret" },
      // sendEmail() checks a `from` against them, as the gateway does.
      [EMAIL_SENDERS_ENV]: { type: "secret" },
    });
    // Not set, not declared.
    expect(env("development")["EMAIL_FROM_NAME"]).toBeUndefined();
    expectTypeOf<EveryAppDevEnv<typeof mailer>>().toHaveProperty(
      "EMAIL_REST_API_TOKEN",
    );

    // Deployed, the gateway holds the sender and reads the senders itself.
    expect(env("production")["EMAIL_FROM"]).toBeUndefined();
    expect(env("production")[EMAIL_SENDERS_ENV]).toBeUndefined();
  });

  it("gives an app that doesn't list email no senders binding, and one that lists it none unless .dev.vars sets it", () => {
    expect(
      everyAppWorker({
        manifest,
        entrypoint,
        ctx: { mode: "development" },
        root,
      }).env,
    ).not.toHaveProperty(EMAIL_SENDERS_ENV);
    expect(
      everyAppWorker({
        manifest: { ...manifest, capabilities: { email: { access: "write" } } },
        entrypoint,
        ctx: { mode: "development" },
        root,
      }).env,
    ).not.toHaveProperty(EMAIL_SENDERS_ENV);
  });

  it("declares Workers AI's token and account in dev when .dev.vars sets them", () => {
    const workersAi = { ...manifest, providers: ["workers-ai"] } as const;
    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "WORKERS_AI_API_TOKEN=token\nCLOUDFLARE_ACCOUNT_ID=acc123\n",
    );
    const env = everyAppWorker({
      manifest: workersAi,
      entrypoint,
      ctx: { mode: "development" },
      root,
    }).env as Record<string, unknown>;

    expect(env).toMatchObject({
      WORKERS_AI_API_TOKEN: { type: "secret" },
      CLOUDFLARE_ACCOUNT_ID: { type: "secret" },
    });
    expectTypeOf<EveryAppDevEnv<typeof workersAi>>().toHaveProperty(
      "WORKERS_AI_API_TOKEN",
    );
    expectTypeOf<EveryAppDevEnv<typeof workersAi>>().toHaveProperty(
      "CLOUDFLARE_ACCOUNT_ID",
    );
  });

  it("refuses a secret named like a binding it builds or one the deploy sets", () => {
    for (const secret of [
      "DB",
      "EVERYAPP_DEV",
      "GATEWAY_URL",
      "every_app_org_id",
      "BAD-NAME",
    ]) {
      expect(
        () =>
          everyAppWorker({
            manifest: { ...manifest, secrets: [secret] },
            entrypoint,
            ctx: { mode: "development" },
            root,
          }),
        secret,
      ).toThrow(/secrets:/);
    }
    // The names the deploy sets follow the rule the manifest validator and
    // the CLI apply (a binding's name is the config's own business).
    for (const secret of ["EVERYAPP_DEV", "GATEWAY_URL", "every_app_org_id"]) {
      expect(isReservedAppSecretName(secret), secret).toBe(true);
    }
    expect(isReservedAppSecretName("DB")).toBe(false);
  });
});

describe("everyAppWorker compatibility flags", () => {
  const withHelper = {
    id: "seo",
    workers: [{ name: "audit" }],
  } as const;

  it("appends the app's flags to nodejs_compat, each once, on the app and its helpers", () => {
    const compatibilityFlags = [
      "global_fetch_strictly_public",
      "nodejs_compat",
      "global_fetch_strictly_public",
    ];
    for (const mode of ["development", "production"] as const) {
      const app = everyAppWorker({
        manifest: withHelper,
        entrypoint,
        ctx: { mode },
        root,
        compatibilityFlags,
      });
      const audit = everyAppAuxiliaryWorker({
        manifest: withHelper,
        worker: "audit",
        entrypoint: "/app/src/audit.ts",
        ctx: { mode },
        root,
        compatibilityFlags,
      });
      expect(app.compatibilityFlags).toEqual([
        "nodejs_compat",
        "global_fetch_strictly_public",
      ]);
      expect(audit.compatibilityFlags).toEqual([
        "nodejs_compat",
        "global_fetch_strictly_public",
      ]);
    }
  });

  it("keeps nodejs_compat alone and the date as it was without any", () => {
    const app = everyAppWorker({
      manifest: withHelper,
      entrypoint,
      ctx: { mode: "development" },
      root,
    });
    const audit = everyAppAuxiliaryWorker({
      manifest: withHelper,
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode: "development" },
      root,
      compatibilityFlags: [],
    });
    expect(app.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(audit.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(app.compatibilityDate).toBe("2026-06-01");
  });
});

describe("everyAppWorker guards", () => {
  it("rejects modes other than development and production", () => {
    expect(() =>
      everyAppWorker({ manifest, entrypoint, ctx: { mode: "staging" }, root }),
    ).toThrow(/not "staging"/);
  });

  it("rejects an app id whose Worker would be the gateway", () => {
    expect(() =>
      everyAppWorker({
        manifest: { id: "app-gateway" },
        entrypoint,
        ctx: { mode: "development" },
      }),
    ).toThrow(/reserved/);
  });

  it("rejects an app id that isn't kebab-case", () => {
    expect(() =>
      everyAppWorker({
        manifest: { id: "Todo App" },
        entrypoint,
        ctx: { mode: "development" },
      }),
    ).toThrow(/kebab-case/);
  });
});

describe("the cloudflare entry", () => {
  const importsOf = (file: string) =>
    [
      ...fs
        .readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/from\s+"([^"]+)"/g),
    ].map((match) => match[1]!);

  it("imports nothing the Worker bundle also loads", () => {
    // The Vite plugin denies the Worker every file cloudflare.config.ts
    // imports. When the SDK is linked from source, a shared module would be
    // denied to the Worker in dev. The dev keypair is a leaf the Worker
    // never loads (src/dev/index.test.ts checks that side).
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      for (const specifier of importsOf(path.join(dir, file))) {
        expect(
          specifier.startsWith("node:") ||
            specifier.startsWith("./") ||
            specifier === "../dev/keypair.js",
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
    expect(importsOf(path.join(dir, "..", "dev", "keypair.ts"))).toEqual([]);
  });
});

describe("helper Workers", () => {
  const seo = {
    id: "seo",
    resources: {
      d1: ["DB"],
      durableObjects: [
        { name: "CHAT", className: "ChatAgent" },
        { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
      ],
      workflows: [
        { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
      ],
    },
    workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  } as const;

  const helper = (mode: "development" | "production") =>
    everyAppAuxiliaryWorker({
      manifest: seo,
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode },
      root,
    });

  it("binds the app to a helper's classes and the helper itself", () => {
    const app = everyAppWorker({
      manifest: seo,
      entrypoint,
      ctx: { mode: "development" },
      root,
    });

    expect(app.env).toMatchObject({
      SCRATCHPAD: {
        type: "durable-object",
        worker: "every-seo--audit",
        exportName: "Scratchpad",
      },
      SITE_AUDIT: {
        type: "workflow",
        name: "every-seo--site-audit",
        worker: "every-seo--audit",
        exportName: "SiteAuditWorkflow",
      },
      AUDIT_ENGINE: { type: "worker", worker: "every-seo--audit" },
    });
    expect(app.exports).toEqual({
      ChatAgent: { type: "durable-object", storage: "sqlite" },
    });
  });

  it("builds a private helper that shares the app's storage and defines its own classes", () => {
    const audit = helper("development");

    expect(audit).toMatchObject({
      name: "every-seo--audit",
      entrypoint: "/app/src/audit.ts",
      workersDev: false,
      previewUrls: false,
    });
    expect(audit.env).toEqual({
      EVERYAPP_APP_ID: { type: "text", value: "seo" },
      EVERYAPP_DEV: { type: "text", value: "1" },
      DB: { type: "d1", name: "every-seo", id: localD1Id("every-seo", "DB") },
      SCRATCHPAD: {
        type: "durable-object",
        worker: "every-seo--audit",
        exportName: "Scratchpad",
      },
      SITE_AUDIT: {
        type: "workflow",
        name: "every-seo--site-audit",
        worker: "every-seo--audit",
        exportName: "SiteAuditWorkflow",
      },
    });
    expect(audit.exports).toEqual({
      Scratchpad: { type: "durable-object", storage: "sqlite" },
      SiteAuditWorkflow: {
        type: "workflow",
        name: "every-seo--site-audit",
      },
    });
  });

  it("shares the app's local KV namespaces with a helper in dev", () => {
    const withKv = { ...seo, resources: { ...seo.resources, kv: ["KV"] } };
    const app = everyAppWorker({
      manifest: withKv,
      entrypoint,
      ctx: { mode: "development" },
      root,
    });
    const audit = everyAppAuxiliaryWorker({
      manifest: withKv,
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode: "development" },
      root,
    });
    expect(audit.env["KV"]).toEqual({ type: "kv", id: "KV-every-seo" });
    expect(audit.env["KV"]).toEqual(app.env["KV"]);
  });

  it("gives a helper in dev the developer's keys for the app's capabilities", () => {
    fs.writeFileSync(path.join(root, ".dev.vars"), "CONTEXT_API_KEY=ctx\n");
    const audit = everyAppAuxiliaryWorker({
      manifest: { ...seo, capabilities: { context: { access: "read" } } },
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode: "development" },
      root,
    });
    expect(audit.env["CONTEXT_API_KEY"]).toEqual({ type: "secret" });
  });

  it("gives a helper in dev the stand-in senders .dev.vars sets", () => {
    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "EVERYAPP_EMAIL_SENDERS=a@b.example\n",
    );
    const audit = everyAppAuxiliaryWorker({
      manifest: { ...seo, capabilities: { email: { access: "write" } } },
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode: "development" },
      root,
    });
    expect(audit.env[EMAIL_SENDERS_ENV]).toEqual({ type: "secret" });
  });

  it("gives a deployed helper the gateway binding with the app's identity", () => {
    const audit = helper("production");

    expect(audit.name).toBe(`${BUILT}--audit`);
    expect(audit.env).toMatchObject({
      DB: {
        type: "d1",
        name: resourceSentinel("DB"),
        id: resourceSentinel("DB"),
      },
      EVERY_APP_GATEWAY: {
        type: "worker",
        worker: "every-app-gateway",
        exportName: "AppGateway",
        props: {
          organizationId: BUILD_SENTINEL.organizationId,
          appId: "seo",
          workerName: BUILT,
        },
      },
      // What names the gateway and the organization, like the app's Worker.
      GATEWAY_URL: { type: "secret" },
      EVERY_APP_ORG_ID: { type: "secret" },
    });
    expect(audit.env).not.toHaveProperty("EVERYAPP_DEV");
    // Whether the app is shared is the installer's to say.
    expect(audit.env).not.toHaveProperty("EVERYAPP_SHARED");
  });

  it("types the helper's service binding and leaves its classes out of the app's exports", () => {
    const app = everyAppWorker({
      manifest: seo,
      entrypoint,
      ctx: { mode: "development" },
      root,
    });
    expectTypeOf(app.env.AUDIT_ENGINE).toEqualTypeOf<ServiceBinding>();
    expectTypeOf(app.env.SITE_AUDIT).toEqualTypeOf<WorkflowBinding>();
    expectTypeOf(app.env.SCRATCHPAD).toEqualTypeOf<DurableObjectBinding>();
    expectTypeOf(app.exports).toEqualTypeOf<{
      ChatAgent: DurableObjectExport;
    }>();
  });

  it("builds the deployed app and helper Workers", () => {
    const withOwnWorkflow = {
      ...seo,
      resources: {
        ...seo.resources,
        workflows: [
          ...seo.resources.workflows,
          { name: "RANK_CHECK", className: "RankCheckWorkflow" },
        ],
      },
    } as const;
    const app = everyAppWorker({
      manifest: withOwnWorkflow,
      entrypoint,
      ctx: { mode: "production" },
      root,
    });
    const audit = everyAppAuxiliaryWorker({
      manifest: withOwnWorkflow,
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode: "production" },
      root,
    });
    expect({
      app: { name: app.name, env: app.env, exports: app.exports },
      audit: { name: audit.name, env: audit.env, exports: audit.exports },
    }).toMatchInlineSnapshot(`
      {
        "app": {
          "env": {
            "AUDIT_ENGINE": {
              "type": "worker",
              "worker": "every-hosted--sentinel--audit",
            },
            "CF_VERSION_METADATA": {
              "type": "version-metadata",
            },
            "CHAT": {
              "exportName": "ChatAgent",
              "type": "durable-object",
              "worker": {
                "compatibilityDate": "2026-06-01",
                "entrypoint": {
                  "default": "/app/src/entry.worker.ts",
                },
                "name": "every-hosted--sentinel",
              },
            },
            "DB": {
              "id": "every-hosted--sentinel--DB",
              "name": "every-hosted--sentinel--DB",
              "type": "d1",
            },
            "EVERYAPP_APP_ID": {
              "type": "text",
              "value": "seo",
            },
            "EVERYAPP_AUDIENCE": {
              "type": "text",
              "value": "every-hosted--sentinel",
            },
            "EVERYAPP_IDENTITY_ISSUER": {
              "type": "text",
              "value": "https://every-hosted--sentinel.invalid",
            },
            "EVERYAPP_IDENTITY_PUBLIC_KEYS": {
              "type": "text",
              "value": "["-----BEGIN PUBLIC KEY-----\\nEVERYAPPHOSTEDDEPLOYSENTINEL\\n-----END PUBLIC KEY-----\\n"]",
            },
            "EVERY_APP_GATEWAY": {
              "exportName": "AppGateway",
              "props": {
                "appId": "seo",
                "organizationId": "everyapp-hosted-deploy-sentinel",
                "workerName": "every-hosted--sentinel",
              },
              "type": "worker",
              "worker": "every-app-gateway",
            },
            "EVERY_APP_ORG_ID": {
              "type": "secret",
            },
            "GATEWAY_URL": {
              "type": "secret",
            },
            "RANK_CHECK": {
              "exportName": "RankCheckWorkflow",
              "name": "every-hosted--sentinel--rank-check",
              "type": "workflow",
              "worker": "every-hosted--sentinel",
            },
            "SCRATCHPAD": {
              "exportName": "Scratchpad",
              "type": "durable-object",
              "worker": "every-hosted--sentinel--audit",
            },
            "SITE_AUDIT": {
              "exportName": "SiteAuditWorkflow",
              "name": "every-hosted--sentinel--site-audit",
              "type": "workflow",
              "worker": "every-hosted--sentinel--audit",
            },
          },
          "exports": {
            "ChatAgent": {
              "storage": "sqlite",
              "type": "durable-object",
            },
            "RankCheckWorkflow": {
              "name": "every-hosted--sentinel--rank-check",
              "type": "workflow",
            },
          },
          "name": "every-hosted--sentinel",
        },
        "audit": {
          "env": {
            "DB": {
              "id": "every-hosted--sentinel--DB",
              "name": "every-hosted--sentinel--DB",
              "type": "d1",
            },
            "EVERYAPP_APP_ID": {
              "type": "text",
              "value": "seo",
            },
            "EVERY_APP_GATEWAY": {
              "exportName": "AppGateway",
              "props": {
                "appId": "seo",
                "organizationId": "everyapp-hosted-deploy-sentinel",
                "workerName": "every-hosted--sentinel",
              },
              "type": "worker",
              "worker": "every-app-gateway",
            },
            "EVERY_APP_ORG_ID": {
              "type": "secret",
            },
            "GATEWAY_URL": {
              "type": "secret",
            },
            "SCRATCHPAD": {
              "exportName": "Scratchpad",
              "type": "durable-object",
              "worker": "every-hosted--sentinel--audit",
            },
            "SITE_AUDIT": {
              "exportName": "SiteAuditWorkflow",
              "name": "every-hosted--sentinel--site-audit",
              "type": "workflow",
              "worker": "every-hosted--sentinel--audit",
            },
          },
          "exports": {
            "Scratchpad": {
              "storage": "sqlite",
              "type": "durable-object",
            },
            "SiteAuditWorkflow": {
              "name": "every-hosted--sentinel--site-audit",
              "type": "workflow",
            },
          },
          "name": "every-hosted--sentinel--audit",
        },
      }
    `);
  });

  it("refuses a helper binding that reuses one of the app's binding names", () => {
    expect(() =>
      everyAppWorker({
        manifest: {
          ...seo,
          workers: [{ name: "audit", binding: "DB" }],
        },
        entrypoint,
        ctx: { mode: "development" },
        root,
      }),
    ).toThrow(/audit's binding DB reuses a binding name/);
  });

  it("refuses a helper whose Worker name would pass Cloudflare's limit", () => {
    expect(() =>
      everyAppAuxiliaryWorker({
        manifest: { id: "seo", workers: [{ name: "a".repeat(60) }] },
        worker: "a".repeat(60),
        entrypoint: "/app/src/audit.ts",
        ctx: { mode: "development" },
        root,
      }),
    ).toThrow(/longer than Cloudflare's 63 characters/);
  });

  it("refuses a helper the manifest doesn't declare", () => {
    expect(() =>
      everyAppAuxiliaryWorker({
        manifest: seo,
        worker: "crawler",
        entrypoint: "/app/src/crawler.ts",
        ctx: { mode: "development" },
        root,
      }),
    ).toThrow(/declares no helper Worker "crawler"/);
  });
});

describe("Postgres through Hyperdrive", () => {
  const seo = {
    id: "seo",
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
    limits: { cpuMs: 60_000 },
  } as const;

  const build = (mode: "development" | "production") => {
    const { entrypoint: _app, ...app } = everyAppWorker({
      manifest: seo,
      entrypoint,
      ctx: { mode },
      root,
    });
    const { entrypoint: _audit, ...audit } = everyAppAuxiliaryWorker({
      manifest: seo,
      worker: "audit",
      entrypoint: "/app/src/audit.ts",
      ctx: { mode },
      root,
    });
    return { app, audit };
  };

  it("binds each Worker's configs, near the database, with its CPU limit", () => {
    const { app, audit } = build("production");
    const pick = (config: {
      env: object;
      placement?: unknown;
      limits?: unknown;
    }) => {
      const env = config.env as Record<string, unknown>;
      return {
        placement: config.placement,
        limits: config.limits,
        DATABASE_PROVIDER: env["DATABASE_PROVIDER"],
        HYPERDRIVE: env["HYPERDRIVE"],
        CRAWL_DB: env["CRAWL_DB"],
      };
    };
    expect({ app: pick(app), audit: pick(audit) }).toMatchInlineSnapshot(`
      {
        "app": {
          "CRAWL_DB": undefined,
          "DATABASE_PROVIDER": {
            "type": "text",
            "value": "postgres",
          },
          "HYPERDRIVE": {
            "id": "every-hosted--sentinel--HYPERDRIVE",
            "type": "hyperdrive",
          },
          "limits": {
            "cpuMs": 60000,
          },
          "placement": {
            "region": "aws:us-east-1",
          },
        },
        "audit": {
          "CRAWL_DB": {
            "id": "every-hosted--sentinel--CRAWL_DB",
            "type": "hyperdrive",
          },
          "DATABASE_PROVIDER": {
            "type": "text",
            "value": "postgres",
          },
          "HYPERDRIVE": {
            "id": "every-hosted--sentinel--HYPERDRIVE",
            "type": "hyperdrive",
          },
          "limits": {
            "cpuMs": 300000,
          },
          "placement": {
            "region": "aws:us-east-1",
          },
        },
      }
    `);
  });

  it("binds Hyperdrive in dev only to a local database the developer set", () => {
    expect(build("development").app.env).not.toHaveProperty("HYPERDRIVE");
    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://dev:dev@localhost:5432/seo\n",
    );
    const { app, audit } = build("development");
    expect(app.env).toMatchObject({
      DATABASE_PROVIDER: { type: "text", value: "postgres" },
      HYPERDRIVE: {
        type: "hyperdrive",
        id: localD1Id("every-seo", "HYPERDRIVE"),
        dev: { connectionString: "postgres://dev:dev@localhost:5432/seo" },
      },
    });
    expect(audit.env).toHaveProperty("HYPERDRIVE");
    expect(audit.env).not.toHaveProperty("CRAWL_DB");
    // Placement is for the deployed Workers; limits hold in dev too.
    expect(app).not.toHaveProperty("placement");
    expect(app.limits).toEqual({ cpuMs: 60_000 });
  });

  it("types DATABASE_PROVIDER, and Hyperdrive as deploy-only", () => {
    type Env = ReturnType<
      typeof everyAppWorker<typeof seo, typeof entrypoint>
    >["env"];
    expectTypeOf<
      Extract<Env, { EVERYAPP_DEV: unknown }>["DATABASE_PROVIDER"]
    >().toEqualTypeOf<{
      type: "text";
      value: string;
    }>();
    expectTypeOf<
      Extract<Env, { EVERYAPP_AUDIENCE: unknown }>["HYPERDRIVE"]
    >().toEqualTypeOf<HyperdriveBinding>();
    expectTypeOf<
      Extract<Env, { EVERYAPP_AUDIENCE: unknown }>
    >().not.toHaveProperty("CRAWL_DB");
  });

  it("leaves a Worker without a database, limits or Hyperdrive as it was", () => {
    const config = everyAppWorker({
      manifest,
      entrypoint,
      ctx: { mode: "production" },
      root,
    });
    expect(config).not.toHaveProperty("placement");
    expect(config).not.toHaveProperty("limits");
    expect(config.env).not.toHaveProperty("DATABASE_PROVIDER");
  });
});

describe("R2 buckets (resources.r2)", () => {
  const postiz = {
    id: "postiz",
    resources: {
      d1: ["DB"],
      r2: ["R2", "MEDIA_FILES"],
      workflows: [
        {
          name: "PUBLISH_POST",
          className: "PublishPostWorkflow",
          worker: "api",
        },
      ],
    },
    workers: [{ name: "api", binding: "API" }],
  } as const;

  const build = (mode: "development" | "production") => {
    const { entrypoint: _app, ...app } = everyAppWorker({
      manifest: postiz,
      entrypoint,
      ctx: { mode },
      root,
    });
    const { entrypoint: _api, ...api } = everyAppAuxiliaryWorker({
      manifest: postiz,
      worker: "api",
      entrypoint: "/app/src/api.ts",
      ctx: { mode },
      root,
    });
    return { app, api };
  };

  it("binds each bucket's placeholder on the app's Worker and every helper", () => {
    const { app, api } = build("production");
    for (const env of [app.env, api.env] as Record<string, unknown>[]) {
      expect(env["R2"]).toEqual({ type: "r2", name: resourceSentinel("R2") });
      expect(env["MEDIA_FILES"]).toEqual({
        type: "r2",
        name: resourceSentinel("MEDIA_FILES"),
      });
    }
  });

  it("names dev buckets by the gateway's rule: R2 after the Worker, others <worker>--<binding>", () => {
    const { app, api } = build("development");
    expect(app.env).toMatchObject({
      R2: { type: "r2", name: "every-postiz" },
      MEDIA_FILES: { type: "r2", name: "every-postiz--media-files" },
    });
    expect((api.env as Record<string, unknown>)["MEDIA_FILES"]).toEqual(
      (app.env as Record<string, unknown>)["MEDIA_FILES"],
    );
    // D1 databases other than DB follow the same separator in dev.
    const { env } = everyAppWorker({
      manifest: { id: "seo", resources: { d1: ["DB", "CRAWL_LOG"] } },
      entrypoint,
      ctx: { mode: "development" },
      root,
    });
    expect((env as Record<string, unknown>)["CRAWL_LOG"]).toMatchObject({
      name: "every-seo--crawl-log",
    });
  });

  it("types each bucket under its own binding name", () => {
    const { app } = build("development");
    expectTypeOf(app.env.R2).toEqualTypeOf<{ type: "r2"; name: string }>();
    expectTypeOf(app.env.MEDIA_FILES).toEqualTypeOf<{
      type: "r2";
      name: string;
    }>();
  });

  it("leaves a manifest without buckets with none, so a hand-written binding stays the app's", () => {
    const config = everyAppWorker({
      manifest,
      entrypoint,
      ctx: { mode: "production" },
      root,
    });
    expect(
      Object.values(config.env as Record<string, { type: string }>).filter(
        (binding) => binding.type === "r2",
      ),
    ).toEqual([]);
  });
});
