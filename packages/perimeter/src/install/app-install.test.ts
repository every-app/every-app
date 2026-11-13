/**
 * The install engine with in-memory ports: what the CLI (`cf`) and the
 * Gateway's browser installs (REST) both run. The CLI's deploy tests drive
 * it through `cf`; these pin the order of its steps and its refusals
 * without either runtime.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  everyAppAuxiliaryWorker,
  everyAppWorker,
} from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "@every-app/perimeter/manifest";
import {
  installApp,
  type AppInstallInput,
  type AppInstallPorts,
} from "./app-install";
import type { InstallationDatabase } from "./error";
import { recordOwnedResource } from "./ownership";
import type { BuiltWorkerConfig } from "./policy";
import { largeManifest } from "../manifest/workerManifest.fixture";

const KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";
const WORKER = "every-acme-todo";
const HELPER = `${WORKER}--audit`;
const D1_ID = "11111111-2222-4333-8444-555555555555";

const MANIFEST = {
  id: "todo",
  resources: {
    d1: ["DB"],
    workflows: [
      { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
    ],
  },
  workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  settings: [
    { name: "THEME", why: "The app's color scheme.", default: "dark" },
  ],
} as const;

function sqliteDb(): InstallationDatabase {
  const sqlite = new DatabaseSync(":memory:");
  return {
    run: async (statements) =>
      statements.map(({ sql, params = [] }) =>
        (
          sqlite.prepare(sql).all(...(params as SQLInputValue[])) as Record<
            string,
            unknown
          >[]
        ).map((row) => ({ ...row })),
      ),
  };
}

/** What `cf build` writes for MANIFEST: tenant-neutral, by directory. */
function buildOutput(
  manifest: Parameters<typeof everyAppWorker>[0]["manifest"] = MANIFEST,
): Map<string, BuiltWorkerConfig> {
  const options = {
    manifest,
    ctx: { mode: "production" },
    root: "/app",
  } as const;
  const bundle = { type: "partial", mainModule: "index.js", modules: {} };
  const { entrypoint: _app, ...app } = everyAppWorker({
    ...options,
    entrypoint: "./src/entry.worker.ts",
  });
  const built = (config: object) =>
    ({ ...structuredClone(config), manifest: bundle }) as BuiltWorkerConfig;
  const workers = new Map([["default", built(app)]]);
  if ((manifest as { workers?: unknown[] }).workers?.length) {
    const { entrypoint: _helper, ...helper } = everyAppAuxiliaryWorker({
      ...options,
      worker: "audit",
      entrypoint: "./src/audit.ts",
    });
    workers.set("audit", built(helper));
  }
  return workers;
}

let steps: string[];
let workflows: Map<string, { script_name: string }>;
let secrets: Map<string, string[]>;
let db: InstallationDatabase;

function setup(
  overrides: Partial<AppInstallInput> = {},
  output = () => buildOutput(),
) {
  const uploads: Array<{ worker: string; values: Record<string, string> }> = [];
  const input: AppInstallInput = {
    manifest: MANIFEST as unknown as Manifest,
    previousManifest: null,
    workerName: WORKER,
    resources: { d1: { DB: WORKER }, kv: {}, r2: {} },
    recordedVersionId: null,
    organizationId: "org-1",
    accountId: "0123456789abcdef0123456789abcd01",
    gatewayUrl: "https://apps.example.com",
    gatewayWorker: "every-app-gateway",
    identityPublicKeys: [KEY],
    readEmail: async () => ({ inbound: [], senders: [] }),
    sendersSettable: false,
    interactive: false,
    ...overrides,
  };
  const ports: AppInstallPorts<"cf"> = {
    cf: "cf",
    db,
    out: { emit: () => undefined },
    CLI: "everyapp",
    thisCommand: () => "",
    resources: {
      claimAppWorker: async (
        _options: unknown,
        helper?: { workerName: string },
      ) => {
        steps.push(`claim ${helper?.workerName ?? WORKER}`);
      },
      provisionAppResources: async () => {
        steps.push("provision");
        return { d1: { DB: { name: WORKER, id: D1_ID } } };
      },
      ensureAppBuckets: async () => [],
    } as unknown as AppInstallPorts<"cf">["resources"],
    email: {
      emailDeclarations: () => ({ receives: false, sends: false }),
      planEmailRoutes: async () => null,
    } as unknown as AppInstallPorts<"cf">["email"],
    getWorkflow: async (_cf, name) => workflows.get(name) ?? null,
    deleteWorkflow: async (_cf, name) => {
      steps.push(`delete workflow ${name}`);
      workflows.delete(name);
    },
    workerSecretNames: async (_cf, name) => secrets.get(name) ?? [],
    readBuildOutput: async () => output(),
    writeBuildOutput: async () => undefined,
    replaceable: async ({ workerName }) => {
      steps.push(`replaceable ${workerName}`);
    },
    migrate: async (resources) => {
      steps.push(`migrate ${resources.d1?.["DB"]?.id}`);
    },
    upload: async (worker, values) => {
      steps.push(`upload ${worker.workerName}`);
      uploads.push({ worker: worker.workerName, values: { ...values } });
      return `v-${worker.workerName}`;
    },
    checkpoint: async () => undefined,
  };
  return { input, ports, uploads };
}

beforeEach(() => {
  vi.stubEnv("EVERYAPP_BUILD", "1");
  steps = [];
  workflows = new Map();
  secrets = new Map();
  db = sqliteDb();
});
afterEach(() => vi.unstubAllEnvs());

describe("installApp", () => {
  it("claims, provisions, checks, migrates, then uploads the helper before the app's Worker", async () => {
    const { input, ports, uploads } = setup();
    const result = await installApp(input, ports);
    expect(steps).toEqual([
      `claim ${WORKER}`,
      `claim ${HELPER}`,
      "provision",
      `replaceable ${WORKER}`,
      `replaceable ${HELPER}`,
      `migrate ${D1_ID}`,
      `upload ${HELPER}`,
      `upload ${WORKER}`,
    ]);
    expect(result.versionId).toBe(`v-${WORKER}`);
    // Every Worker's version names the Gateway and the organization, with
    // the defaults of the settings the Worker doesn't hold.
    for (const upload of uploads)
      expect(upload.values).toEqual({
        THEME: "dark",
        GATEWAY_URL: "https://apps.example.com",
        EVERY_APP_ORG_ID: "org-1",
      });
    // The Build Output was installed for this deploy.
    expect(result.target.resources.d1?.["DB"]?.id).toBe(D1_ID);
  });

  it("never replaces a setting the Worker holds, and sends the install form's values", async () => {
    secrets.set(WORKER, ["THEME", "GATEWAY_URL"]);
    const { input, ports, uploads } = setup({ values: { API_KEY: "k" } });
    const result = await installApp(input, ports);
    expect(uploads[0]!.values).toEqual({
      API_KEY: "k",
      GATEWAY_URL: "https://apps.example.com",
      EVERY_APP_ORG_ID: "org-1",
    });
    // The reserved names are everyapp's, not the app's.
    expect(result.secretNames).toEqual(["THEME"]);
  });

  it("generates each top-level generated secret the Worker doesn't hold, and never one a person pastes or a feature's", async () => {
    const manifest = {
      ...MANIFEST,
      secrets: [
        { name: "SECRETS_KEY", generate: true },
        { name: "HELD_KEY", generate: true },
        {
          name: "WEBHOOK_SECRET",
          generate: true,
          how: "Paste it into the webhook",
        },
      ],
      features: {
        slack: {
          name: "Slack",
          why: "Slack.",
          secrets: [{ name: "SLACK_KEY", generate: true }],
        },
      },
    } as unknown as Manifest;
    secrets.set(WORKER, ["HELD_KEY"]);
    const { input, ports, uploads } = setup({ manifest });
    await installApp(input, ports);
    const values = uploads.find((upload) => upload.worker === WORKER)!.values;
    expect(values["SECRETS_KEY"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(values).not.toHaveProperty("HELD_KEY");
    expect(values).not.toHaveProperty("WEBHOOK_SECRET");
    expect(values).not.toHaveProperty("SLACK_KEY");
    // The helper gets the same value with the same version.
    expect(
      uploads.find((upload) => upload.worker === HELPER)!.values["SECRETS_KEY"],
    ).toBe(values["SECRETS_KEY"]);
  });

  /** `output` as an SDK that still declared the manifest built it. */
  const withManifestBinding = (
    output: Map<string, BuiltWorkerConfig>,
    manifest: unknown,
  ) => {
    output.get("default")!.env!["EVERYAPP_MANIFEST"] = {
      type: "json",
      value: manifest,
    };
    return output;
  };

  it("installs a manifest well over 5 kB: a build made today holds no copy of it", async () => {
    const manifest = { ...largeManifest(), resources: { d1: ["DB"] } };
    let written: BuiltWorkerConfig | undefined;
    const { input, ports } = setup(
      { manifest: manifest as unknown as Manifest },
      () => buildOutput(manifest),
    );
    ports.writeBuildOutput = async (workers) => {
      written = workers[0]!.config;
    };
    await installApp(input, ports);
    expect(JSON.stringify(manifest).length).toBeGreaterThan(7000);
    expect(steps).toContain(`upload ${WORKER}`);
    expect(written!.env).not.toHaveProperty("EVERYAPP_MANIFEST");
  });

  it("installs an older build of a manifest well over 5 kB: its Worker gets it without its setup text", async () => {
    const manifest = { ...largeManifest(), resources: { d1: ["DB"] } };
    let written: BuiltWorkerConfig | undefined;
    const { input, ports } = setup(
      { manifest: manifest as unknown as Manifest },
      () => withManifestBinding(buildOutput(manifest), manifest),
    );
    ports.writeBuildOutput = async (workers) => {
      written = workers[0]!.config;
    };
    await installApp(input, ports);
    expect(steps).toContain(`upload ${WORKER}`);
    const held = (
      written!.env!["EVERYAPP_MANIFEST"] as { value: typeof manifest }
    ).value;
    expect(JSON.stringify(held).length).toBeLessThanOrEqual(5000);
    expect(held.settings.map((setting) => setting.name)).toEqual(
      manifest.settings.map((setting) => setting.name),
    );
  });

  it("refuses an older build whose manifest no Worker can hold before it claims or creates anything", async () => {
    const manifest = {
      id: "todo",
      public: Array.from({ length: 300 }, (_, index) => ({
        path: `/a/rather/long/public/path/${index}`,
      })),
    };
    const { input, ports } = setup(
      { manifest: manifest as unknown as Manifest },
      () => withManifestBinding(buildOutput(), manifest),
    );
    await expect(installApp(input, ports)).rejects.toMatchObject({
      code: "INVALID_MANIFEST",
      message: expect.stringContaining("holds 5,000 at most"),
    });
    expect(steps).toEqual([]);
  });

  it("refuses a Worker the policy refuses before it migrates or uploads anything", async () => {
    const { input, ports } = setup({}, () => {
      const output = buildOutput();
      output.get("default")!.workersDev = true;
      return output;
    });
    await expect(installApp(input, ports)).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining("workersDev"),
    });
    expect(steps.filter((step) => /migrate|upload/.test(step))).toEqual([]);
  });

  it("says which R2 buckets it created", async () => {
    const events: unknown[] = [];
    const { input, ports } = setup({}, () => {
      const output = buildOutput();
      output.get("default")!.env = {
        ...output.get("default")!.env,
        FILES: { type: "r2", name: WORKER },
        CACHE: { type: "r2", name: `${WORKER}--cache` },
      };
      return output;
    });
    ports.out = { emit: (event) => void events.push(event) };
    ports.resources.ensureAppBuckets = async ({ names }) => {
      steps.push(`buckets ${names.join(" ")}`);
      return [WORKER];
    };
    await installApp(input, ports);
    expect(steps).toContain(`buckets ${WORKER} ${WORKER}--cache`);
    expect(
      events.filter(
        (event) => (event as { step?: string }).step === "app.build",
      ),
    ).toEqual([
      {
        type: "progress",
        step: "app.build",
        message: `Created R2 bucket "${WORKER}".`,
        data: { bucket: WORKER },
      },
    ]);
  });

  it("refuses a Workflow name another Worker runs", async () => {
    workflows.set(`${WORKER}--site-audit`, { script_name: "every-acme-other" });
    const { input, ports } = setup();
    await expect(installApp(input, ports)).rejects.toMatchObject({
      code: "WORKFLOW_NAME_TAKEN",
    });
    expect(steps.filter((step) => /migrate|upload/.test(step))).toEqual([]);
  });

  describe("a Workflow the manifest dropped", () => {
    const previous = MANIFEST as unknown as Manifest;
    const manifest = {
      id: "todo",
      resources: { d1: ["DB"] },
      workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
    };
    const dropped = `${WORKER}--site-audit`;

    it("is refused without the person's say-so, before anything is created", async () => {
      workflows.set(dropped, { script_name: HELPER });
      const { input, ports } = setup(
        {
          manifest: manifest as unknown as Manifest,
          previousManifest: previous,
        },
        () => buildOutput(manifest),
      );
      await expect(installApp(input, ports)).rejects.toMatchObject({
        code: "WORKFLOW_REMOVED",
      });
      expect(steps).toEqual([]);
    });

    it("is deleted once the upload is live, with it", async () => {
      workflows.set(dropped, { script_name: HELPER });
      const { input, ports } = setup(
        {
          manifest: manifest as unknown as Manifest,
          previousManifest: previous,
          allowDeleteWorkflows: true,
        },
        () => buildOutput(manifest),
      );
      await installApp(input, ports);
      expect(steps.slice(-2)).toEqual([
        `upload ${WORKER}`,
        `delete workflow ${dropped}`,
      ]);
    });
  });

  it("asks whether a Worker may be replaced with the versions EveryApp recorded", async () => {
    await recordOwnedResource(db, WORKER, {
      kind: "worker",
      binding: "",
      name: WORKER,
      resourceId: WORKER,
    });
    await db.run([
      {
        sql: "UPDATE _everyapp_app_resources SET version_id = 'v-own' WHERE kind = 'worker'",
      },
    ]);
    const asked: unknown[] = [];
    const { input, ports } = setup({ recordedVersionId: "v-registry" });
    ports.replaceable = async (worker) => void asked.push(worker);
    await installApp(input, ports);
    expect(asked[0]).toEqual({
      workerName: WORKER,
      shownAs: "todo",
      recordedVersionIds: ["v-registry", "v-own"],
    });
  });
});
