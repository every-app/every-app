/**
 * MCP apps in the Gateway's registry, both kinds, as `everyapp mcp` reads
 * and writes them (docs/design/2026-10-mcp-by-url.md): a built-in provider
 * app (DataForSEO, `PROVIDER_APPS`) and a remote MCP server registered by
 * URL, a provider-tier row whose manifest carries a `remote` block. Every
 * write goes to the Gateway's D1 under the operator's Cloudflare login
 * (ADR-0003), with the rules in `@every-app/perimeter/registry`
 * (remoteMcpApps.ts): this reads the rows they need and writes what they
 * return, each change in one batch. All the SQL of `mcp add|remove|on|off|
 * list|show|refresh|tool` and of the credential binding is here, so the
 * Gateway's server functions and workspace tools can mirror the shapes.
 *
 * `on` and `off` are the status (`active` serves, `disabled` keeps access,
 * tokens and the snapshot and serves nothing); `remove` is the tombstone,
 * as `everyapp delete` leaves for a deployed app. The credential a remote
 * app declares (`<ID>_MCP_TOKEN`) is a Gateway setting `secret set` sets;
 * `remote_mcp_credentials` (migration 0011) pins it to the origin it was
 * set for, and `remote_mcp_tools` is what the Gateway last listed, tool by
 * tool. A Gateway whose D1 predates migration 0011 has neither table until
 * `everyapp update`: reads treat them as empty and writes leave them alone.
 *
 * Each change queues its event in the batch that writes it (the outbox,
 * ./events.ts; nothing on a Gateway from before migration 0012):
 * `mcp_app.added` for a remote app added or revived (a built-in's is
 * providerApps.ts's), `mcp_app.enabled` and `mcp_app.disabled` for `on` and
 * `off`, `mcp_app.removed` for the tombstone, with the app and its kind.
 */
import {
  DELETED_APP_STATUS,
  isRemoteMcpRow,
  mcpAppRemoveUpdate,
  mcpAppStatusUpdate,
  planRemoteMcpAppAdd,
  remoteMcpAppUpdate,
  remoteMcpBlockOf,
  type McpAppStatus,
  type RemoteMcpAddPlan,
} from "@every-app/perimeter/registry";
import {
  isProviderAppId,
  isRemoteMcpSecretName,
  PROVIDER_APP_IDS,
  PROVIDER_APP_TIER,
  PROVIDER_APPS,
  providerAppKeySetting,
  remoteMcpIdFromUrl,
  remoteMcpSecretOf,
  remoteToolEnabled,
  remoteToolRisk,
  type RemoteMcpBlock,
  type RemoteMcpToolOverride,
  type RemoteMcpUrlEnv,
  type RemoteToolRiskSource,
  type ToolRisk,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { operatorActor, queueEventFromCli, type EventApp } from "./events";
import {
  appColumns,
  ensureInstallOrganization,
  hasSecretNamesColumn,
  installOrganization,
  memberQueries,
  registryCall,
  text,
  toAppRow,
  toMembers,
  withoutAppData,
  type Deployer,
  type Organization,
  type StoredAppRow,
} from "./registry";

type D1Row = Record<string, unknown>;

/** Which of migration 0011's tables this Gateway's D1 has. */
interface RemoteMcpTables {
  /** `remote_mcp_credentials`: which origin each credential is pinned to. */
  credentials: boolean;
  /** `remote_mcp_tools`: what each remote server listed, tool by tool. */
  tools: boolean;
}

const remoteTables = new WeakMap<D1Database, Promise<RemoteMcpTables>>();

/**
 * Whether the Gateway's D1 has migration 0011's tables (2026-10-25). A
 * Gateway from before it serves no remote MCP app until `update` runs its
 * migrations; until then reads find nothing and writes skip them, so the
 * other commands keep working against it. Asked of each database once.
 */
export function remoteMcpTables(db: D1Database): Promise<RemoteMcpTables> {
  let known = remoteTables.get(db);
  if (!known) {
    known = db
      .run([
        {
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('remote_mcp_credentials', 'remote_mcp_tools')",
        },
      ])
      .then(([rows = []]) => {
        const names = new Set(rows.map((row) => String(row["name"])));
        return {
          credentials: names.has("remote_mcp_credentials"),
          tools: names.has("remote_mcp_tools"),
        };
      });
    remoteTables.set(db, known);
  }
  return known;
}

/** An MCP app of either kind, by id, in the install organization. */
export interface McpAppRef {
  kind: "builtin" | "remote";
  id: string;
  /** The install organization; null before the Gateway has one. */
  organization: Organization | null;
  /** Its row, tombstones included; null when it was never added (a built-in only). */
  app: StoredAppRow | null;
}

/** What an `mcp_app.*` event says of a row: the catalogue's `app` and its kind. */
function mcpAppEventData(app: StoredAppRow): { app: EventApp; kind: McpAppRef["kind"] } {
  return { app: { id: app.appSlug, rowId: app.id, name: app.name }, kind: isRemoteMcpRow(app) ? "remote" : "builtin" };
}

/** The URL of a row's `remote` block, read even from a tombstone. */
function remoteUrlOf(app: Pick<StoredAppRow, "tier" | "manifest">): string | null {
  return remoteMcpBlockOf(app)?.url ?? null;
}

/** The install organization's row for an id, tombstones included. */
async function rowFor(db: D1Database, organizationId: string, id: string): Promise<StoredAppRow | null> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND app_slug = ?`,
      params: [organizationId, id],
    },
  ]);
  return rows[0] ? toAppRow(rows[0]) : null;
}

/** The install organization's live remote MCP apps' ids, for what a refusal names. */
async function remoteIds(db: D1Database, organizationId: string): Promise<string[]> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND tier = ? AND status != '${DELETED_APP_STATUS}' ORDER BY app_slug`,
      params: [organizationId, PROVIDER_APP_TIER],
    },
  ]);
  return rows.map(toAppRow).filter(isRemoteMcpRow).map((app) => app.appSlug);
}

/**
 * An id as an MCP app: a built-in's (with its row, if it has one), or a
 * remote app's row (a tombstone included: `on` and `show` say how to add
 * it again). Anything else is PROVIDER_APP_UNKNOWN, naming the built-ins
 * and the remote apps there are, or for a deployed app's id, the command
 * that removes a deployed app.
 */
export async function resolveMcpApp(db: D1Database, id: string): Promise<McpAppRef> {
  const found = await installOrganization(db);
  const organization = found?.organization ?? null;
  const app = organization ? await rowFor(db, organization.id, id) : null;
  if (isProviderAppId(id)) {
    return { kind: "builtin", id, organization, app: app && app.tier === PROVIDER_APP_TIER ? app : null };
  }
  if (app && isRemoteMcpRow(app)) return { kind: "remote", id, organization, app };
  if (app && app.tier !== PROVIDER_APP_TIER && app.status !== DELETED_APP_STATUS) {
    throw new EveryAppError(
      "PROVIDER_APP_UNKNOWN",
      `"${id}" is an app deployed to this Gateway, not an MCP app\n${CLI} delete ${id} removes a deployed app.`,
      { rerun: `${CLI} mcp list`, rerunNote: "lists the MCP apps" },
    );
  }
  const remote = organization ? await remoteIds(db, organization.id) : [];
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(id);
  throw new EveryAppError(
    "PROVIDER_APP_UNKNOWN",
    [
      `"${id}" is not an MCP app on this Gateway`,
      `Built in: ${PROVIDER_APP_IDS.join(", ")}. Added: ${remote.length > 0 ? remote.join(", ") : "none yet"}.`,
    ].join("\n"),
    looksLikeUrl
      ? { rerun: `${CLI} mcp add ${id}`, rerunNote: "adds the server at that address" }
      : { rerun: `${CLI} mcp list`, rerunNote: "lists the MCP apps" },
  );
}

/** A remote app's tombstone, refused with the command that adds it again. */
export function removedRemoteApp(ref: McpAppRef): EveryAppError {
  const url = ref.app ? remoteUrlOf(ref.app) : null;
  return new EveryAppError(
    "APP_NOT_FOUND",
    `${ref.id} was removed from this Gateway\nAdding it again starts fresh: nobody's access or tools are kept.`,
    url
      ? { rerun: `${CLI} mcp add ${url} --name ${ref.id}`, rerunNote: "adds it again" }
      : { rerun: `${CLI} mcp list`, rerunNote: "lists the MCP apps" },
  );
}

/**
 * The origins live MCP apps send each credential name to, across every
 * organization (the Gateway has one set of secrets): a name the registry
 * binds to one origin (REMOTE_MCP_SECRET_TAKEN otherwise).
 */
async function credentialOrigins(db: D1Database): Promise<Map<string, Set<string>>> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT tier, manifest FROM apps WHERE tier = ? AND status != '${DELETED_APP_STATUS}'`,
      params: [PROVIDER_APP_TIER],
    },
  ]);
  const origins = new Map<string, Set<string>>();
  for (const row of rows) {
    const block = remoteMcpBlockOf({ tier: String(row["tier"]), manifest: text(row["manifest"]) });
    const secret = block ? remoteMcpSecretOf(block.auth) : null;
    if (!block || !secret) continue;
    let origin: string;
    try {
      origin = new URL(block.url).origin;
    } catch {
      continue;
    }
    const set = origins.get(secret) ?? new Set<string>();
    set.add(origin);
    origins.set(secret, set);
  }
  return origins;
}

export interface RemoteMcpAddInput {
  url: string;
  /** `--name`: the app id (derived from the URL's host when absent). */
  id?: string;
  /** The display name (default: the id). */
  name?: string;
  description?: string;
  /** The auth block as the flags give it (`{ kind: "bearer" }` takes the default name). */
  auth: Record<string, unknown>;
  risk?: string;
  /** What the URL is checked against: the Gateway's own address and app domain. */
  env: RemoteMcpUrlEnv;
  deployer: Deployer;
  /** Names the organization created when the Gateway has none yet. */
  organizationName: string;
  now?: number;
}

interface RemoteMcpAdded {
  plan: RemoteMcpAddPlan;
  organization: Organization;
  /** The Gateway has an owner. */
  hasOwner: boolean;
  /** The person adding it is a member and was granted it. */
  actorGranted: boolean;
}

/** What adding a remote MCP app writes, in one batch (the row, its grants; a revived one's leftovers cleared). */
function addWrites(
  plan: RemoteMcpAddPlan,
  now: number,
  columns: { secretNames: boolean; remoteTools: boolean },
): D1Statement[] {
  const { app } = plan;
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
VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8, NULL, ?9, ?10, 0, ?11, ?11, ?12)`,
        params: [
          app.id,
          app.organizationId,
          app.appSlug,
          app.name,
          app.description,
          app.tier,
          app.manifest,
          app.status,
          app.deployedAt,
          app.deployedByActor,
          now,
          app.scope,
        ],
      },
      ...grants,
    ];
  }
  // Its own tombstone comes back as new: nothing of the old access, tokens,
  // snapshot or listing is kept.
  return [
    {
      sql: `UPDATE apps SET name = ?, description = ?, manifest = ?, status = ?, is_default = 0,
  deployed_at = ?, deployed_by_actor = ?, updated_at = ?
WHERE id = ? AND status = '${DELETED_APP_STATUS}'`,
      params: [
        app.name,
        app.description,
        app.manifest,
        app.status,
        app.deployedAt,
        app.deployedByActor,
        now,
        app.id,
      ],
    },
    ...withoutAppData(app, now, { secretNames: columns.secretNames }),
    ...(columns.remoteTools ? [remoteToolsDelete(app)] : []),
    ...grants,
  ];
}

function remoteToolsDelete(app: Pick<StoredAppRow, "id" | "organizationId">): D1Statement {
  return {
    sql: "DELETE FROM remote_mcp_tools WHERE app_row_id = ? AND organization_id = ?",
    params: [app.id, app.organizationId],
  };
}

/**
 * Register a remote MCP server in the install organization (created when
 * the Gateway has none yet): the row `active` at once, granted to the
 * person adding it and the owners and admins, or its own tombstone revived
 * as new. The registry's refusals (REMOTE_MCP_URL_REFUSED,
 * REMOTE_MCP_INVALID, REMOTE_MCP_EXISTS, REMOTE_MCP_SECRET_TAKEN,
 * APP_TIER_MISMATCH) write nothing.
 */
export function addRemoteMcpApp(db: D1Database, input: RemoteMcpAddInput): Promise<RemoteMcpAdded> {
  return registryCall(async () => {
    const now = input.now ?? Date.now();
    const url = input.url.trim();
    // The id the rules will take, so its row is read in the same batch.
    const id = (input.id ?? "").trim() || remoteMcpIdFromUrl(url) || "";
    const { organization, hasOwner } = await ensureInstallOrganization(db, input.organizationName, now);
    const [existing = [], members = [], actors = []] = await db.run([
      {
        sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND app_slug = ?`,
        params: [organization.id, id],
      },
      ...memberQueries(organization.id, input.deployer.email),
    ]);
    const existingApp = existing[0] ? toAppRow(existing[0]) : null;
    const origins = await credentialOrigins(db);
    const actorUserId = text(actors[0]?.["id"]);
    const plan = planRemoteMcpAppAdd({
      organizationId: organization.id,
      url,
      id: input.id,
      name: input.name,
      description: input.description,
      auth: input.auth,
      risk: input.risk,
      env: input.env,
      existingApp: (slug) => {
        if (slug !== id) throw new Error(`The rules asked for "${slug}", not "${id}".`);
        return existingApp;
      },
      secretUsedAt: (secret) => {
        const used = [...(origins.get(secret) ?? [])];
        const origin = new URL(url).origin;
        return used.find((each) => each !== origin) ?? used[0] ?? null;
      },
      members: toMembers(members),
      actorUserId,
      actor: input.deployer.actor,
      now,
    });
    const tables = await remoteMcpTables(db);
    const added = await queueEventFromCli(db, {
      organizationId: organization.id,
      type: "mcp_app.added",
      actor: operatorActor(input.deployer),
      data: { app: { id: plan.app.appSlug, rowId: plan.app.id, name: plan.app.name }, kind: "remote" },
      appRowId: plan.app.id,
      // The revival is conditional on the tombstone: only if the row was written now.
      onlyIf: {
        sql: "EXISTS (SELECT 1 FROM apps WHERE id = ? AND status = ? AND updated_at = ?)",
        params: [plan.app.id, plan.app.status, now],
      },
      now,
    });
    await db.run([
      ...addWrites(plan, now, { secretNames: await hasSecretNamesColumn(db), remoteTools: tables.tools }),
      ...added,
    ]);
    return {
      plan,
      organization,
      hasOwner,
      actorGranted: actorUserId !== null && plan.grants.some((grant) => grant.userId === actorUserId),
    };
  });
}

/**
 * Turn an MCP app on or off (`active` ↔ `disabled`), either kind, by its
 * row; a built-in's first `on` is `turnProviderAppOn` instead (it creates
 * the row). Off keeps everyone's access, the tokens and the snapshot, so on
 * is instant. The change queues `mcp_app.enabled` or `mcp_app.disabled`
 * in the same batch, as `deployer`. Whether it changed (false: it was in
 * that state already).
 */
export function setMcpAppStatus(
  db: D1Database,
  app: StoredAppRow,
  status: McpAppStatus,
  deployer: Deployer,
  now = Date.now(),
): Promise<{ changed: boolean }> {
  return registryCall(async () => {
    const update = mcpAppStatusUpdate(app, status);
    if (!update) return { changed: false };
    const event = await queueEventFromCli(db, {
      organizationId: app.organizationId,
      type: update.status === "active" ? "mcp_app.enabled" : "mcp_app.disabled",
      actor: operatorActor(deployer),
      data: mcpAppEventData(app),
      appRowId: app.id,
      // Only if the update below landed.
      onlyIf: {
        sql: "EXISTS (SELECT 1 FROM apps WHERE id = ? AND status = ? AND updated_at = ?)",
        params: [app.id, update.status, now],
      },
      now,
    });
    // Only over the status it was read with: a remove meanwhile stays a remove.
    const [changed = []] = await db.run([
      {
        sql: "UPDATE apps SET status = ?, updated_at = ? WHERE id = ? AND status = ? RETURNING id",
        params: [update.status, now, app.id, app.status],
      },
      ...event,
    ]);
    if (changed.length === 0) {
      throw new EveryAppError(
        "APP_CHANGING",
        `${app.appSlug} changed while this ran\nNothing was written; run it again.`,
        { retryable: true },
      );
    }
    return { changed: true };
  });
}

/**
 * Remove an MCP app of either kind: the tombstone a deleted app leaves,
 * with everyone's access, the tokens bound to it, its snapshot, its
 * listing and its place in AI connections gone. The credential (a Gateway
 * setting) and its binding stay; `secret unset` removes them. The
 * tombstone queues `mcp_app.removed` in the same batch, as `deployer`.
 * Whether anything was removed (false: no row, or a tombstone already).
 */
export function removeMcpApp(
  db: D1Database,
  app: StoredAppRow | null,
  deployer: Deployer,
  now = Date.now(),
): Promise<{ removed: boolean }> {
  return registryCall(async () => {
    const update = mcpAppRemoveUpdate(app);
    if (!app || !update) return { removed: false };
    const tables = await remoteMcpTables(db);
    await db.run([
      {
        sql: "UPDATE apps SET status = ?, is_default = ?, updated_at = ? WHERE id = ?",
        params: [update.status, update.isDefault ? 1 : 0, now, app.id],
      },
      ...withoutAppData(app, now, { secretNames: await hasSecretNamesColumn(db) }),
      ...(tables.tools ? [remoteToolsDelete(app)] : []),
      ...(await queueEventFromCli(db, {
        organizationId: app.organizationId,
        type: "mcp_app.removed",
        actor: operatorActor(deployer),
        data: mcpAppEventData(app),
        appRowId: app.id,
        now,
      })),
    ]);
    return { removed: true };
  });
}

/** An app's tools snapshot as the Gateway last took it (`app_tool_catalogs`). */
export interface ToolSnapshot {
  /** `ok`, `empty`, `unsupported` or `error`. */
  status: string;
  toolCount: number;
  /** When it was taken, or last tried (ms). */
  listedAt: number | null;
  lastError: string | null;
}

function toSnapshot(row: D1Row | undefined): ToolSnapshot | null {
  if (!row) return null;
  return {
    status: String(row["status"]),
    toolCount: Number(row["tool_count"] ?? 0),
    listedAt: row["fetched_at"] == null ? null : Number(row["fetched_at"]),
    lastError: text(row["last_error"]),
  };
}

/**
 * Drop an MCP app's tools snapshot (`app_tool_catalogs` and `app_tools`,
 * nothing else), so the Gateway lists its tools again on the next /mcp
 * request, or within the hour for a remote app (the maintenance cron).
 * Returns the snapshot it dropped, null when there was none.
 */
export async function refreshMcpAppTools(db: D1Database, app: StoredAppRow): Promise<ToolSnapshot | null> {
  const scoped = [app.id, app.organizationId];
  const [catalog = []] = await db.run([
    {
      sql: "SELECT status, tool_count, fetched_at, last_error FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    { sql: "DELETE FROM app_tools WHERE app_row_id = ? AND organization_id = ?", params: scoped },
    { sql: "DELETE FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?", params: scoped },
  ]);
  return toSnapshot(catalog[0]);
}

/** A credential's pin: the origin `secret set` (or the Gateway's first use) bound it to. */
export interface CredentialBinding {
  origin: string;
  boundBy: string | null;
  boundAt: number | null;
}

/** Every credential binding, by name; empty on a Gateway from before migration 0011. */
export async function readCredentialBindings(db: D1Database): Promise<Map<string, CredentialBinding>> {
  if (!(await remoteMcpTables(db)).credentials) return new Map();
  const [rows = []] = await db.run([
    { sql: "SELECT name, origin, bound_by, bound_at FROM remote_mcp_credentials ORDER BY name" },
  ]);
  return new Map(
    rows.map((row) => [
      String(row["name"]),
      {
        origin: String(row["origin"]),
        boundBy: text(row["bound_by"]),
        boundAt: row["bound_at"] == null ? null : Number(row["bound_at"]),
      },
    ]),
  );
}

/** One MCP app as `mcp list` reads it. */
interface McpAppEntry {
  id: string;
  name: string;
  kind: "builtin" | "remote";
  /** Its live row; null for a built-in that was never added (or was removed). */
  app: StoredAppRow | null;
  /** A remote app's block (null when it can't be read, or for a built-in). */
  remote: RemoteMcpBlock | null;
  /** The Gateway setting holding its key or credential; null when it takes none. */
  keyName: string | null;
  snapshot: ToolSnapshot | null;
}

/**
 * Every MCP app of the install organization: each built-in (added or not),
 * then each live remote app, by id. Reads only.
 */
export async function listMcpApps(db: D1Database): Promise<McpAppEntry[]> {
  const found = await installOrganization(db);
  const rows: StoredAppRow[] = [];
  const snapshots = new Map<string, ToolSnapshot>();
  if (found) {
    const [apps = [], catalogs = []] = await db.run([
      {
        sql: `SELECT ${await appColumns(db)} FROM apps WHERE organization_id = ? AND tier = ? AND status != '${DELETED_APP_STATUS}' ORDER BY app_slug`,
        params: [found.organization.id, PROVIDER_APP_TIER],
      },
      {
        sql: "SELECT app_row_id, status, tool_count, fetched_at, last_error FROM app_tool_catalogs WHERE organization_id = ?",
        params: [found.organization.id],
      },
    ]);
    rows.push(...apps.map(toAppRow));
    for (const catalog of catalogs) snapshots.set(String(catalog["app_row_id"]), toSnapshot(catalog)!);
  }
  const bySlug = new Map(rows.map((app) => [app.appSlug, app]));
  const builtins: McpAppEntry[] = PROVIDER_APP_IDS.map((id) => {
    const app = bySlug.get(id) ?? null;
    return {
      id,
      name: PROVIDER_APPS[id].name,
      kind: "builtin",
      app,
      remote: null,
      keyName: providerAppKeySetting(id),
      snapshot: app ? (snapshots.get(app.id) ?? null) : null,
    };
  });
  const remotes: McpAppEntry[] = rows
    .filter((app) => !isProviderAppId(app.appSlug) && isRemoteMcpRow(app))
    .map((app) => {
      const remote = remoteMcpBlockOf(app);
      return {
        id: app.appSlug,
        name: app.name,
        kind: "remote",
        app,
        remote,
        keyName: remote ? remoteMcpSecretOf(remote.auth) : null,
        snapshot: snapshots.get(app.id) ?? null,
      };
    });
  return [...builtins, ...remotes];
}

/** Where an MCP app stands, as `mcp list` and `mcp show` say it. */
export type McpAppState = "on" | "off" | "needs setup" | "not added";

/**
 * An MCP app's state: not added (a built-in with no live row), off (not
 * `active`), needs setup (its key or credential isn't set, a remote app's
 * block can't be read, or its credential is pinned to another origin), or
 * on. An OAuth server reads as on or off: what it needs is said beside it
 * ("not supported yet"), since nothing can be set for it.
 */
export function mcpAppState(
  entry: Pick<McpAppEntry, "kind" | "app" | "remote" | "keyName">,
  gatewayNames: readonly string[],
  bindings: ReadonlyMap<string, CredentialBinding>,
): McpAppState {
  if (!entry.app || entry.app.status === DELETED_APP_STATUS) return "not added";
  if (entry.app.status !== "active") return "off";
  if (entry.kind === "remote" && !entry.remote) return "needs setup";
  if (entry.keyName && !gatewayNames.includes(entry.keyName)) return "needs setup";
  if (entry.kind === "remote" && entry.keyName && entry.remote) {
    const binding = bindings.get(entry.keyName);
    if (binding && binding.origin !== originOf(entry.remote.url)) return "needs setup";
  }
  return "on";
}

/** A URL's origin, or "" when it doesn't parse. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** One tool of a remote app, as `mcp show` lists it. */
interface RemoteToolEntry {
  /** The listed name (`<id>_<local>`), or null when the Gateway couldn't list it. */
  name: string | null;
  /** The server's own name for it. */
  serverName: string;
  title: string | null;
  /** The effective risk: the catalog's when listed, else what the rules give. */
  risk: ToolRisk;
  /** Where the risk comes from: the operator's override, the app's default, the server's hint, or the fallback. */
  source: RemoteToolRiskSource;
  /** Listed (on), or why not. */
  on: boolean;
  problem: string | null;
}

/** One tool of a built-in app, as the Gateway's catalog has it. */
interface CatalogToolEntry {
  name: string;
  title: string | null;
  risk: string;
}

/** What `mcp show` reads beyond the row: the snapshot, the tools, the credential's pin. */
interface McpAppDetail {
  snapshot: ToolSnapshot | null;
  /** A remote app's tools as last listed, joined with the catalog. */
  remoteTools: RemoteToolEntry[];
  /** The catalog's tools (`app_tools`), for a built-in. */
  catalogTools: CatalogToolEntry[];
  /** The credential's binding, when it has a credential and one is recorded. */
  binding: CredentialBinding | null;
  /** Whether the Gateway's D1 has `remote_mcp_tools` (migration 0011). */
  listingKnown: boolean;
}

/** The hints a stored `risk_hint` stands for, in `remoteToolRisk`'s terms. */
function hintsOf(riskHint: string): { readOnlyHint?: boolean; destructiveHint?: boolean } {
  if (riskHint === "read") return { readOnlyHint: true };
  if (riskHint === "destructive") return { destructiveHint: true };
  return {};
}

/**
 * Each listed tool's effective risk and its source: the catalog's risk
 * when it is in the catalog (the Gateway decided it), else what the rules
 * give from the server's hint and the block; the source always from the
 * rules on the current block (`remoteToolRisk`), with an explicit `write`
 * hint counted as the server's.
 */
function remoteToolEntries(
  id: string,
  block: Pick<RemoteMcpBlock, "risk" | "tools">,
  listed: readonly D1Row[],
  catalog: ReadonlyMap<string, string>,
): RemoteToolEntry[] {
  return listed.map((row) => {
    const serverName = String(row["upstream_name"]);
    const riskHint = String(row["risk_hint"]);
    const local = text(row["local_name"]);
    const ruled = remoteToolRisk(hintsOf(riskHint), block, serverName);
    const source: RemoteToolRiskSource = ruled.source === "default" && riskHint === "write" ? "hint" : ruled.source;
    const catalogRisk = local ? catalog.get(local) : undefined;
    const enabled = remoteToolEnabled(block, serverName);
    const isListed = Boolean(Number(row["listed"]));
    return {
      name: local ? `${id}_${local}` : null,
      serverName,
      title: text(row["title"]),
      risk: (catalogRisk as ToolRisk | undefined) ?? ruled.risk,
      source,
      on: enabled && isListed,
      problem: !enabled
        ? isListed
          ? "turned off; leaves the catalog at the next listing"
          : "turned off"
        : isListed
          ? null
          : (text(row["problem"]) ?? "not listed"),
    };
  });
}

/** Everything `mcp show` says about an app beyond its row. */
export async function readMcpAppDetail(
  db: D1Database,
  ref: McpAppRef & { app: StoredAppRow },
  remote: RemoteMcpBlock | null,
): Promise<McpAppDetail> {
  const scoped = [ref.app.id, ref.app.organizationId];
  const tables = await remoteMcpTables(db);
  const secret = remote ? remoteMcpSecretOf(remote.auth) : null;
  const [catalog = [], tools = [], listed = [], bindings = []] = await db.run([
    {
      sql: "SELECT status, tool_count, fetched_at, last_error FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    { sql: "SELECT name, title, risk FROM app_tools WHERE app_row_id = ? AND organization_id = ? ORDER BY name", params: scoped },
    ...(tables.tools && remote
      ? [
          {
            sql: `SELECT upstream_name, local_name, title, risk_hint, listed, problem, listed_at FROM remote_mcp_tools
WHERE app_row_id = ? AND organization_id = ? ORDER BY upstream_name`,
            params: scoped,
          },
        ]
      : [{ sql: "SELECT 1 WHERE 0" }]),
    ...(tables.credentials && secret
      ? [{ sql: "SELECT origin, bound_by, bound_at FROM remote_mcp_credentials WHERE name = ?", params: [secret] }]
      : [{ sql: "SELECT 1 WHERE 0" }]),
  ]);
  const catalogRisks = new Map(tools.map((tool) => [String(tool["name"]), String(tool["risk"])]));
  const binding = bindings[0];
  return {
    snapshot: toSnapshot(catalog[0]),
    remoteTools: remote ? remoteToolEntries(ref.id, remote, listed, catalogRisks) : [],
    catalogTools: tools.map((tool) => ({
      name: `${ref.id}_${String(tool["name"])}`,
      title: text(tool["title"]),
      risk: String(tool["risk"]),
    })),
    binding: binding
      ? {
          origin: String(binding["origin"]),
          boundBy: text(binding["bound_by"]),
          boundAt: binding["bound_at"] == null ? null : Number(binding["bound_at"]),
        }
      : null,
    listingKnown: tables.tools,
  };
}

/** What `mcp tool` changes about one tool: its risk (`annotations` clears the override), whether it is on. */
interface RemoteToolChange {
  risk?: ToolRisk | "annotations";
  enabled?: boolean;
}

interface RemoteToolChanged {
  /** The server's name the override is keyed by. */
  serverName: string;
  /** The listed name, when the last listing had the tool. */
  listedName: string | null;
  /** Whether the last listing had it (false: taken verbatim as the server's name). */
  inListing: boolean;
  /** The override before and after (null: none). */
  before: RemoteMcpToolOverride | null;
  after: RemoteMcpToolOverride | null;
  /** The block's revision after the change. */
  rev: number;
}

const TOOL_WRITE_ATTEMPTS = 3;

/**
 * Change one tool of a remote app: `tool` is the server's name or the
 * listed name (`<id>_<local>` or `<local>`), resolved through the last
 * listing (`remote_mcp_tools`); a name it doesn't have is taken as the
 * server's verbatim. The manifest's override map changes and its `rev` is
 * bumped, so the Gateway lists the tools again on first use. Written only
 * over the manifest it was read with, read again when it changed meanwhile.
 */
export function setRemoteMcpTool(
  db: D1Database,
  ref: McpAppRef & { app: StoredAppRow },
  tool: string,
  change: RemoteToolChange,
  now = Date.now(),
): Promise<RemoteToolChanged> {
  return registryCall(async () => {
    const tables = await remoteMcpTables(db);
    const [matches = []] = await db.run([
      tables.tools
        ? {
            sql: `SELECT upstream_name, local_name FROM remote_mcp_tools
WHERE app_row_id = ?1 AND (upstream_name = ?2 OR local_name = ?2 OR ?3 || local_name = ?2)
ORDER BY (upstream_name = ?2) DESC, upstream_name LIMIT 1`,
            params: [ref.app.id, tool, `${ref.id}_`],
          }
        : { sql: "SELECT 1 WHERE 0" },
    ]);
    const match = matches[0];
    const serverName = match ? String(match["upstream_name"]) : tool;
    const local = match ? text(match["local_name"]) : null;
    const override: RemoteMcpToolOverride = {};
    if (change.risk === "annotations") override.risk = undefined;
    else if (change.risk) override.risk = change.risk;
    if (change.enabled !== undefined) override.enabled = change.enabled;
    let app = ref.app;
    for (let attempt = 1; ; attempt += 1) {
      const before = remoteMcpBlockOf(app)?.tools[serverName] ?? null;
      const update = remoteMcpAppUpdate(app, { tool: { name: serverName, override } });
      const [changed = []] = await db.run([
        {
          sql: `UPDATE apps SET manifest = ?, name = ?, description = ?, updated_at = ?
WHERE id = ? AND manifest = ? AND status != '${DELETED_APP_STATUS}' RETURNING id`,
          params: [update.manifest, update.name, update.description, now, app.id, app.manifest],
        },
      ]);
      if (changed.length > 0) {
        return {
          serverName,
          listedName: local ? `${ref.id}_${local}` : null,
          inListing: Boolean(match),
          before,
          after: update.remote.tools[serverName] ?? null,
          rev: update.remote.rev,
        };
      }
      const fresh = await rowFor(db, app.organizationId, app.appSlug);
      if (!fresh || attempt >= TOOL_WRITE_ATTEMPTS) {
        throw new EveryAppError(
          "APP_CHANGING",
          `${ref.id} keeps changing while this writes its tool settings\nNothing was written; run it again.`,
          { retryable: true },
        );
      }
      app = fresh;
    }
  });
}

/** What `secret set` did about the credential names it set. */
interface CredentialBindingResult {
  /** Each name pinned to its app's origin. */
  bound: Array<{ name: string; origin: string }>;
  /** Names no live MCP app declares: `kept` is the origin an earlier binding still holds. */
  undeclared: Array<{ name: string; kept: string | null }>;
  /** Names live MCP apps at more than one origin declare (a row edited by hand): left unbound. */
  ambiguous: Array<{ name: string; origins: string[] }>;
}

/**
 * After `secret set` set Gateway settings: pin each remote MCP credential
 * name among them (the `_MCP_TOKEN` family) to the origin of the live
 * MCP app that declares it (`remote_mcp_credentials`: name, origin, who
 * set it, when). A name no live app declares keeps whatever binding it
 * had, and the Gateway binds an unbound one to the first app that uses it.
 * Nothing on a Gateway whose D1 predates migration 0011.
 */
export async function bindRemoteMcpCredentials(
  db: D1Database,
  names: readonly string[],
  actor: string,
  now = Date.now(),
): Promise<CredentialBindingResult> {
  const result: CredentialBindingResult = { bound: [], undeclared: [], ambiguous: [] };
  const family = names.filter(isRemoteMcpSecretName);
  if (family.length === 0 || !(await remoteMcpTables(db)).credentials) return result;
  const origins = await credentialOrigins(db);
  const existing = await readCredentialBindings(db);
  const writes: D1Statement[] = [];
  for (const name of family) {
    const declared = [...(origins.get(name) ?? [])].sort();
    if (declared.length === 0) {
      result.undeclared.push({ name, kept: existing.get(name)?.origin ?? null });
    } else if (declared.length > 1) {
      result.ambiguous.push({ name, origins: declared });
    } else {
      result.bound.push({ name, origin: declared[0]! });
      writes.push({
        sql: `INSERT INTO remote_mcp_credentials (name, origin, bound_by, bound_at) VALUES (?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET origin = excluded.origin, bound_by = excluded.bound_by, bound_at = excluded.bound_at`,
        params: [name, declared[0]!, actor, now],
      });
    }
  }
  if (writes.length > 0) await db.run(writes);
  return result;
}

/**
 * After `secret unset` removed Gateway settings: drop the binding of each
 * remote MCP credential name among them. Returns the names whose binding
 * went.
 */
export async function unbindRemoteMcpCredentials(db: D1Database, names: readonly string[]): Promise<string[]> {
  const family = names.filter(isRemoteMcpSecretName);
  if (family.length === 0 || !(await remoteMcpTables(db)).credentials) return [];
  const [gone = []] = await db.run([
    {
      sql: `DELETE FROM remote_mcp_credentials WHERE name IN (${family.map(() => "?").join(", ")}) RETURNING name`,
      params: family,
    },
  ]);
  return gone.map((row) => String(row["name"]));
}

/** Every live remote MCP app's credential name, across organizations, with the app ids that declare it. */
export async function remoteMcpCredentialNames(db: D1Database): Promise<Map<string, string[]>> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT app_slug, tier, manifest FROM apps WHERE tier = ? AND status != '${DELETED_APP_STATUS}' ORDER BY app_slug`,
      params: [PROVIDER_APP_TIER],
    },
  ]);
  const names = new Map<string, string[]>();
  for (const row of rows) {
    const block = remoteMcpBlockOf({ tier: String(row["tier"]), manifest: text(row["manifest"]) });
    const secret = block ? remoteMcpSecretOf(block.auth) : null;
    if (!secret) continue;
    names.set(secret, [...(names.get(secret) ?? []), String(row["app_slug"])]);
  }
  return names;
}
