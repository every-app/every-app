/**
 * The gateway's deploy API for end-to-end tests, standing in for
 * GatewayClient: the registry lives in the gateway's D1 inside
 * FakeCloudflare, so the CLI's reconcile reads the same rows the
 * registrations write, activation succeeds only once the deployed gateway
 * binds the app's Worker, and new hostnames follow the deployed gateway's
 * APP_BASE_DOMAIN as the real one's do (`<app>.<base>` for the install's
 * organization; `<app>-<org>.<host>` without one).
 */
import { createHash, randomUUID } from "node:crypto";
import { resourceNameFor } from "@every-app/perimeter/manifest";
import {
  GatewayApiError,
  type GatewayClient,
} from "@/lib/gateway/api";
import type { FakeCloudflare } from "./fakeCloudflare";

export const GATEWAY_URL = "https://example.com";
const ORG = { id: "org-1", name: "Acme", slug: "acme" };
/** How long after the claim SetupService hands the CLI its deploy token. */
const DEPLOY_TOKEN_RETRIEVAL_WINDOW_MS = 30 * 60 * 1000;
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
  /** The gateway's clock, for setup links' expiry and the claim's window. */
  now: () => number = () => Date.now();

  /** The apps whose agent tools the CLI asked the gateway to sync, in order. */
  readonly toolSyncs: string[] = [];

  constructor(
    private readonly account: FakeCloudflare,
    /** The gateway's own host. */
    readonly gatewayHost = "example.com",
  ) {}

  get gatewayUrl(): string {
    return `https://${this.gatewayHost}`;
  }

  /** What the deployed gateway's APP_BASE_DOMAIN says, if it has one. */
  private appBaseDomain(): string | null {
    return (
      this.account.workers.get("every-app-gateway")?.config["env"]?.APP_BASE_DOMAIN
        ?.value ?? null
    );
  }

  private get db() {
    return this.account.database("every-app-gateway");
  }

  /**
   * What a person does on the gateway's /setup page with a setup link, as
   * SetupService.claimOwner answers: a link that is unspent and unexpired,
   * while the gateway has no owner, is spent, and its owner, organization
   * and membership exist. Anything else is refused.
   */
  claim(setupUrl: string): void {
    const token = new URL(setupUrl).hash.replace(/^#token=/, "");
    const hash = createHash("sha256").update(token).digest("hex");
    const link = this.db.all(
      "SELECT id FROM owner_setup_tokens WHERE kind = 'claim' AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
      hash,
      this.now(),
    )[0];
    if (!link) {
      throw new Error(
        "INVALID_OR_EXPIRED_SETUP_LINK: that setup link is spent, expired or unknown",
      );
    }
    if (this.db.all("SELECT 1 FROM members WHERE role = 'owner'").length > 0) {
      throw new Error("ALREADY_CLAIMED: the gateway has an owner");
    }
    this.seedOrganization();
    this.db.sqlite.exec(`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('owner-1', 'Owner', 'owner@example.com', 0, 0, 0);
      INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('member-1', '${ORG.id}', 'owner-1', 'owner', 0);
    `);
    this.db.sqlite
      .prepare("UPDATE owner_setup_tokens SET consumed_at = ?, consumed_by = 'owner-1' WHERE id = ?")
      .run(this.now(), String(link["id"]));
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
      gateway: {
        release: null,
        gatewayHost: this.gatewayHost,
        appBaseDomain: this.appBaseDomain(),
      },
      minCli: "0.3.0",
      minSdk: "0.3.0",
      capabilities: { appGateway: true, deployProtocol: 2 },
    }),

    getIdentityKeys: async () => ({ issuer: this.gatewayUrl, keys: [PUBLIC_KEY] }),

    // POST /api/setup/deploy-token, as SetupService.retrieveDeployToken
    // answers: pending (202) until the link is claimed while it lasts, the
    // token once within 30 minutes of the claim, else a 404.
    setupDeployToken: async (cliSecret: string) => {
      const now = this.now();
      const hash = createHash("sha256").update(cliSecret).digest("hex");
      const link = cliSecret.startsWith("ecs_")
        ? this.db.all(
            "SELECT id, expires_at, consumed_at, consumed_by FROM owner_setup_tokens WHERE kind = 'claim' AND cli_secret_hash = ? AND deploy_token_issued_at IS NULL",
            hash,
          )[0]
        : undefined;
      const consumedAt = link?.["consumed_at"];
      if (link && consumedAt === null && Number(link["expires_at"]) > now) {
        return { status: "pending" as const };
      }
      if (
        !link ||
        consumedAt === null ||
        !link["consumed_by"] ||
        Number(consumedAt) < now - DEPLOY_TOKEN_RETRIEVAL_WINDOW_MS
      ) {
        throw new GatewayApiError({
          message: "This setup link is invalid, expired or already used.",
          status: 404,
          code: "INVALID_OR_EXPIRED_SETUP_LINK",
        });
      }
      this.db.sqlite
        .prepare("UPDATE owner_setup_tokens SET deploy_token_issued_at = ? WHERE id = ?")
        .run(now, String(link["id"]));
      const owner = this.db.all(
        "SELECT email FROM users WHERE id = ?",
        String(link["consumed_by"]),
      )[0];
      return {
        token: "eak_from-the-setup-link",
        organizationId: ORG.id,
        organizationName: ORG.name,
        ownerEmail: owner ? String(owner["email"]) : null,
      };
    },

    registerApp: async (payload: { appId: string; name: string; description: string; manifest: unknown }) => {
      const existing = this.app(payload.appId);
      const legacy = existing?.legacy_names === 1;
      const workerName =
        existing?.worker_name ??
        (legacy ? `every-${payload.appId}` : `every-${this.orgKey()}-${payload.appId}`);
      const base = this.appBaseDomain();
      // The seeded organization is the install's own.
      const hostname =
        existing?.hostname ??
        (base ? `${payload.appId}.${base}` : `${payload.appId}-${ORG.slug}.${this.gatewayHost}`);
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

    syncAppTools: async (appId: string) => {
      const app = this.app(appId);
      if (!app || app.status === "deleted") this.notFound(appId);
      if (!this.account.gatewayBindings().includes(app.worker_name)) {
        throw new GatewayApiError({
          message: "binding rolling out",
          status: 503,
          code: "BINDING_NOT_READY",
        });
      }
      this.toolSyncs.push(appId);
      return {
        appId,
        status: "ok",
        toolCount: 2,
        catalogHash: "sha256:fake",
        sdkVersion: "0.3.0",
        warnings: [],
      };
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
