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
 * when there is none (the setup claim adopts it). On the hosted gateway it
 * is the platform organization, and a `shared` app (one Worker every
 * organization's members may open) is one of its apps that only its owners
 * and admins register. Who deploys is recorded on the row
 * (`deployed_by_actor`): the Cloudflare login's email, or
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
  parseSecretNames,
  planRegistration,
  RegistrationError,
  storedSecretNames,
  type AppNameOwner,
  type AppResources,
  type AppRow,
  type AppScope,
  type RegistrationPlan,
} from "@every-app/perimeter/registry";
import {
  parseEmailList,
  storedEmailList,
  type AppEmailConfig,
  type SettingsManifestLike,
} from "@every-app/sdk/internal";
import { storedPublicRoutes, type PublicRouteSummary } from "@/lib/app/publicRoutes";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI, thisCommandWithout } from "@/lib/output/command";

type D1Row = Record<string, unknown>;

export interface Organization {
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

export async function registryCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw asEveryAppError(error);
  }
}

/** The `apps` columns every read takes; `secret_names` came with migration 0004. */
const APP_COLUMNS_BEFORE_SECRET_NAMES =
  "id, organization_id, app_slug, name, description, hostname, worker_name, tier, scope, manifest, status, version_id, deployed_at, deployed_by_actor, is_default, email_senders, email_inbound";
const APP_COLUMNS = `${APP_COLUMNS_BEFORE_SECRET_NAMES}, secret_names`;

const secretNamesColumns = new WeakMap<D1Database, Promise<boolean>>();

/**
 * Whether the Gateway's D1 has `apps.secret_names` (migration 0004,
 * 2026-10-24). A Gateway from before it lacks the column until `update`
 * runs its migrations. Until then the registry reads every app's recorded
 * names as never recorded (null, which never blocks) and leaves them
 * unwritten, so `status` and `secret list` still run against the older
 * Gateway (and status says to update) instead of failing on "no such
 * column: secret_names". Asked of each database once.
 */
export function hasSecretNamesColumn(db: D1Database): Promise<boolean> {
  let known = secretNamesColumns.get(db);
  if (!known) {
    known = db
      .run([{ sql: "PRAGMA table_info(apps)" }])
      .then(([rows = []]) => rows.some((row) => row["name"] === "secret_names"));
    secretNamesColumns.set(db, known);
  }
  return known;
}

/** The columns to select: all, or those before `secret_names` on a Gateway that predates it. */
export async function appColumns(db: D1Database): Promise<string> {
  return (await hasSecretNamesColumn(db)) ? APP_COLUMNS : APP_COLUMNS_BEFORE_SECRET_NAMES;
}

export const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * An `apps` row with its email configuration columns and the app Worker's
 * recorded secret names (each a JSON string[] or null).
 */
export type StoredAppRow = AppRow & {
  emailSenders: string | null;
  emailInbound: string | null;
  secretNames: string | null;
};

export function toAppRow(row: D1Row): StoredAppRow {
  return {
    id: String(row["id"]),
    organizationId: String(row["organization_id"]),
    appSlug: String(row["app_slug"]),
    name: String(row["name"]),
    description: String(row["description"]),
    hostname: text(row["hostname"]),
    workerName: text(row["worker_name"]),
    tier: String(row["tier"]),
    scope: String(row["scope"]),
    manifest: text(row["manifest"]),
    status: String(row["status"]),
    versionId: text(row["version_id"]),
    deployedAt: row["deployed_at"] == null ? null : Number(row["deployed_at"]),
    deployedByActor: text(row["deployed_by_actor"]),
    isDefault: Boolean(Number(row["is_default"])),
    emailSenders: text(row["email_senders"]),
    emailInbound: text(row["email_inbound"]),
    secretNames: text(row["secret_names"]),
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
export async function ensureInstallOrganization(
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
  /**
   * `shared`: a first-party app for every organization; `org`: the
   * organization's own. Unset keeps the registered app's (a new one is `org`).
   */
  scope?: AppScope;
  /**
   * The Worker the app must have (a Worker deployed by other means; no
   * CLI command passes it since 2026-10-24): refused, writing nothing, when
   * the rules name it otherwise.
   */
  expectedWorkerName?: string;
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
        sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND app_slug = ?`,
        params: [organization.id, input.appSlug],
      },
      ...memberQueries(organization.id, input.deployer.email),
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
  const orgMembers = toMembers(members);
  const plan = planRegistration({
    organizationId: organization.id,
    isInstallOrganization: true,
    scope: input.scope,
    appSlug: input.appSlug,
    name: input.name,
    description: input.description,
    manifest: input.manifest,
    appBaseDomain: input.appBaseDomain,
    orgKey,
    existingApp,
    hostnameOwner: toNameOwner(hostnameOwners[0]),
    workerNameOwner: toNameOwner(workerNameOwners[0]),
    members: orgMembers,
    deployerUserId,
  });
  // The scope the plan resolved: a redeploy that didn't ask keeps the row's.
  if (plan.app.scope === "shared") {
    assertPlatformAdmin(
      input.deployer,
      deployerUserId,
      orgMembers,
      organization,
      // An expectedWorkerName is a Register (`everyapp register` passed one
      // until 2026-10-24; no CLI command does now), else a Deploy.
      input.expectedWorkerName === undefined ? SharedAppAction.Deploy : SharedAppAction.Register,
    );
  }
  if (
    input.expectedWorkerName !== undefined &&
    plan.app.workerName !== input.expectedWorkerName
  ) {
    throw new EveryAppError(
      "WORKER_NAME_MISMATCH",
      `${input.appSlug}'s Worker must be named ${plan.app.workerName}, not ${input.expectedWorkerName}\nThe Gateway binds each app's Worker by that name only.`,
      {
        fix: `deploy the Worker as ${plan.app.workerName}`,
        rerun: `${thisCommandWithout("--worker")} --worker ${plan.app.workerName}`,
      },
    );
  }
  await db.run(registrationWrites(plan, now, { secretNames: await hasSecretNamesColumn(db) }));
  return {
    plan,
    organization,
    hasOwner,
    deployerGranted:
      deployerUserId !== null &&
      plan.grants.some((grant) => grant.userId === deployerUserId),
  };
}

/** An organization's members, then the user with the deployer's verified email. */
export function memberQueries(organizationId: string, email: string | null): D1Statement[] {
  return [
    {
      sql: "SELECT user_id, role FROM members WHERE organization_id = ?",
      params: [organizationId],
    },
    {
      sql: "SELECT id FROM users WHERE lower(email) = lower(?) AND email_verified = 1",
      params: [email],
    },
  ];
}

export function toMembers(rows: D1Row[]): Array<{ id: string; role: string | null }> {
  return rows.map((member) => ({ id: String(member["user_id"]), role: text(member["role"]) }));
}

const isOwnerOrAdmin = (role: string | null) =>
  (role ?? "").split(",").some((item) => ["owner", "admin"].includes(item.trim()));

/**
 * Only the platform organization's owners and admins register, redeploy or
 * delete shared apps. A person's Cloudflare login must be one (by its
 * verified email); an API token is the account's own authority over the
 * gateway's D1 (ADR-0003), with no person to check.
 */
function assertPlatformAdmin(
  deployer: Deployer,
  deployerUserId: string | null,
  orgMembers: Array<{ id: string; role: string | null }>,
  organization: Organization,
  action: SharedAppAction,
): void {
  if (deployer.email === null) return;
  const member = orgMembers.find((candidate) => candidate.id === deployerUserId);
  if (member && isOwnerOrAdmin(member.role)) return;
  throw new EveryAppError(
    "SHARED_APP_FORBIDDEN",
    `Only ${organization.name} owners and admins can ${action} shared apps\n${deployer.email} isn't an owner or admin of ${organization.name}, the platform organization.`,
    { fix: `ask an owner of ${organization.name} to make you an admin, or to do it for you` },
  );
}

/** What a login does to a shared app, which only the platform organization's owners and admins may. */
enum SharedAppAction {
  Deploy = "deploy",
  Register = "register",
  Delete = "delete",
  ChangeEmail = "change the email of",
}

/** What a registration writes, in one batch. */
function registrationWrites(
  plan: RegistrationPlan,
  now: number,
  columns: { secretNames: boolean },
): D1Statement[] {
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
  is_default, created_at, updated_at, scope)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16)`,
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
          app.scope,
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
    ...withoutAppData(app, now, columns),
    ...grants,
  ];
}

/**
 * What goes with a deleted app (deleteUpdate's companions): its email
 * configuration (`email_senders`, `email_inbound`), its recorded secret
 * names, everyone's access to it (direct and through groups), the personal
 * access tokens bound to it (revoked), its agent tools snapshot, its place
 * in AI connections, and every organization's settings on it (a monthly
 * cap). The same writes as the gateway's own delete
 * (AppRepository.tombstone).
 */
export function withoutAppData(
  app: Pick<AppRow, "id" | "organizationId">,
  now: number,
  /** `secretNames: false` on a Gateway whose D1 predates the column (`hasSecretNamesColumn`). */
  { secretNames = true }: { secretNames?: boolean } = {},
): D1Statement[] {
  const scoped = [app.id, app.organizationId];
  return [
    {
      sql: `UPDATE apps SET email_senders = NULL, email_inbound = NULL${secretNames ? ", secret_names = NULL" : ""} WHERE id = ? AND organization_id = ?`,
      params: scoped,
    },
    {
      sql: "DELETE FROM user_app_access WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: "DELETE FROM group_app_access WHERE app_row_id = ? AND organization_id = ?",
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
    {
      sql: "DELETE FROM org_app_settings WHERE app_row_id = ?",
      params: [app.id],
    },
  ];
}

/** An app's row by id, or null. */
export async function readAppById(db: D1Database, id: string): Promise<StoredAppRow | null> {
  const [rows = []] = await db.run([
    { sql: `SELECT ${await appColumns(db)} FROM apps WHERE id = ?`, params: [id] },
  ]);
  return rows[0] ? toAppRow(rows[0]) : null;
}

const MARK_DEPLOYED_ATTEMPTS = 3;

/**
 * The app's new Worker version is uploaded: record it, with the manifest it
 * was built from (its route policy goes live now), who deployed it and,
 * when the deploy listed them, the names of the secrets on the app's
 * Worker (`secret_names`; left as they were otherwise). A new app moves on
 * to `binding`, for the gateway to activate. Returns the app's status now.
 */
export function markDeployed(
  db: D1Database,
  appRowId: string,
  deployed: {
    versionId: string;
    manifest: unknown;
    actor: string;
    now?: number;
    /** The app Worker's own secret names, everyapp's left out, as `secret set` and `status` record them. */
    secretNames?: readonly string[];
  },
): Promise<string> {
  return registryCall(async () => {
    const names = await hasSecretNamesColumn(db);
    for (let attempt = 1; ; attempt += 1) {
      const app = await readAppById(db, appRowId);
      if (!app) {
        throw new RegistrationError({
          status: 404,
          code: "APP_NOT_FOUND",
          message: "The app's registry row is gone; deploy it again.",
        });
      }
      const update = markDeployedUpdate(app, deployed);
      // Only over the status it was read with: an admin switching the app
      // off meanwhile keeps it off. A null for the names keeps the column.
      const [changed = []] = await db.run([
        {
          sql: `UPDATE apps SET manifest = ?, version_id = ?, deployed_at = ?, deployed_by_actor = ?,
  status = ?, updated_at = ?${names ? ", secret_names = COALESCE(?, secret_names)" : ""}
WHERE id = ? AND status = ? RETURNING status`,
          params: [
            update.manifest,
            update.versionId,
            update.deployedAt,
            update.deployedByActor,
            update.status,
            update.deployedAt,
            ...(names ? [deployed.secretNames ? storedSecretNames(deployed.secretNames) : null] : []),
            appRowId,
            app.status,
          ],
        },
      ]);
      if (changed.length > 0) return update.status;
      if (attempt >= MARK_DEPLOYED_ATTEMPTS) {
        throw new EveryAppError(
          "APP_CHANGING",
          "The app's registry row keeps changing while this deploy records its upload\nThe upload is kept.",
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
  /** What the installation sends as and receives at (`everyapp email set`). */
  email: AppEmailConfig;
  /**
   * Whether the manifest the app was registered or last deployed from
   * declares inbound mail (`email: { inbound: true }`): its Worker exports
   * `email()`, so routes may name it. False until a deploy uploads the
   * declaration, however the local everyapp.config.ts reads.
   */
  declaresInbound: boolean;
  /**
   * The routes that manifest opens to anyone on the internet (`public` in
   * everyapp.config.ts), in its order; none until a deploy uploads them.
   */
  publicRoutes: PublicRouteSummary[];
  /**
   * The manifest the app was registered or last deployed from, as stored
   * (parsed, not validated: `secret set --app` validates it before it
   * routes a name by it); null when the row holds none that parses.
   */
  manifest: StoredManifest | null;
  /**
   * The names of the secrets on the app's own Worker, as the CLI last
   * recorded them (`deploy`, `register`, `secret set|unset`, `status`),
   * everyapp's own left out; null when never recorded, which the settings
   * model reads as unknown and never blocks on.
   */
  secretNames: string[] | null;
  /**
   * How the gateway reaches the app: `dispatch` for a third-party app in
   * the hosted gateway's dispatch namespace, whose settings the platform
   * doesn't gate at run time (the settings model leaves it out), otherwise
   * a service binding.
   */
  tier: string;
}

/** A stored manifest as JSON parses it: the settings model reads its fields as they are. */
type StoredManifest = SettingsManifestLike & { id?: unknown };

function info(app: StoredAppRow): RegisteredAppInfo {
  return {
    id: app.id,
    appSlug: app.appSlug,
    organizationId: app.organizationId,
    status: app.status,
    workerName: app.workerName ?? "",
    hostname: app.hostname ?? "",
    resources: appResources(app),
    email: { senders: parseEmailList(app.emailSenders), inbound: parseEmailList(app.emailInbound) },
    declaresInbound: declaresInbound(app.manifest),
    publicRoutes: storedPublicRoutes(app.manifest),
    manifest: parsedManifest(app.manifest),
    secretNames: parseSecretNames(app.secretNames),
    tier: app.tier,
  };
}

/** The stored manifest's JSON as an object, or null when it isn't one. */
function parsedManifest(stored: string | null): StoredManifest | null {
  if (!stored) return null;
  try {
    const manifest: unknown = JSON.parse(stored);
    return manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as StoredManifest)
      : null;
  } catch {
    return null;
  }
}

/**
 * The stored manifest's inbound declaration. The address list a manifest
 * carried before 2026-10-19 counts: that Worker exports `email()` too, and
 * the lenient schema reads the list as undeclared only to keep registering
 * the row until its redeploy.
 */
function declaresInbound(stored: string | null): boolean {
  if (!stored) return false;
  try {
    const manifest: unknown = JSON.parse(stored);
    const inbound = (manifest as { email?: { inbound?: unknown } } | null)?.email?.inbound;
    return inbound === true || Array.isArray(inbound);
  } catch {
    return false;
  }
}

/** The install organization's row for an app id, tombstones included. */
async function findAppIn(
  db: D1Database,
  appSlug: string,
): Promise<{ app: StoredAppRow; organization: Organization } | null> {
  const found = await installOrganization(db);
  if (!found) return null;
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND app_slug = ?`,
      params: [found.organization.id, appSlug],
    },
  ]);
  return rows[0] ? { app: toAppRow(rows[0]), organization: found.organization } : null;
}

/** {@link assertPlatformAdmin}, reading the organization's members. */
async function assertPlatformAdminIn(
  db: D1Database,
  deployer: Deployer,
  organization: Organization,
  action: SharedAppAction,
): Promise<void> {
  if (deployer.email === null) return;
  const [members = [], deployers = []] = await db.run(
    memberQueries(organization.id, deployer.email),
  );
  assertPlatformAdmin(deployer, text(deployers[0]?.["id"]), toMembers(members), organization, action);
}

function notRegistered(appSlug: string): EveryAppError {
  return new EveryAppError(
    "APP_NOT_FOUND",
    `${appSlug} isn't deployed to this Gateway yet`,
    { rerun: `${CLI} deploy`, rerunNote: "in the app's directory" },
  );
}

/** A registered app (not deleted) with names, for the commands that act on it. */
export async function readApp(
  db: D1Database,
  appSlug: string,
): Promise<RegisteredAppInfo> {
  const app = await findRegisteredApp(db, appSlug);
  if (!app) throw notRegistered(appSlug);
  return app;
}

/** A registered app (not deleted) with names, or null when there's none. */
export async function findRegisteredApp(
  db: D1Database,
  appSlug: string,
): Promise<RegisteredAppInfo | null> {
  const app = (await findAppIn(db, appSlug))?.app;
  return app && isRegistered(app) ? info(app) : null;
}

/** Not deleted, and named: an app the commands act on. */
function isRegistered(app: StoredAppRow): boolean {
  return app.status !== DELETED_APP_STATUS && Boolean(app.workerName);
}

/** The installation's email configuration by row id (`deploy` reads it under the app's lease). */
export async function readAppEmail(db: D1Database, appRowId: string): Promise<AppEmailConfig> {
  const [rows = []] = await db.run([
    { sql: "SELECT email_senders, email_inbound FROM apps WHERE id = ?", params: [appRowId] },
  ]);
  const row = rows[0];
  if (!row) {
    throw new EveryAppError("APP_NOT_FOUND", "The app is no longer registered on this Gateway", {
      rerun: `${CLI} deploy`,
      rerunNote: "in the app's directory",
    });
  }
  return { senders: parseEmailList(row["email_senders"]), inbound: parseEmailList(row["email_inbound"]) };
}

/**
 * `everyapp email set|unset`: store the installation's lists, as JSON or
 * null for none; never the manifest. A shared app is every organization's:
 * only the platform organization's owners and admins change it (as
 * `deleteApp`). Returns the app as it is now.
 */
export async function writeAppEmail(
  db: D1Database,
  appSlug: string,
  config: AppEmailConfig,
  deployer: Deployer,
  now = Date.now(),
): Promise<RegisteredAppInfo> {
  return registryCall(async () => {
    const found = await findAppIn(db, appSlug);
    if (!found || !isRegistered(found.app)) throw notRegistered(appSlug);
    const { app, organization } = found;
    if (app.scope === "shared") {
      await assertPlatformAdminIn(db, deployer, organization, SharedAppAction.ChangeEmail);
    }
    const emailSenders = storedEmailList(config.senders);
    const emailInbound = storedEmailList(config.inbound);
    const [changed = []] = await db.run([
      {
        sql: `UPDATE apps SET email_senders = ?, email_inbound = ?, updated_at = ?
WHERE id = ? AND status != '${DELETED_APP_STATUS}' RETURNING id`,
        params: [emailSenders, emailInbound, now, app.id],
      },
    ]);
    if (changed.length === 0) throw notRegistered(appSlug);
    return info({ ...app, emailSenders, emailInbound });
  });
}

/**
 * Record the names of the secrets on the app's own Worker (`secret_names`),
 * as `secret set|unset` and `status` list them after a change, so the
 * gateway can tell whether the app's own settings are set without reaching
 * Cloudflare. By row id, under whatever lease the caller holds; a deleted
 * app is left alone.
 */
export async function writeAppSecretNames(
  db: D1Database,
  appRowId: string,
  names: readonly string[],
  now = Date.now(),
): Promise<void> {
  // A Gateway from before the column has nowhere to keep them: `update` adds it.
  if (!(await hasSecretNamesColumn(db))) return;
  await db.run([
    {
      sql: `UPDATE apps SET secret_names = ?, updated_at = ?
WHERE id = ? AND status != '${DELETED_APP_STATUS}'`,
      params: [storedSecretNames(names), now, appRowId],
    },
  ]);
}

/**
 * The id of the app (deleted ones aside) whose Worker, or one of whose
 * helper Workers (`<worker>--<helper>`), is `workerName`: what a person
 * knows it by.
 */
export async function appIdOfWorker(db: D1Database, workerName: string): Promise<string | null> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT app_slug FROM apps WHERE status != '${DELETED_APP_STATUS}' AND (worker_name = ? OR substr(?, 1, length(worker_name) + 2) = worker_name || '--')`,
      params: [workerName, workerName],
    },
  ]);
  return text(rows[0]?.["app_slug"]);
}

/** Every app the registry lists, deleted ones aside, by app id. */
export async function listApps(db: D1Database): Promise<
  Array<RegisteredAppInfo & { deployedBy: string | null; deployedAt: number | null }>
> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${await appColumns(db)} FROM apps WHERE status != '${DELETED_APP_STATUS}' ORDER BY app_slug, organization_id`,
    },
  ]);
  return rows.map(toAppRow).map((app) => ({
    ...info(app),
    deployedBy: app.deployedByActor,
    deployedAt: app.deployedAt,
  }));
}

/** What a row names in Cloudflare, as the teardown reads every row. */
interface AppRowNames {
  appSlug: string;
  hostname: string | null;
  workerName: string | null;
  status: string;
}

/**
 * Every `apps` row, tombstones included (a deleted app's Worker may still
 * exist), with the names it holds; empty when the database has no `apps`
 * table (a Gateway D1 whose install never finished). Reads only.
 */
export async function listAppRows(db: D1Database): Promise<AppRowNames[]> {
  const [tables = []] = await db.run([
    { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'apps'" },
  ]);
  if (tables.length === 0) return [];
  const [rows = []] = await db.run([
    { sql: "SELECT app_slug, hostname, worker_name, status FROM apps ORDER BY app_slug" },
  ]);
  return rows.map((row) => ({
    appSlug: String(row["app_slug"]),
    hostname: text(row["hostname"]),
    workerName: text(row["worker_name"]),
    status: String(row["status"]),
  }));
}

/**
 * Delete an app, leaving a tombstone: unrouted and unlisted, its names
 * still its organization's, with nothing of its access, tokens, tools or AI
 * connections left. An app deleted already writes nothing, so a delete
 * that stopped part-way can run again. A shared app is every
 * organization's: only the platform organization's owners and admins delete
 * it. Returns the app as it was named, and whether it was deleted already.
 */
export async function deleteApp(
  db: D1Database,
  appSlug: string,
  deployer: Deployer,
  now = Date.now(),
): Promise<RegisteredAppInfo & { alreadyDeleted: boolean }> {
  const found = await findAppIn(db, appSlug);
  if (!found || !found.app.workerName) {
    throw new EveryAppError("APP_NOT_FOUND", `No app named ${appSlug} on this Gateway`, {
      rerun: `${CLI} status`,
      rerunNote: "lists its apps",
    });
  }
  const { app, organization } = found;
  if (app.scope === "shared") {
    await assertPlatformAdminIn(db, deployer, organization, SharedAppAction.Delete);
  }
  const update = deleteUpdate(app);
  if (update) {
    await db.run([
      {
        sql: "UPDATE apps SET status = ?, is_default = ?, updated_at = ? WHERE id = ?",
        params: [update.status, update.isDefault ? 1 : 0, now, app.id],
      },
      ...withoutAppData(app, now, { secretNames: await hasSecretNamesColumn(db) }),
    ]);
  }
  return { ...info(app), status: DELETED_APP_STATUS, alreadyDeleted: update === null };
}
