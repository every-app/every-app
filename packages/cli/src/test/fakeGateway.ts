/**
 * The gateway's deploy API for end-to-end tests, standing in for
 * GatewayClient: the registry lives in the gateway's D1 inside
 * FakeCloudflare, so the CLI's reconcile reads the same rows the
 * registrations write, and activation succeeds only once the deployed
 * gateway binds the app's Worker.
 */
import { randomUUID } from "node:crypto";
import { resourceNameFor } from "@every-app/perimeter/manifest";
import {
  GatewayApiError,
  type GatewayClient,
} from "@/lib/gateway/api";
import type { FakeCloudflare } from "./fakeCloudflare";

export const GATEWAY_URL = "https://example.com";
const ORG = { id: "org-1", name: "Acme", slug: "acme" };
const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

interface AppRow {
  id: string;
  app_slug: string;
  worker_name: string;
  hostname: string;
  manifest: string | null;
  status: string;
  legacy_names: number;
  version_id: string | null;
}

export class FakeGateway {
  constructor(private readonly account: FakeCloudflare) {}

  private get db() {
    return this.account.database("every-app-gateway");
  }

  /** The organization the deploy token belongs to. */
  seedOrganization(): void {
    this.db.sqlite
      .prepare("INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, 0)")
      .run(ORG.id, ORG.name, ORG.slug);
  }

  app(appId: string): AppRow | undefined {
    return this.db.all(
      "SELECT id, app_slug, worker_name, hostname, manifest, status, legacy_names, version_id FROM apps WHERE organization_id = ? AND app_slug = ?",
      ORG.id,
      appId,
    )[0] as AppRow | undefined;
  }

  private orgKey(): string {
    const row = this.db.all(
      "SELECT org_key FROM organization_keys WHERE organization_id = ?",
      ORG.id,
    )[0];
    if (row) return String(row["org_key"]);
    this.db.sqlite
      .prepare("INSERT INTO organization_keys (organization_id, org_key) VALUES (?, ?)")
      .run(ORG.id, ORG.slug);
    return ORG.slug;
  }

  private resources(workerName: string, manifest: unknown, legacyNames: boolean) {
    const resources = (manifest as { resources?: { d1?: string[]; kv?: string[] } })
      ?.resources;
    const names = (bindings: string[] = []) =>
      Object.fromEntries(
        bindings.map((b) => [b, resourceNameFor(workerName, b, { legacyNames })]),
      );
    return { d1: names(resources?.d1), kv: names(resources?.kv) };
  }

  private notFound(appId: string): never {
    throw new GatewayApiError({
      message: `No app "${appId}"`,
      status: 404,
      code: "APP_NOT_FOUND",
    });
  }

  readonly client = {
    whoami: async () => ({
      organizationId: ORG.id,
      organizationName: ORG.name,
      scopes: ["apps:register", "apps:deploy"],
      accountId: this.account.accountId,
      gateway: { release: null, gatewayHost: "example.com" },
      minCli: "0.3.0",
      minSdk: "0.3.0",
      capabilities: { appGateway: true, deployProtocol: 2 },
    }),

    getIdentityKeys: async () => ({ issuer: GATEWAY_URL, keys: [PUBLIC_KEY] }),

    registerApp: async (payload: { appId: string; name: string; description: string; manifest: unknown }) => {
      const existing = this.app(payload.appId);
      const legacy = existing?.legacy_names === 1;
      const workerName =
        existing?.worker_name ??
        (legacy ? `every-${payload.appId}` : `every-${this.orgKey()}-${payload.appId}`);
      const hostname = existing?.hostname ?? `${payload.appId}-${ORG.slug}.example.com`;
      let status = existing?.status ?? "pending";
      if (!existing) {
        this.db.sqlite
          .prepare(
            "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)",
          )
          .run(randomUUID(), ORG.id, payload.appId, payload.name, payload.description, hostname, workerName, JSON.stringify(payload.manifest));
      } else if (existing.status === "deleted") {
        status = "pending";
        this.db.sqlite
          .prepare("UPDATE apps SET status = 'pending', manifest = ? WHERE id = ?")
          .run(JSON.stringify(payload.manifest), existing.id);
      }
      return {
        appRowId: existing?.id ?? "row",
        appSlug: payload.appId,
        status,
        workerName,
        hostname,
        legacyNames: legacy,
        resources: this.resources(workerName, payload.manifest, legacy),
        previousManifest: existing?.manifest ? JSON.parse(existing.manifest) : null,
        versionId: existing?.version_id ?? null,
        existingApp: Boolean(existing),
        defaultAccess: false,
        grantedUserCount: 1,
      };
    },

    markDeployed: async (appId: string, payload: { versionId: string; manifest: unknown }) => {
      const app = this.app(appId);
      if (!app || app.status === "deleted") this.notFound(appId);
      const status = app.status === "pending" ? "binding" : app.status;
      this.db.sqlite
        .prepare("UPDATE apps SET status = ?, manifest = ?, version_id = ? WHERE id = ?")
        .run(status, JSON.stringify(payload.manifest), payload.versionId, app.id);
      return { status, workerName: app.worker_name, hostname: app.hostname };
    },

    activateApp: async (appId: string) => {
      const app = this.app(appId);
      if (!app || app.status === "deleted") this.notFound(appId);
      if (!this.account.gatewayBindings().includes(app.worker_name)) {
        throw new GatewayApiError({
          message: "not yet",
          status: 409,
          code: "BINDING_NOT_READY",
        });
      }
      this.db.sqlite.prepare("UPDATE apps SET status = 'active' WHERE id = ?").run(app.id);
      return { status: "active", workerName: app.worker_name, hostname: app.hostname };
    },

    status: async () => this.account.gatewayStatus(),

    appInfo: async (appId: string) => {
      const app = this.app(appId);
      if (!app || app.status === "deleted") this.notFound(appId);
      return {
        status: app.status,
        workerName: app.worker_name,
        hostname: app.hostname,
        legacyNames: app.legacy_names === 1,
        resources: this.resources(
          app.worker_name,
          app.manifest && JSON.parse(app.manifest),
          app.legacy_names === 1,
        ),
      };
    },

    deleteApp: async (appId: string) => {
      const app = this.app(appId);
      if (!app) this.notFound(appId);
      this.db.sqlite.prepare("UPDATE apps SET status = 'deleted' WHERE id = ?").run(app.id);
      return {
        status: "deleted",
        workerName: app.worker_name,
        hostname: app.hostname,
        legacyNames: app.legacy_names === 1,
        resources: this.resources(
          app.worker_name,
          app.manifest && JSON.parse(app.manifest),
          app.legacy_names === 1,
        ),
      };
    },
  } as unknown as GatewayClient;
}
