/**
 * The app registry in the gateway's D1, written by the CLI itself (ADR-0003:
 * in self-host, D1 write access to the gateway's account is operator
 * authority). Each write reads the rows the rules in
 * `@every-app/perimeter/registry` need, runs them, and writes what they
 * return in one `cf d1 query` batch, which D1 applies atomically:
 *
 *   register ─▶ pending ─▶ markDeployed ─▶ binding ─▶ (the gateway) active
 *   deleteApp ─▶ deleted (a tombstone: its names stay its organization's)
 *
 * Apps register into the install's own organization: the oldest one with
 * an owner, or before the gateway has one, the oldest of all, created here
 * when there is none (the setup claim adopts it). Who deploys is recorded
 * on the row (`deployed_by_actor`): the Cloudflare login's email, or
 * `api-token:<account id>` for an API token.
 */
import { randomUUID } from "node:crypto";
import {
  appNames,
  appResources,
  DELETED_APP_STATUS,
  deleteUpdate,
  markDeployedUpdate,
  orgKeyCandidates,
  planRegistration,
  RegistrationError,
  type AppNameOwner,
  type AppResources,
  type AppRow,
  type RegistrationPlan,
} from "@every-app/perimeter/registry";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";

type D1Row = Record<string, unknown>;

interface Organization {
  id: string;
  name: string;
  slug: string;
}

/** Who deploys, as the registry records it. */
export interface Deployer {
  /** `deployed_by_actor`: the Cloudflare login's email, or `api-token:<account id>`. */
  actor: string;
  /**
   * The login's email, for the new app's initial access when a verified
   * gateway user has it. Null for an API token, whose user (if it has one)
   * isn't who runs the deploy.
   */
  email: string | null;
}

/** The deployer a Cloudflare login (or API token) stands for. */
export function deployerFor(
  email: string | null | undefined,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): Deployer {
  if (env["CLOUDFLARE_API_TOKEN"] || !email) {
    return { actor: `api-token:${accountId}`, email: null };
  }
  return { actor: email, email };
}

/** A registry refusal, as the error a command reports. */
function asEveryAppError(error: unknown): unknown {
  if (error instanceof RegistrationError) {
    return new EveryAppError(error.code, error.message, {
      retryable: error.status >= 500,
    });
  }
  return error;
}

async function registryCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw asEveryAppError(error);
  }
}

const APP_COLUMNS =
  "id, organization_id, app_slug, name, description, hostname, worker_name, tier, manifest, status, version_id, deployed_at, deployed_by_actor, is_default";

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toAppRow(row: D1Row): AppRow {
  return {
    id: String(row["id"]),
    organizationId: String(row["organization_id"]),
    appSlug: String(row["app_slug"]),
    name: String(row["name"]),
    description: String(row["description"]),
    hostname: text(row["hostname"]),
    workerName: text(row["worker_name"]),
    tier: String(row["tier"]),
    manifest: text(row["manifest"]),
    status: String(row["status"]),
    versionId: text(row["version_id"]),
    deployedAt: row["deployed_at"] == null ? null : Number(row["deployed_at"]),
    deployedByActor: text(row["deployed_by_actor"]),
    isDefault: Boolean(Number(row["is_default"])),
  };
}

function toNameOwner(row: D1Row | undefined): AppNameOwner | null {
  if (!row) return null;
  return {
    organizationId: String(row["organization_id"]),
    appSlug: String(row["app_slug"]),
    hostname: text(row["hostname"]),
    workerName: text(row["worker_name"]),
  };
}

function toOrganization(row: D1Row | undefined): Organization | null {
  if (!row) return null;
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    slug: String(row["slug"]),
  };
}

const OWNED_ORGANIZATION: D1Statement = {
  sql: `SELECT id, name, slug FROM organizations
WHERE EXISTS (SELECT 1 FROM members WHERE members.organization_id = organizations.id AND members.role = 'owner')
ORDER BY created_at, id LIMIT 1`,
};
const OLDEST_ORGANIZATION: D1Statement = {
  sql: "SELECT id, name, slug FROM organizations ORDER BY created_at, id LIMIT 1",
};

/**
 * The install's own organization: the oldest with an owner, or before the
 * gateway has one, the oldest of all. Null when there is no organization.
 */
export async function installOrganization(
  db: D1Database,
): Promise<{ organization: Organization; hasOwner: boolean } | null> {
  const [owned = [], oldest = []] = await db.run([
    OWNED_ORGANIZATION,
    OLDEST_ORGANIZATION,
  ]);
  return pickInstallOrganization(owned, oldest);
}

function pickInstallOrganization(
  owned: D1Row[],
  oldest: D1Row[],
): { organization: Organization; hasOwner: boolean } | null {
  const withOwner = toOrganization(owned[0]);
  if (withOwner) return { organization: withOwner, hasOwner: true };
  const first = toOrganization(oldest[0]);
  return first ? { organization: first, hasOwner: false } : null;
}

/** A Better Auth organization slug, as the gateway's setup claim makes one. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/**
 * The install's organization, created when the gateway has none yet: named
 * after `name` (the Cloudflare account's), with no members, for the setup
 * claim to adopt. Only ever the first organization: two deploys racing to
 * create it make one.
 */
async function ensureInstallOrganization(
  db: D1Database,
  name: string,
  now: number,
): Promise<{ organization: Organization; hasOwner: boolean }> {
  const found = await installOrganization(db);
  if (found) return found;
  const organizationName = name.trim() || "My Organization";
  const [, owned = [], oldest = []] = await db.run([
    {
      sql: `INSERT INTO organizations (id, name, slug, created_at)
SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM organizations)`,
      params: [randomUUID(), organizationName, slugify(organizationName) || "default", now],
    },
    OWNED_ORGANIZATION,
    OLDEST_ORGANIZATION,
  ]);
  const created = pickInstallOrganization(owned, oldest);
  if (!created) throw new Error("The gateway's database has no organization.");
  return created;
}

/**
 * Claim the first of `candidates` no other organization holds as this
 * organization's key, unless it has one: one statement, so two deploys
 * can't claim two keys.
 */
function claimOrgKey(organizationId: string, slug: string): D1Statement {
  const candidates = orgKeyCandidates(slug);
  const values = candidates
    .map((_candidate, index) => `(${index}, ?${index + 2})`)
    .join(", ");
  return {
    sql: `WITH candidates(rank, candidate) AS (VALUES ${values})
INSERT OR IGNORE INTO organization_keys (organization_id, org_key)
SELECT ?1, candidate FROM candidates
WHERE NOT EXISTS (SELECT 1 FROM organization_keys WHERE organization_id = ?1)
  AND candidate NOT IN (SELECT org_key FROM organization_keys)
ORDER BY rank LIMIT 1`,
    params: [organizationId, ...candidates],
  };
}

export interface RegisterInput {
  appSlug: string;
  name: string;
  description: string;
  /** The manifest the deploy builds from (`everyapp.config.ts`). */
  manifest: unknown;
  /** The install's base domain: apps live one label below it. */
  appBaseDomain: string;
  deployer: Deployer;
  /** Names the organization created when the gateway has none yet. */
  organizationName: string;
  now?: number;
}

interface Registration {
  plan: RegistrationPlan;
  organization: Organization;
  /** The gateway has an owner. */
  hasOwner: boolean;
  /** The deployer is a member of the organization, granted the new app. */
  deployerGranted: boolean;
}

/**
 * Register an app, or a redeploy of one, in the install's organization: a
 * new app (or a deleted one of its own coming back) is `pending` with the
 * names the rules assign it and its initial access; a redeploy keeps its
 * names, status and live manifest, and updates its name and description.
 */
export function register(
  db: D1Database,
  input: RegisterInput,
): Promise<Registration> {
  return registryCall(() => registerApp(db, input));
}

async function registerApp(
  db: D1Database,
  input: RegisterInput,
): Promise<Registration> {
  const now = input.now ?? Date.now();
  const { organization, hasOwner } = await ensureInstallOrganization(
    db,
    input.organizationName,
    now,
  );
  const [, keys = [], existing = [], members = [], deployers = []] =
    await db.run([
      claimOrgKey(organization.id, organization.slug),
      {
        sql: "SELECT org_key FROM organization_keys WHERE organization_id = ?",
        params: [organization.id],
      },
      {
        sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug = ?`,
        params: [organization.id, input.appSlug],
      },
      {
        sql: "SELECT user_id, role FROM members WHERE organization_id = ?",
        params: [organization.id],
      },
      {
        sql: "SELECT id FROM users WHERE lower(email) = lower(?) AND email_verified = 1",
        params: [input.deployer.email],
      },
    ]);
  const orgKey = text(keys[0]?.["org_key"]);
  if (!orgKey) {
    throw new RegistrationError({
      status: 409,
      code: "ORG_KEY_UNAVAILABLE",
      message: `Every key for organization "${organization.slug}" is taken by another organization on this gateway.`,
    });
  }
  const existingApp = existing[0] ? toAppRow(existing[0]) : null;
  const names = appNames({
    appSlug: input.appSlug,
    orgKey,
    isInstallOrganization: true,
    appBaseDomain: input.appBaseDomain,
    existingApp,
  });
  const [hostnameOwners = [], workerNameOwners = []] = await db.run([
    {
      sql: "SELECT organization_id, app_slug, hostname, worker_name FROM apps WHERE hostname = ?",
      params: [names.hostname],
    },
    {
      sql: "SELECT organization_id, app_slug, hostname, worker_name FROM apps WHERE worker_name = ?",
      params: [names.workerName],
    },
  ]);
  const deployerUserId = text(deployers[0]?.["id"]);
  const plan = planRegistration({
    organizationId: organization.id,
    isInstallOrganization: true,
    appSlug: input.appSlug,
    name: input.name,
    description: input.description,
    manifest: input.manifest,
    appBaseDomain: input.appBaseDomain,
    orgKey,
    existingApp,
    hostnameOwner: toNameOwner(hostnameOwners[0]),
    workerNameOwner: toNameOwner(workerNameOwners[0]),
    members: members.map((member) => ({
      id: String(member["user_id"]),
      role: text(member["role"]),
    })),
    deployerUserId,
  });
  await db.run(registrationWrites(plan, now));
  return {
    plan,
    organization,
    hasOwner,
    deployerGranted:
      deployerUserId !== null &&
      plan.grants.some((grant) => grant.userId === deployerUserId),
  };
}

/** What a registration writes, in one batch. */
function registrationWrites(plan: RegistrationPlan, now: number): D1Statement[] {
  const { app } = plan;
  if (plan.kind === "existing") {
    return [
      {
        sql: "UPDATE apps SET name = ?, description = ?, updated_at = ? WHERE id = ?",
        params: [app.name, app.description, now, app.id],
      },
    ];
  }
  const grants = plan.grants.map((grant) => ({
    sql: `INSERT INTO user_app_access (id, user_id, app_row_id, organization_id, granted_by)
VALUES (?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING`,
    params: [grant.id, grant.userId, grant.appRowId, grant.organizationId],
  }));
  if (plan.kind === "new") {
    return [
      {
        sql: `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname,
  worker_name, tier, manifest, status, version_id, deployed_at, deployed_by_actor,
  is_default, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`,
        params: [
          app.id,
          app.organizationId,
          app.appSlug,
          app.name,
          app.description,
          app.hostname,
          app.workerName,
          app.tier,
          app.manifest,
          app.status,
          app.versionId,
          app.deployedAt,
          app.deployedByActor,
          app.isDefault ? 1 : 0,
          now,
        ],
      },
      ...grants,
    ];
  }
  // A tombstone of this organization's comes back: as new, with nothing
  // of the deleted app's access, tokens, tools or AI connections.
  return [
    {
      sql: `UPDATE apps SET name = ?, description = ?, hostname = ?, worker_name = ?,
  manifest = ?, status = ?, is_default = ?, updated_at = ?
WHERE id = ? AND status = '${DELETED_APP_STATUS}'`,
      params: [
        app.name,
        app.description,
        app.hostname,
        app.workerName,
        app.manifest,
        app.status,
        app.isDefault ? 1 : 0,
        now,
        app.id,
      ],
    },
    ...withoutAppData(app, now),
    ...grants,
  ];
}

/**
 * What goes with a deleted app (deleteUpdate's companions): everyone's
 * access to it, the personal access tokens bound to it (revoked), its
 * agent tools snapshot, and its place in AI connections.
 */
function withoutAppData(
  app: Pick<AppRow, "id" | "organizationId">,
  now: number,
): D1Statement[] {
  const scoped = [app.id, app.organizationId];
  return [
    {
      sql: "DELETE FROM user_app_access WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: `UPDATE user_access_tokens SET revoked_at = ?1, updated_at = ?1
WHERE app_row_id = ?2 AND organization_id = ?3 AND revoked_at IS NULL`,
      params: [now, ...scoped],
    },
    {
      sql: "DELETE FROM app_tools WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: "DELETE FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: "DELETE FROM mcp_connection_apps WHERE app_row_id = ?",
      params: [app.id],
    },
  ];
}

async function readAppRow(db: D1Database, id: string): Promise<AppRow | null> {
  const [rows = []] = await db.run([
    { sql: `SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`, params: [id] },
  ]);
  return rows[0] ? toAppRow(rows[0]) : null;
}

/** An app's row by id, or null (tests, and the live wait). */
export function readAppById(db: D1Database, id: string): Promise<AppRow | null> {
  return readAppRow(db, id);
}

const MARK_DEPLOYED_ATTEMPTS = 3;

/**
 * The app's new Worker version is uploaded: record it, with the manifest it
 * was built from (its route policy goes live now) and who deployed it. A
 * new app moves on to `binding`, for the gateway to activate. Returns the
 * app's status now.
 */
export function markDeployed(
  db: D1Database,
  appRowId: string,
  deployed: { versionId: string; manifest: unknown; actor: string; now?: number },
): Promise<string> {
  return registryCall(async () => {
    for (let attempt = 1; ; attempt += 1) {
      const app = await readAppRow(db, appRowId);
      if (!app) {
        throw new RegistrationError({
          status: 404,
          code: "APP_NOT_FOUND",
          message: "The app's registry row is gone; deploy it again.",
        });
      }
      const update = markDeployedUpdate(app, deployed);
      // Only over the status it was read with: an admin switching the app
      // off meanwhile keeps it off.
      const [changed = []] = await db.run([
        {
          sql: `UPDATE apps SET manifest = ?, version_id = ?, deployed_at = ?, deployed_by_actor = ?,
  status = ?, updated_at = ? WHERE id = ? AND status = ? RETURNING status`,
          params: [
            update.manifest,
            update.versionId,
            update.deployedAt,
            update.deployedByActor,
            update.status,
            update.deployedAt,
            appRowId,
            app.status,
          ],
        },
      ]);
      if (changed.length > 0) return update.status;
      if (attempt >= MARK_DEPLOYED_ATTEMPTS) {
        throw new EveryAppError(
          "APP_CHANGING",
          "The app's registry row keeps changing while this deploy records its upload. Deploy again; the upload is kept.",
          { retryable: true },
        );
      }
    }
  });
}

/** An app as the commands that act on a registered one see it. */
export interface RegisteredAppInfo {
  id: string;
  appSlug: string;
  organizationId: string;
  status: string;
  workerName: string;
  hostname: string;
  resources: AppResources;
}

function info(app: AppRow): RegisteredAppInfo {
  return {
    id: app.id,
    appSlug: app.appSlug,
    organizationId: app.organizationId,
    status: app.status,
    workerName: app.workerName ?? "",
    hostname: app.hostname ?? "",
    resources: appResources(app),
  };
}

/** The install organization's row for an app id, tombstones included. */
async function findApp(db: D1Database, appSlug: string): Promise<AppRow | null> {
  const found = await installOrganization(db);
  if (!found) return null;
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug = ?`,
      params: [found.organization.id, appSlug],
    },
  ]);
  return rows[0] ? toAppRow(rows[0]) : null;
}

function notRegistered(appSlug: string): EveryAppError {
  return new EveryAppError(
    "APP_NOT_FOUND",
    `No app "${appSlug}" is registered on this gateway; deploy it first.`,
  );
}

/** A registered app (not deleted) with names, for the commands that act on it. */
export async function readApp(
  db: D1Database,
  appSlug: string,
): Promise<RegisteredAppInfo> {
  const app = await findApp(db, appSlug);
  if (!app || app.status === DELETED_APP_STATUS || !app.workerName) {
    throw notRegistered(appSlug);
  }
  return info(app);
}

/** Every app the registry lists, deleted ones aside, by app id. */
export async function listApps(db: D1Database): Promise<
  Array<RegisteredAppInfo & { deployedBy: string | null; deployedAt: number | null }>
> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps WHERE status != '${DELETED_APP_STATUS}' ORDER BY app_slug, organization_id`,
    },
  ]);
  return rows.map(toAppRow).map((app) => ({
    ...info(app),
    deployedBy: app.deployedByActor,
    deployedAt: app.deployedAt,
  }));
}

/**
 * Delete an app, leaving a tombstone: unrouted and unlisted, its names
 * still its organization's, with nothing of its access, tokens, tools or AI
 * connections left. An app deleted already writes nothing, so a delete
 * that stopped part-way can run again. Returns the app as it was named.
 */
export async function deleteApp(
  db: D1Database,
  appSlug: string,
  now = Date.now(),
): Promise<RegisteredAppInfo> {
  const app = await findApp(db, appSlug);
  if (!app || !app.workerName) throw notRegistered(appSlug);
  const update = deleteUpdate(app);
  if (update) {
    await db.run([
      {
        sql: "UPDATE apps SET status = ?, is_default = ?, updated_at = ? WHERE id = ?",
        params: [update.status, update.isDefault ? 1 : 0, now, app.id],
      },
      ...withoutAppData(app, now),
    ]);
  }
  return { ...info(app), status: DELETED_APP_STATUS };
}
