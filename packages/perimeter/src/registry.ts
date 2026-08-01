/**
 * The app registry — the gateway's source of truth for routing and policy.
 *
 * A registered app is a row in the gateway D1 `apps` table. This module defines
 * the small read interface the perimeter depends on, decoupled from Drizzle so
 * the proxy core can be unit-tested with an in-memory registry and run for real
 * against D1 in production / under miniflare.
 */
import { validateManifest, type Manifest } from "./manifest/manifest";

export type Tier = "service_binding" | "dispatch";
export type AppStatus = "active" | "disabled" | "deploying";

export interface RegisteredApp {
  /** Stable app id and first DNS label, e.g. `todo`. */
  appId: string;
  /** Full routing hostname, e.g. `todo.example.com` (unique). */
  hostname: string;
  /** Service-binding / script name, e.g. `every-todo-app`. */
  workerName: string;
  tier: Tier;
  organizationId: string;
  status: AppStatus;
  /** Parsed manifest snapshot taken at deploy time. */
  manifest: Manifest;
}

export interface AppRegistry {
  hasAnyActiveApp(): Promise<boolean>;
  findByHostname(hostname: string): Promise<RegisteredApp | null>;
  findByAppId(appId: string): Promise<RegisteredApp | null>;
  findByOrgApp(
    organizationId: string,
    appId: string,
  ): Promise<RegisteredApp | null>;
}

/** Row shape as stored in D1 (manifest is a JSON string column). */
export interface AppRegistryRow {
  appId: string;
  hostname: string;
  workerName: string;
  tier: string;
  organizationId: string;
  status: string;
  manifest: string;
}

export function rowToRegisteredApp(row: AppRegistryRow): RegisteredApp {
  const status =
    row.status === "active" ||
    row.status === "disabled" ||
    row.status === "deploying"
      ? row.status
      : "disabled";

  return {
    appId: row.appId,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier === "dispatch" ? "dispatch" : "service_binding",
    organizationId: row.organizationId,
    status,
    manifest: validateManifest(JSON.parse(row.manifest)),
  };
}

/** In-memory registry, used by unit tests and the dev gateway seed. */
export class InMemoryAppRegistry implements AppRegistry {
  private byHostname = new Map<string, RegisteredApp>();
  private byAppId = new Map<string, RegisteredApp>();
  private byOrgApp = new Map<string, RegisteredApp>();

  constructor(apps: RegisteredApp[] = []) {
    for (const app of apps) this.add(app);
  }

  add(app: RegisteredApp): void {
    this.byHostname.set(app.hostname.toLowerCase(), app);
    this.byAppId.set(app.appId, app);
    this.byOrgApp.set(orgAppKey(app.organizationId, app.appId), app);
  }

  async findByHostname(hostname: string): Promise<RegisteredApp | null> {
    return this.byHostname.get(hostname.toLowerCase()) ?? null;
  }

  async hasAnyActiveApp(): Promise<boolean> {
    return Array.from(this.byAppId.values()).some(
      (app) => app.status === "active",
    );
  }

  async findByAppId(appId: string): Promise<RegisteredApp | null> {
    return this.byAppId.get(appId) ?? null;
  }

  async findByOrgApp(
    organizationId: string,
    appId: string,
  ): Promise<RegisteredApp | null> {
    return this.byOrgApp.get(orgAppKey(organizationId, appId)) ?? null;
  }
}

function orgAppKey(organizationId: string, appId: string): string {
  return JSON.stringify([organizationId, appId]);
}
