import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILD_SENTINEL,
  everyAppAuxiliaryWorker,
  everyAppWorker,
  resourceSentinel,
} from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAppBuildOutput,
  installWorkerConfig,
  type InstallTarget,
} from "./installBuildOutput";

const PUBLIC_KEYS = [
  "-----BEGIN PUBLIC KEY-----\nMIIBcurrent\n-----END PUBLIC KEY-----\n",
  "-----BEGIN PUBLIC KEY-----\nMIIBnext\n-----END PUBLIC KEY-----\n",
];

const MANIFEST = {
  id: "seo",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    r2: ["R2", "MEDIA"],
    hyperdrive: [{ name: "HYPERDRIVE" }],
    durableObjects: [
      { name: "CHAT", className: "ChatAgent" },
      { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
    ],
    workflows: [
      { name: "RANK_CHECK", className: "RankCheckWorkflow" },
      { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
    ],
  },
  workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
} as const;

const TARGET: InstallTarget = {
  workerName: "every-acme-seo",
  organizationId: "org-acme",
  gatewayUrl: "https://apps.example.com",
  identityPublicKeys: PUBLIC_KEYS,
  resources: {
    d1: { DB: { name: "every-acme-seo", id: "d1-uuid" } },
    kv: { KV: { id: "kv-id" } },
    hyperdrive: { HYPERDRIVE: { id: "hd-id" } },
    r2: {
      R2: { name: "every-acme-seo" },
      MEDIA: { name: "every-acme-seo--media" },
    },
  },
  helperWorkers: ["every-acme-seo--audit"],
};

/** What `cf build` writes for the app's Worker and its helper: tenant-neutral. */
function build(): { app: Record<string, any>; audit: Record<string, any> } {
  const options = { manifest: MANIFEST, ctx: { mode: "production" } } as const;
  const { entrypoint: _app, ...app } = everyAppWorker({
    ...options,
    entrypoint: "./src/entry.worker.ts",
  });
  const { entrypoint: _audit, ...audit } = everyAppAuxiliaryWorker({
    ...options,
    worker: "audit",
    entrypoint: "./src/audit.ts",
  });
  const bundle = { type: "partial", mainModule: "index.js", modules: {} };
  return {
    app: { ...structuredClone(app), manifest: bundle },
    audit: { ...structuredClone(audit), manifest: bundle },
  };
}

beforeEach(() => {
  vi.stubEnv("EVERYAPP_BUILD", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("installWorkerConfig", () => {
  it("installs the app's Worker: its name, identity, gateway and every resource", () => {
    const { app } = build();
    const installed = installWorkerConfig(app, TARGET);

    expect(installed["name"]).toBe("every-acme-seo");
    expect(installed["env"]).toMatchObject({
      EVERYAPP_APP_ID: { type: "text", value: "seo" },
      EVERYAPP_AUDIENCE: { type: "text", value: "every-acme-seo" },
      EVERYAPP_IDENTITY_PUBLIC_KEYS: {
        type: "text",
        value: JSON.stringify(PUBLIC_KEYS),
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
          organizationId: "org-acme",
          appId: "seo",
          workerName: "every-acme-seo",
        },
      },
      GATEWAY_URL: { type: "secret" },
      EVERY_APP_ORG_ID: { type: "secret" },
      DB: { type: "d1", name: "every-acme-seo", id: "d1-uuid" },
      KV: { type: "kv", id: "kv-id" },
      HYPERDRIVE: { type: "hyperdrive", id: "hd-id" },
      R2: { type: "r2", name: "every-acme-seo" },
      MEDIA: { type: "r2", name: "every-acme-seo--media" },
      CHAT: {
        type: "durable-object",
        worker: "every-acme-seo",
        exportName: "ChatAgent",
      },
      SCRATCHPAD: {
        type: "durable-object",
        worker: "every-acme-seo--audit",
        exportName: "Scratchpad",
      },
      RANK_CHECK: {
        type: "workflow",
        name: "every-acme-seo--rank-check",
        worker: "every-acme-seo",
      },
      SITE_AUDIT: {
        type: "workflow",
        name: "every-acme-seo--site-audit",
        worker: "every-acme-seo--audit",
      },
      AUDIT_ENGINE: { type: "worker", worker: "every-acme-seo--audit" },
    });
    expect(installed["exports"]).toEqual({
      ChatAgent: { type: "durable-object", storage: "sqlite" },
      RankCheckWorkflow: {
        type: "workflow",
        name: "every-acme-seo--rank-check",
      },
    });
    expect(JSON.stringify(installed)).not.toContain("sentinel");
    // A copy: the build it was given is as it was.
    expect(app["name"]).toBe(BUILD_SENTINEL.workerName);
  });

  it("installs a helper Worker under its own name, with the app's identity", () => {
    const { audit } = build();
    const installed = installWorkerConfig(audit, TARGET);

    expect(installed["name"]).toBe("every-acme-seo--audit");
    expect(installed["env"]).toMatchObject({
      EVERY_APP_GATEWAY: {
        props: {
          organizationId: "org-acme",
          appId: "seo",
          workerName: "every-acme-seo",
        },
      },
      DB: { type: "d1", name: "every-acme-seo", id: "d1-uuid" },
      SCRATCHPAD: { worker: "every-acme-seo--audit" },
    });
    expect(installed["exports"]).toEqual({
      Scratchpad: { type: "durable-object", storage: "sqlite" },
      SiteAuditWorkflow: {
        type: "workflow",
        name: "every-acme-seo--site-audit",
      },
    });
  });

  it("gives a shared app's Workers no organization to pin themselves to", () => {
    const { app, audit } = build();
    for (const config of [app, audit]) {
      const env = installWorkerConfig(config, { ...TARGET, shared: true })[
        "env"
      ];
      expect(env).not.toHaveProperty("EVERY_APP_ORG_ID");
      expect(env).toMatchObject({
        EVERYAPP_SHARED: { type: "text", value: "1" },
        GATEWAY_URL: { type: "secret" },
        EVERY_APP_GATEWAY: { props: { organizationId: "org-acme" } },
      });
    }
  });

  it("adds a tombstone for each deleted Durable Object class, on the app's Worker only", () => {
    const { app, audit } = build();
    const target = { ...TARGET, deletedDurableObjects: ["OldSyncDO"] };

    expect(installWorkerConfig(app, target)["exports"]).toMatchObject({
      ChatAgent: { type: "durable-object", storage: "sqlite" },
      OldSyncDO: { type: "durable-object", state: "deleted" },
    });
    expect(installWorkerConfig(audit, target)["exports"]).not.toHaveProperty(
      "OldSyncDO",
    );
    expect(() =>
      installWorkerConfig(app, { ...TARGET, deletedDurableObjects: ["ChatAgent"] }),
    ).toThrow(expect.objectContaining({ code: "APP_POLICY" }));
  });

  it("refuses a resource the build binds but the deploy didn't provision, naming it", () => {
    const { app } = build();
    const { KV: _kv, ...kv } = TARGET.resources.kv ?? {};
    expect(() =>
      installWorkerConfig(app, {
        ...TARGET,
        resources: { ...TARGET.resources, kv },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INSTALL_INPUTS_MISSING",
        message: expect.stringContaining("KV namespace KV"),
      }),
    );
  });

  it("leaves a resource bound by hand for the policy to judge", () => {
    const { app } = build();
    app["env"].EXTRA = { type: "hyperdrive", id: "h-1" };
    // Named after the Worker by hand, as chef's `bindings.r2({ name: worker.name })`.
    app["env"].BUCKET = { type: "r2", name: BUILD_SENTINEL.workerName };

    const env = installWorkerConfig(app, TARGET)["env"];
    expect(env.EXTRA).toEqual({ type: "hyperdrive", id: "h-1" });
    expect(env.BUCKET).toEqual({ type: "r2", name: "every-acme-seo" });
  });

  it("refuses an output a placeholder survives in", () => {
    const { app } = build();
    app["env"].KEYS = {
      type: "text",
      value: `keys: ${BUILD_SENTINEL.publicKey}`,
    };
    expect(() => installWorkerConfig(app, TARGET)).toThrow(
      expect.objectContaining({
        code: "INSTALL_PLACEHOLDER_LEFT",
        message: expect.stringContaining("env.KEYS.value"),
      }),
    );
  });

  it("writes the install's values as they are, `$` patterns and all", () => {
    const { app } = build();
    const env = installWorkerConfig(app, {
      ...TARGET,
      gatewayUrl: "https://apps.example.com/$&",
    })["env"];
    expect(env.EVERYAPP_IDENTITY_ISSUER.value).toBe(
      "https://apps.example.com/$&",
    );
  });

  it("refuses a Workflow whose installed name is over Cloudflare's limit", () => {
    const { app } = build();
    expect(() =>
      installWorkerConfig(app, {
        ...TARGET,
        workerName: `every-${"a".repeat(50)}`,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "WORKFLOW_NAME_TOO_LONG",
        message: expect.stringContaining("RANK_CHECK"),
      }),
    );
  });

  it("knows the placeholders the SDK builds with", () => {
    const { app } = build();
    expect(app["env"].DB).toEqual({
      type: "d1",
      name: resourceSentinel("DB"),
      id: resourceSentinel("DB"),
    });
    expect(app["env"].EVERYAPP_IDENTITY_ISSUER.value).toBe(
      BUILD_SENTINEL.gatewayUrl,
    );
  });
});

describe("installAppBuildOutput", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-install-"));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("installs every Worker of the Build Output in place", async () => {
    const { app, audit } = build();
    const workers = path.join(cwd, ".cloudflare/output/v0/workers");
    const write = (dir: string, config: object) => {
      fs.mkdirSync(path.join(workers, dir), { recursive: true });
      fs.writeFileSync(
        path.join(workers, dir, "worker.config.json"),
        JSON.stringify(config),
      );
    };
    write("default", app);
    write(String(audit["name"]), audit);

    await installAppBuildOutput({ cwd, target: TARGET });

    const read = (dir: string) =>
      JSON.parse(
        fs.readFileSync(path.join(workers, dir, "worker.config.json"), "utf8"),
      ) as Record<string, unknown>;
    expect(read("default")).toEqual(installWorkerConfig(app, TARGET));
    expect(read(String(audit["name"]))).toEqual(
      installWorkerConfig(audit, TARGET),
    );
  });
});
