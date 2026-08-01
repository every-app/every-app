import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_DATE,
  ensureGeneratedWranglerConfig,
  generateWranglerConfig,
  resourceNameFor,
} from "./generateWranglerConfig";

describe("generateWranglerConfig", () => {
  it("emits the private worker config Vite and Wrangler consume", () => {
    const cfg = generateWranglerConfig({
      id: "todo",
      main: "src/worker.ts",
      devPort: 3010,
      resources: {
        d1: ["DB", "AUDIT_DB"],
        kv: ["KV", "CACHE"],
        durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
      },
      public: [],
    });

    expect(cfg).toMatchObject({
      name: "every-todo",
      main: "../src/worker.ts",
      workers_dev: false,
      preview_urls: false,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true },
      dev: { port: 3010 },
      vars: { EVERYAPP_APP_ID: "todo" },
    });
    expect(cfg).not.toHaveProperty("routes");
    expect(cfg).not.toHaveProperty("services");
    expect(cfg.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "every-todo",
        database_id: "every-todo",
        migrations_dir: "../drizzle",
      },
      {
        binding: "AUDIT_DB",
        database_name: "every-todo-audit_db",
        database_id: "every-todo-audit_db",
        migrations_dir: "../drizzle",
      },
    ]);
    expect(cfg.kv_namespaces).toEqual([
      { binding: "KV" },
      { binding: "CACHE" },
    ]);
    expect(cfg.durable_objects?.bindings).toEqual([
      { name: "USER_SYNC", class_name: "UserSyncDO" },
    ]);
    expect(cfg.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["UserSyncDO"] },
    ]);
  });

  it("emits a package-specifier main verbatim", () => {
    const cfg = generateWranglerConfig({
      id: "chef",
      main: "@tanstack/react-start/server-entry",
    });

    expect(cfg.main).toBe("@tanstack/react-start/server-entry");
  });

  it("injects provisioned resource IDs and identity vars", () => {
    const cfg = generateWranglerConfig(
      {
        id: "todo",
        resources: {
          d1: ["DB"],
          kv: ["KV"],
        },
      },
      {
        d1DatabaseIds: { DB: "d1-id" },
        kvNamespaceIds: { KV: "kv-id" },
        identityPublicKeys: ["pem-a", "pem-b"],
        vars: {
          EVERYAPP_APP_ID: "wrong-audience",
          EVERYAPP_IDENTITY_ISSUER: "https://example.com",
        },
      },
    );

    expect(cfg.d1_databases?.[0]?.database_id).toBe("d1-id");
    expect(cfg.kv_namespaces?.[0]?.id).toBe("kv-id");
    expect(cfg.vars).toEqual({
      EVERYAPP_APP_ID: "todo",
      EVERYAPP_IDENTITY_ISSUER: "https://example.com",
      EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify(["pem-a", "pem-b"]),
    });
  });

  it("uses the manifest directory for Wrangler SQL migrations", () => {
    const cfg = generateWranglerConfig({
      id: "todo",
      resources: { d1: ["DB"] },
      migrations: { engine: "d1-sql", dir: "migrations" },
    });

    expect(cfg.d1_databases?.[0]?.migrations_dir).toBe("../migrations");
  });

  it("honors a validated manifest compatibilityDate override", () => {
    const cfg = generateWranglerConfig({
      id: "todo",
      compatibilityDate: "2026-07-01",
    });

    expect(cfg.compatibility_date).toBe("2026-07-01");
  });

  it("emits the production gateway binding with registry-verifiable props", () => {
    const cfg = generateWranglerConfig(
      { id: "chef", providers: ["openai"] },
      { gatewayBinding: { organizationId: "org-123" } },
    );

    expect(cfg.services).toEqual([
      {
        binding: "EVERY_APP_GATEWAY",
        service: "every-app-gateway",
        entrypoint: "AppGateway",
        props: {
          organizationId: "org-123",
          appId: "chef",
          workerName: "every-chef",
        },
      },
    ]);
    expect(JSON.stringify(cfg.services)).not.toContain("token");
    expect(JSON.stringify(cfg.services)).not.toContain("secret");
  });

  it("fails rather than emitting a binding with missing organization identity", () => {
    expect(() =>
      generateWranglerConfig(
        { id: "chef" },
        { gatewayBinding: { organizationId: "  " } },
      ),
    ).toThrow(/organization id/);
  });

  it("uses one centralized resource naming helper", () => {
    expect(resourceNameFor("todo")).toBe("every-todo");
    expect(resourceNameFor("todo", "DB")).toBe("every-todo");
    expect(resourceNameFor("todo", "KV")).toBe("every-todo");
    expect(resourceNameFor("todo", "CACHE")).toBe("every-todo-cache");
  });
});

describe("ensureGeneratedWranglerConfig", () => {
  it("writes .everyapp/wrangler.json and gitignores the generated directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-config-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "everyapp.config.ts"),
        [
          "export default {",
          '  id: "todo",',
          '  main: "src/entry.worker.ts",',
          '  resources: { d1: ["DB"] },',
          "  devPort: 3009,",
          "} as const;",
          "",
        ].join("\n"),
        "utf-8",
      );

      const { manifest, config, configPath } =
        await ensureGeneratedWranglerConfig(tmpDir);
      const generated = await fs.readFile(configPath, "utf-8");
      const gitignore = await fs.readFile(
        path.join(tmpDir, ".gitignore"),
        "utf-8",
      );

      expect(manifest.id).toBe("todo");
      expect(configPath).toBe(path.join(tmpDir, ".everyapp", "wrangler.json"));
      expect(generated).toContain(
        "// generated from everyapp.config.ts — do not edit",
      );
      expect(generated).toContain('"name": "every-todo"');
      expect(generated).toContain('"port": 3009');
      expect(config).not.toHaveProperty("services");
      expect(generated).not.toContain("EVERY_APP_GATEWAY");
      expect(gitignore).toContain(".everyapp/");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
