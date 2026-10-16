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
} from "vitest";
import {
  DEPLOY_INPUTS_FILE,
  EVERYAPP_OBSERVABILITY,
  everyAppWorker,
  localD1Id,
  localD1Path,
  type D1Binding,
  type DurableObjectBinding,
  type DurableObjectExport,
  type EveryAppDeployInputs,
  type KvBinding,
  type WorkflowBinding,
  type WorkflowExport,
} from "./index";
import { DEV_ISSUER, DEV_PUBLIC_KEY_PEM } from "../dev/index";

const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----\n";

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
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeDeployInputs(overrides: Partial<EveryAppDeployInputs> = {}) {
  const inputs: EveryAppDeployInputs = {
    schema: 1,
    workerName: "every-acme-todo",
    organizationId: "org_1",
    gatewayUrl: "https://apps.example.com",
    identityIssuer: "https://apps.example.com",
    identityPublicKeys: [PUBLIC_KEY],
    resources: {
      d1: { DB: { name: "every-acme-todo", id: "d1-uuid" } },
      kv: { KV: { id: "kv-id" } },
    },
    ...overrides,
  };
  const file = path.join(root, DEPLOY_INPUTS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(inputs));
}

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
      worker: "every-todo",
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
    expectTypeOf(config.env.USER_SYNC).toEqualTypeOf<DurableObjectBinding>();
    expectTypeOf(config.exports).toEqualTypeOf<{
      UserSyncDO: DurableObjectExport;
    }>();
  });

  it("ignores deploy inputs outside production", () => {
    writeDeployInputs();
    expect(worker().name).toBe("every-todo");
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

  it("refuses to build without deploy inputs", () => {
    expect(worker).toThrow(/\.everyapp\/deploy\.json not found/);
    expect(worker).toThrow(/everyapp deploy/);
  });

  it("builds the deployed identity, gateway binding and resources", () => {
    writeDeployInputs();
    const config = worker();

    expect(config.name).toBe("every-acme-todo");
    expect(config.env).toEqual({
      EVERYAPP_APP_ID: { type: "text", value: "todo" },
      CF_VERSION_METADATA: { type: "version-metadata" },
      EVERYAPP_AUDIENCE: { type: "text", value: "every-acme-todo" },
      EVERYAPP_IDENTITY_PUBLIC_KEYS: {
        type: "text",
        value: JSON.stringify([PUBLIC_KEY]),
      },
      EVERYAPP_IDENTITY_ISSUER: {
        type: "text",
        value: "https://apps.example.com",
      },
      EVERY_APP_GATEWAY: {
        type: "worker",
        worker: "every-app-gateway",
        exportName: "AppGateway",
        props: {
          organizationId: "org_1",
          appId: "todo",
          workerName: "every-acme-todo",
        },
      },
      GATEWAY_URL: { type: "secret" },
      EVERY_APP_ORG_ID: { type: "secret" },
      DB: { type: "d1", name: "every-acme-todo", id: "d1-uuid" },
      KV: { type: "kv", id: "kv-id" },
      USER_SYNC: {
        type: "durable-object",
        worker: "every-acme-todo",
        exportName: "UserSyncDO",
      },
    });
    expect(config.workersDev).toBe(false);
    expect(config.previewUrls).toBe(false);
  });

  it("never enables dev identities", () => {
    writeDeployInputs();
    const env = worker().env;
    expect(env).not.toHaveProperty("EVERYAPP_DEV");
    expect(JSON.stringify(env)).not.toContain(DEV_ISSUER);
    expect(JSON.stringify(env)).not.toContain(
      JSON.stringify(DEV_PUBLIC_KEY_PEM).slice(1, -1),
    );
  });

  it("refuses deploy inputs that miss a declared resource", () => {
    writeDeployInputs({ resources: { d1: {}, kv: { KV: { id: "kv-id" } } } });
    expect(worker).toThrow(/no D1 database for binding "DB"/);
  });

  it("deletes the Durable Object classes the deploy marks deleted", () => {
    writeDeployInputs({ deletedDurableObjects: ["OldSyncDO"] });
    expect(worker().exports).toEqual({
      UserSyncDO: { type: "durable-object", storage: "sqlite" },
      OldSyncDO: { type: "durable-object", state: "deleted" },
    });
  });

  it("refuses to delete a class the manifest still declares", () => {
    writeDeployInputs({ deletedDurableObjects: ["UserSyncDO"] });
    expect(worker).toThrow(/both declared/);
  });

  it("refuses malformed deploy inputs", () => {
    const file = path.join(root, DEPLOY_INPUTS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(worker).toThrow(/not valid JSON/);
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

    writeDeployInputs();
    const deployed = everyAppWorker({
      manifest: withWorkflow,
      entrypoint,
      ctx: { mode: "production" },
      root,
    });
    expect(deployed.env.RANK_CHECK).toMatchObject({
      name: "every-acme-todo--rank-check",
      worker: "every-acme-todo",
    });
    expect(deployed.exports.RankCheckWorkflow).toEqual({
      type: "workflow",
      name: "every-acme-todo--rank-check",
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
    writeDeployInputs();
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

  it("declares a secret of the app in development only once it is set locally", () => {
    const env = (mode: "development" | "production") =>
      everyAppWorker({
        manifest,
        entrypoint,
        ctx: { mode },
        root,
        secrets: ["SDK_TEST_API_KEY", "STRIPE_KEY"],
      }).env as Record<string, unknown>;

    expect(env("development")["SDK_TEST_API_KEY"]).toBeUndefined();

    fs.writeFileSync(
      path.join(root, ".dev.vars"),
      "SDK_TEST_API_KEY=dev-value\n",
    );
    expect(env("development")["SDK_TEST_API_KEY"]).toEqual({ type: "secret" });
    expect(env("development")["STRIPE_KEY"]).toBeUndefined();

    // A deployed Worker keeps the secret `everyapp secret set` sent.
    writeDeployInputs();
    expect(env("production")["SDK_TEST_API_KEY"]).toBeUndefined();
  });

  it("reads .env files and the environment when there is no .dev.vars", () => {
    fs.writeFileSync(
      path.join(root, ".env.local"),
      "SDK_TEST_API_KEY=env-value\n",
    );
    const worker = everyAppWorker({
      manifest,
      entrypoint,
      ctx: { mode: "development" },
      root,
      secrets: ["SDK_TEST_API_KEY"],
    });
    expect((worker.env as Record<string, unknown>)["SDK_TEST_API_KEY"]).toEqual(
      {
        type: "secret",
      },
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
            manifest,
            entrypoint,
            ctx: { mode: "development" },
            root,
            secrets: [secret],
          }),
        secret,
      ).toThrow(/secrets:/);
    }
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
