import { and, eq, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  rowToRegisteredApp,
  type AppRegistry,
  type AppRegistryRow,
  type RegisteredApp,
} from "@every-app/perimeter";
import { apps } from "@/db/apps.schema";

type RegistryRow = {
  appSlug: string;
  hostname: string | null;
  workerName: string | null;
  tier: string;
  organizationId: string;
  status: string;
  manifest: string | null;
};

const registryColumns = {
  appSlug: apps.appSlug,
  hostname: apps.hostname,
  workerName: apps.workerName,
  tier: apps.tier,
  organizationId: apps.organizationId,
  status: apps.status,
  manifest: apps.manifest,
};

export class DrizzleAppRegistry implements AppRegistry {
  private readonly db: DrizzleD1Database;

  constructor(database: D1Database | DrizzleD1Database) {
    this.db = "prepare" in database ? drizzle(database) : database;
  }

  private async query(where: SQL): Promise<RegisteredApp | null> {
    const [row] = await this.db
      .select(registryColumns)
      .from(apps)
      .where(where)
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

  findByHostname(hostname: string): Promise<RegisteredApp | null> {
    return this.query(eq(apps.hostname, hostname.toLowerCase()));
  }

  findByAppId(appId: string): Promise<RegisteredApp | null> {
    return this.query(eq(apps.appSlug, appId));
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
    organizationId: row.organizationId,
    status: row.status,
    manifest: row.manifest,
  };
}
