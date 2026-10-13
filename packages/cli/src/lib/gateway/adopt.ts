/**
 * Adopting a gateway everyapp deployed before it used cf (with wrangler):
 * it has a database, a Worker and apps, but no install row. Adopting looks
 * first (read-only: the account, zone, Worker, namespaces, DNS, migration
 * history and the apps the registry lists), then records the install as
 * it is: its domain, its wildcard route, its apps' hostnames, and "legacy"
 * for a release no everyapp recorded. Nothing is deployed or migrated:
 * `everyapp gateway upgrade` does that next, from a terminal, since cf
 * asks before replacing a Worker last changed outside it.
 *
 * Switching to per-app Custom Domains later is its own step
 * (switchToPerAppDomains).
 */
import os from "node:os";
import type { D1Database } from "@/lib/cf/d1";
import { findKv, getOrCreateKv } from "@/lib/cf/resources";
import type { CfRunner } from "@/lib/cf/runner";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { describeRecord, dnsRecordsAt } from "@/lib/domains/records";
import { resolveZone, type Zone } from "@/lib/domains/zones";
import { EveryAppError } from "@/lib/errors";
import { writeCachedInstall } from "@/lib/install/state";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { GatewayApiError, GatewayClient } from "./api";
import {
  ADOPTED_RELEASE,
  readInstall,
  writeInstall,
  type InstallRecord,
} from "./install";
import { gatewayHasOwner } from "./setup-link";

const OAUTH_KV_TITLE = "every-app-gateway-OAUTH_KV";
const DEPLOY_KV_TITLE = "every-app-gateway-deploy";

interface RegisteredApp {
  appId: string;
  hostname: string | null;
  workerName: string | null;
  status: string | null;
}

interface GatewayInventory {
  domain: string;
  zone: Zone;
  /** The version the gateway Worker serves. */
  servingVersionId: string | null;
  oauthKvId: string | null;
  deployKvId: string | null;
  /** Records at the gateway host, and at `*.<host>` (the wildcard apps ride on). */
  hostRecords: string[];
  wildcardRecords: string[];
  /** drizzle-kit's applied migrations, and whether cf's table exists yet. */
  drizzleMigrations: number;
  cfMigrations: boolean;
  apps: RegisteredApp[];
  /** Apps whose hostname isn't one label below the domain. */
  strayApps: RegisteredApp[];
  claimed: boolean;
}

async function recordsAt(cf: CfRunner, zoneId: string, name: string): Promise<string[]> {
  const records = await dnsRecordsAt(cf, zoneId, name).catch(() => null);
  return (records ?? []).map(describeRecord);
}

async function count(db: D1Database, sql: string): Promise<number | null> {
  try {
    const [rows = []] = await db.run([{ sql }]);
    return Number(rows[0]?.["n"] ?? 0);
  } catch {
    return null;
  }
}

/** Read everything adopting decides on; changes nothing. */
export async function inventoryGateway({
  cf,
  db,
  accountId,
  domain,
}: {
  cf: CfRunner;
  db: D1Database;
  accountId: string;
  domain: string;
}): Promise<GatewayInventory> {
  const zone = await resolveZone(cf, domain, accountId);
  const [serving, oauthKvId, deployKvId, hostRecords, wildcardRecords, claimed] =
    await Promise.all([
      getWorkerDeployment(cf, GATEWAY_WORKER_NAME),
      findKv(cf, OAUTH_KV_TITLE),
      findKv(cf, DEPLOY_KV_TITLE),
      recordsAt(cf, zone.id, domain),
      recordsAt(cf, zone.id, `*.${domain}`),
      gatewayHasOwner(db).catch(() => false),
    ]);
  if (!serving) {
    throw new EveryAppError(
      "GATEWAY_NOT_DEPLOYED",
      "This account has the gateway's database but no gateway Worker, so there is nothing to adopt. `everyapp gateway deploy` installs a new gateway (with new keys: every app must then be deployed again).",
    );
  }
  const [rows = []] = await db
    .run([{ sql: "SELECT app_slug, hostname, worker_name, status FROM apps ORDER BY app_slug" }])
    .catch(() => [[]]);
  const apps = rows.map((row) => ({
    appId: String(row["app_slug"]),
    hostname: row["hostname"] === null ? null : String(row["hostname"]),
    workerName: row["worker_name"] === null ? null : String(row["worker_name"]),
    status: row["status"] === null || row["status"] === undefined ? null : String(row["status"]),
  }));
  return {
    domain,
    zone,
    servingVersionId: serving.versionId,
    oauthKvId,
    deployKvId,
    hostRecords,
    wildcardRecords,
    drizzleMigrations: (await count(db, "SELECT COUNT(*) AS n FROM __drizzle_migrations")) ?? 0,
    cfMigrations: (await count(db, "SELECT COUNT(*) AS n FROM d1_migrations")) !== null,
    apps,
    strayApps: apps.filter(
      (app) => app.hostname && !isOneLabelBelow(app.hostname, domain),
    ),
    claimed,
  };
}

type PublicGatewayApi = Pick<GatewayClient, "status" | "hasOwner">;

/**
 * Make sure `https://<domain>` serves this account's gateway before it is
 * recorded as the install's host: a deploy would publish the gateway there.
 * A gateway with /api/deploy/status must answer from the very version this
 * account's Worker serves (as servingReleaseSha256 asks). One from before
 * that endpoint (the wrangler-era ones adopting is for) must answer
 * /api/admin/has-owner like a gateway, owned exactly when this account's
 * gateway database has an owner. Throws DOMAIN_NOT_GATEWAY otherwise, and
 * GATEWAY_UNREACHABLE when the host doesn't answer at all.
 */
export async function assertServesGateway({
  domain,
  inventory,
  client = new GatewayClient({ gatewayUrl: `https://${domain}` }),
}: {
  domain: string;
  inventory: Pick<GatewayInventory, "servingVersionId" | "claimed">;
  client?: PublicGatewayApi;
}): Promise<"version" | "owner"> {
  const url = `https://${domain}`;
  const unreachable = (error: unknown) =>
    new EveryAppError(
      "GATEWAY_UNREACHABLE",
      `Couldn't reach ${url} (${error instanceof Error ? error.message : String(error)}) to check it serves this account's gateway. Pass the domain the gateway serves at (its GATEWAY_URL), or try again once it answers.`,
      { retryable: true },
    );
  const notThisGateway = (why: string) =>
    new EveryAppError(
      "DOMAIN_NOT_GATEWAY",
      `${url} ${why}, so it isn't the gateway this account runs: nothing was recorded. Pass the domain this account's gateway serves at (its GATEWAY_URL).`,
    );

  const status = await client.status().catch((error: unknown) => {
    // A gateway from before the endpoint, or not a gateway: asked below.
    if (error instanceof GatewayApiError) return null;
    throw unreachable(error);
  });
  if (status?.versionId) {
    if (status.versionId === inventory.servingVersionId) return "version";
    throw notThisGateway(
      `serves a gateway from version ${status.versionId}, while this account's every-app-gateway Worker serves ${inventory.servingVersionId ?? "no version"}`,
    );
  }
  const hasOwner = await client.hasOwner().catch((error: unknown) => {
    if (error instanceof GatewayApiError) {
      throw notThisGateway(
        `doesn't answer like an Every App gateway (/api/admin/has-owner: ${error.message})`,
      );
    }
    throw unreachable(error);
  });
  if (hasOwner !== inventory.claimed) {
    throw notThisGateway(
      `serves a gateway that ${hasOwner ? "has an owner" : "has no owner yet"}, while this account's gateway database ${inventory.claimed ? "has one" : "has none"}`,
    );
  }
  return "owner";
}

/** The inventory as lines for a person. */
export function describeInventory(inventory: GatewayInventory): string[] {
  return [
    `Gateway:     https://${inventory.domain} (zone ${inventory.zone.name}), serving version ${inventory.servingVersionId ?? "(unknown)"}`,
    `DNS:         ${inventory.domain}: ${inventory.hostRecords.join(", ") || "no record (a Custom Domain's own may not be listed)"}; *.${inventory.domain}: ${inventory.wildcardRecords.join(", ") || "no wildcard record"}`,
    `Namespaces:  OAuth ${inventory.oauthKvId ?? "missing (created)"}, release cache ${inventory.deployKvId ?? "missing (created)"}`,
    `Database:    ${inventory.drizzleMigrations} migrations applied by drizzle-kit${inventory.cfMigrations ? ", and cf's d1_migrations" : ""}; the next upgrade carries them over`,
    `Owner:       ${inventory.claimed ? "claimed" : "unclaimed"}`,
    `Apps:        ${inventory.apps.length === 0 ? "none" : ""}`,
    ...inventory.apps.map(
      (app) =>
        `  ${app.appId}: ${app.hostname ?? "(no host)"} → ${app.workerName ?? "(no Worker)"}${app.status ? ` (${app.status})` : ""}`,
    ),
  ];
}

/**
 * Record the install as it is, in route mode with a legacy release; create
 * the release cache namespace. Refuses a gateway already adopted, and a
 * domain its apps don't live under.
 */
export async function adoptGateway({
  cf,
  db,
  databaseId,
  accountId,
  inventory,
  cliVersion,
}: {
  cf: CfRunner;
  db: D1Database;
  databaseId: string;
  accountId: string;
  inventory: GatewayInventory;
  cliVersion: string;
}): Promise<InstallRecord> {
  if (await readInstall(db)) {
    throw new EveryAppError(
      "GATEWAY_ADOPTED",
      "This gateway already has an install record: `everyapp gateway upgrade` deploys it.",
    );
  }
  const oauthKv = await getOrCreateKv(cf, OAUTH_KV_TITLE);
  const deployKv = await getOrCreateKv(cf, DEPLOY_KV_TITLE);
  const updatedAt = Date.now();
  const record: InstallRecord = {
    accountId,
    zoneId: inventory.zone.id,
    zoneName: inventory.zone.name,
    gatewayHost: inventory.domain,
    appBaseDomain: inventory.domain,
    routing: "wildcard-route",
    oauthKvId: oauthKv.id,
    deployKvId: deployKv.id,
    releaseVersion: ADOPTED_RELEASE,
    releaseSha256: ADOPTED_RELEASE,
    releaseOrder: null,
    // Not one everyapp uploaded: the upgrade asks before replacing it.
    liveVersionId: null,
    liveDomains: [inventory.domain],
    liveAppWorkers: [],
    updatedAt,
    updatedBy: `everyapp ${cliVersion} on ${os.hostname()} (adopted)`,
  };
  await writeInstall(db, record);
  await writeCachedInstall({
    gatewayHost: inventory.domain,
    accountId,
    zoneId: inventory.zone.id,
    zoneName: inventory.zone.name,
    databaseId,
    oauthKvId: oauthKv.id,
    deployKvId: deployKv.id,
    routing: "wildcard-route",
    releaseVersion: ADOPTED_RELEASE,
    releaseSha256: ADOPTED_RELEASE,
    updatedAt: new Date(updatedAt).toISOString(),
  });
  return record;
}
