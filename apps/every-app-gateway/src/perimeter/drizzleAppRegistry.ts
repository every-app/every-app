import { and, eq, isNull, ne, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  rowToRegisteredApp,
  type AppRegistry,
  type AppRegistryRow,
  type RegisteredApp,
} from "@every-app/perimeter";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import { appPreviousIds, apps } from "@/db/apps.schema";

type RegistryRow = {
  id: string;
  appSlug: string;
  hostname: string | null;
  workerName: string | null;
  tier: string;
  scope: string;
  organizationId: string;
  status: string;
  manifest: string | null;
  emailSenders: string | null;
  secretNames: string | null;
  versionId: string | null;
};

const registryColumns = {
  id: apps.id,
  appSlug: apps.appSlug,
  hostname: apps.hostname,
  workerName: apps.workerName,
  tier: apps.tier,
  scope: apps.scope,
  organizationId: apps.organizationId,
  status: apps.status,
  manifest: apps.manifest,
  emailSenders: apps.emailSenders,
  secretNames: apps.secretNames,
  versionId: apps.versionId,
};

export class DrizzleAppRegistry implements AppRegistry {
  private readonly db: DrizzleD1Database;

  constructor(database: D1Database | DrizzleD1Database) {
    this.db = "prepare" in database ? drizzle(database) : database;
  }

  private async query(where: SQL): Promise<RegisteredApp | null> {
    // A deleted app's tombstone is never routed: it is "no app" here. So
    // is a provider app (no hostname, no Worker): the gateway serves its
    // tools itself (server/provider-apps).
    const [row] = await this.db
      .select(registryColumns)
      .from(apps)
      .where(
        and(
          where,
          ne(apps.status, "deleted"),
          ne(apps.tier, PROVIDER_APP_TIER),
        ),
      )
      .limit(1);
    if (!row) return null;
    return rowToRegisteredApp(toRegistryRow(row));
  }

  async hasAnyActiveApp(): Promise<boolean> {
    const [row] = await this.db
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.status, "active"))
      .limit(1);
    return Boolean(row);
  }

  /**
   * The app at `hostname`: the one registered there, else the one that
   * was before a rename while that previous hostname is served
   * (`app_previous_ids`), with `hostname` the previous one and, once its
   * new hostname has answered (`moved_at`), `movedTo` that one.
   */
  async findByHostname(hostname: string): Promise<RegisteredApp | null> {
    const host = hostname.toLowerCase();
    const app = await this.query(eq(apps.hostname, host));
    if (app) return app;
    const [previous] = await this.db
      .select({
        appRowId: appPreviousIds.appRowId,
        movedAt: appPreviousIds.movedAt,
      })
      .from(appPreviousIds)
      .where(
        and(
          eq(appPreviousIds.hostname, host),
          isNull(appPreviousIds.retiredAt),
        ),
      )
      .limit(1);
    if (!previous) return null;
    const moved = await this.query(eq(apps.id, previous.appRowId));
    if (!moved) return null;
    return {
      ...moved,
      hostname: host,
      ...(previous.movedAt ? { movedTo: moved.hostname } : {}),
    };
  }

  findByAppId(appId: string): Promise<RegisteredApp | null> {
    return this.query(eq(apps.appSlug, appId));
  }

  async findByOrgPreviousApp(
    organizationId: string,
    appId: string,
  ): Promise<RegisteredApp | null> {
    const [previous] = await this.db
      .select({ appRowId: appPreviousIds.appRowId })
      .from(appPreviousIds)
      .where(
        and(
          eq(appPreviousIds.organizationId, organizationId),
          eq(appPreviousIds.appSlug, appId),
        ),
      )
      .limit(1);
    if (!previous) return null;
    return this.query(
      and(
        eq(apps.id, previous.appRowId),
        eq(apps.organizationId, organizationId),
      )!,
    );
  }

  findByOrgApp(
    organizationId: string,
    appId: string,
  ): Promise<RegisteredApp | null> {
    return this.query(
      and(eq(apps.organizationId, organizationId), eq(apps.appSlug, appId))!,
    );
  }
}

function toRegistryRow(row: RegistryRow): AppRegistryRow {
  if (!row.hostname || !row.workerName || !row.manifest) {
    throw new Error("App registry row is missing perimeter columns");
  }
  return {
    appId: row.appSlug,
    hostname: row.hostname,
    workerName: row.workerName,
    tier: row.tier,
    scope: row.scope,
    organizationId: row.organizationId,
    status: row.status,
    manifest: row.manifest,
    emailSenders: row.emailSenders,
    secretNames: row.secretNames,
    rowId: row.id,
    versionId: row.versionId,
  };
}
