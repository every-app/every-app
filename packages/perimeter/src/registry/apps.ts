/**
 * The app registry — the gateway's source of truth for routing and policy.
 *
 * A registered app is a row in the gateway D1 `apps` table. This module defines
 * the small read interface the perimeter depends on, decoupled from Drizzle so
 * the proxy core can be unit-tested with an in-memory registry and run for real
 * against D1 in production / under miniflare.
 */
import { parseEmailList } from "@every-app/sdk/internal";
import { validateManifest, type Manifest } from "../manifest/manifest";

export type Tier = "service_binding" | "dispatch";

const TIERS: readonly string[] = [
  "service_binding",
  "dispatch",
] satisfies Tier[];

/**
 * `org`: an organization's own app. `shared`: a first-party app the
 * platform organization owns, which members of other organizations may
 * open too (the hosted gateway).
 */
export type AppScope = "org" | "shared";

const APP_SCOPES: readonly string[] = ["org", "shared"] satisfies AppScope[];
/**
 * `pending`: registered, its Worker not uploaded yet. `binding`: uploaded,
 * waiting for the gateway to reach it over a service binding (the first
 * request that does activates it). Both answer "deploying"; `disabled` is
 * switched off.
 */
export type AppStatus = "active" | "disabled" | "pending" | "binding";

const APP_STATUSES: readonly string[] = [
  "active",
  "disabled",
  "pending",
  "binding",
] satisfies AppStatus[];

export interface RegisteredApp {
  /** Stable app id and first DNS label, e.g. `todo`. */
  appId: string;
  /** Full routing hostname, e.g. `todo.example.com` (unique). */
  hostname: string;
  /** Service-binding / script name, e.g. `every-todo-app`. */
  workerName: string;
  tier: Tier;
  scope: AppScope;
  organizationId: string;
  status: AppStatus;
  /** Parsed manifest snapshot taken at deploy time. */
  manifest: Manifest;
  /**
   * The `from` patterns this installation may send as (`apps.email_senders`,
   * set with `everyapp email set --sender`): the manifest declares sending,
   * this says as whom. Absent: none. Registries backed by D1 set it.
   */
  emailSenders?: string[];
  /** The `apps` row's primary key; registries backed by D1 set it. */
  rowId?: string;
  /** The Worker version the last deploy uploaded; null before the first. */
  versionId?: string | null;
  /**
   * The names of the secrets on the app's own Worker (`apps.secret_names`),
   * as the CLI last recorded them (deploy, register, secret set|unset,
   * status), everyapp's own left out; null when never recorded, which the
   * settings model treats as unknown and never blocks on. Registries
   * backed by D1 set it.
   */
  secretNames?: string[] | null;
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
  scope: string;
  organizationId: string;
  status: string;
  manifest: string;
  /** `apps.email_senders`: a JSON string[] column, or null. */
  emailSenders?: string | null;
  /** `apps.secret_names`: a JSON string[] column, or null when never recorded. */
  secretNames?: string | null;
  rowId?: string;
  versionId?: string | null;
}

/**
 * The secret names a row records, or null for a row that never recorded
 * them (the column null, or anything that isn't a JSON list of names).
 */
export function parseSecretNames(
  stored: string | null | undefined,
): string[] | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) &&
      parsed.every((name) => typeof name === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** The column value for a list of secret names: sorted, each once. */
export function storedSecretNames(names: readonly string[]): string {
  return JSON.stringify([...new Set(names)].sort());
}

/**
 * A registry row the gateway can't route: a tier or scope it doesn't know.
 * Never coerced to a known one (that could route a row somewhere it was
 * never meant to go); the perimeter answers 503 for its host.
 */
export class UnroutableAppError extends Error {
  constructor(
    readonly appId: string,
    reason: string,
  ) {
    super(`App "${appId}" can't be routed: ${reason}`);
    this.name = "UnroutableAppError";
  }
}

export function rowToRegisteredApp(row: AppRegistryRow): RegisteredApp {
  const status = APP_STATUSES.includes(row.status)
    ? (row.status as AppStatus)
    : "disabled";
  if (!TIERS.includes(row.tier)) {
    throw new UnroutableAppError(row.appId, `unknown tier "${row.tier}"`);
  }
  if (!APP_SCOPES.includes(row.scope)) {
    throw new UnroutableAppError(row.appId, `unknown scope "${row.scope}"`);
  }

  return {
    appId: row.appId,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier as Tier,
    scope: row.scope as AppScope,
    organizationId: row.organizationId,
    status,
    manifest: validateManifest(JSON.parse(row.manifest)),
    ...(row.emailSenders === undefined
      ? {}
      : { emailSenders: parseEmailList(row.emailSenders) }),
    ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
    ...(row.versionId === undefined ? {} : { versionId: row.versionId }),
    ...(row.secretNames === undefined
      ? {}
      : { secretNames: parseSecretNames(row.secretNames) }),
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
