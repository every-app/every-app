/**
 * MCP apps in the Gateway's registry, both kinds, as `everyapp mcp` reads
 * and writes them (docs/design/2026-10-mcp-by-url.md): a built-in provider
 * app (DataForSEO, `PROVIDER_APPS`) and a remote MCP server registered by
 * URL, a provider-tier row whose manifest carries a `remote` block. Every
 * write goes to the Gateway's D1 under the operator's Cloudflare login
 * (ADR-0003), with the rules in `@every-app/perimeter/registry`
 * (remoteMcpApps.ts): this reads the rows they need and writes what they
 * return, each change in one batch. All the SQL of `mcp add|remove|on|off|
 * list|show|refresh|tool` is here (the app's own provider row's is
 * ./providers.ts's), so the Gateway's server functions and workspace tools
 * can mirror the shapes.
 *
 * `on` and `off` are the status (`active` serves, `disabled` keeps access,
 * tokens and the snapshot and serves nothing); `remove` is the tombstone,
 * as `everyapp delete` leaves for a deployed app. A remote app's
 * credential is a provider of the registry (docs/design/2026-11-mcp-apps-
 * auth.md): a catalog entry, a registered row, or the app's own row
 * `<id>-mcp` that `mcp add` writes in the app's batch; its key or OAuth
 * client is a Gateway setting `secret set` sets and binds to the row's
 * hosts (`providers.bound_to`), and an OAuth provider's connections are
 * `provider_connections`, each a member's own, used by the apps they
 * allowed (`provider_app_access`). `remote_mcp_tools` is what the Gateway
 * last listed, tool by tool.
 *
 * Each change queues its event in the batch that writes it (the outbox,
 * ./events.ts):
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
  capabilitySettings,
  isProviderAppId,
  PROVIDER_APP_IDS,
  PROVIDER_APP_TIER,
  PROVIDER_APPS,
  providerAppKeySetting,
  remoteMcpBlockProblem,
  remoteMcpIdFromUrl,
  remoteMcpProviderOf,
  remoteToolEnabled,
  remoteToolRisk,
  type Capability,
  type CapabilityLookup,
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
import type { InstallRecord } from "./install";
import { gatewayRegistry, listConnections, readUploadedClients } from "./providers";
import {
  APP_COLUMNS,
  asEveryAppError,
  ensureInstallOrganization,
  installOrganization,
  registryCall,
  text,
  toAppRow,
  withoutAppData,
  type Deployer,
  type Organization,
  type StoredAppRow,
} from "./registry";

type D1Row = Record<string, unknown>;

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
function mcpAppEventData(app: StoredAppRow): {
  app: EventApp;
  kind: McpAppRef["kind"];
} {
  return {
    app: { id: app.appSlug, rowId: app.id, name: app.name },
    kind: isRemoteMcpRow(app) ? "remote" : "builtin",
  };
}

/** The URL of a row's `remote` block, read even from a tombstone or a block from before provider credentials. */
export function remoteUrlOf(
  app: Pick<StoredAppRow, "tier" | "manifest">,
): string | null {
  const url = remoteMcpBlockOf(app)?.url;
  if (url) return url;
  try {
    const raw = (JSON.parse(app.manifest ?? "null") as { remote?: { url?: unknown } } | null)?.remote?.url;
    return typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

/** The install organization's row for an id, tombstones included. */
async function rowFor(
  db: D1Database,
  organizationId: string,
  id: string,
): Promise<StoredAppRow | null> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug = ?`,
      params: [organizationId, id],
    },
  ]);
  return rows[0] ? toAppRow(rows[0]) : null;
}

/** The install organization's live remote MCP apps' ids, for what a refusal names. */
async function remoteIds(
  db: D1Database,
  organizationId: string,
): Promise<string[]> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND tier = ? AND status != '${DELETED_APP_STATUS}' ORDER BY app_slug`,
      params: [organizationId, PROVIDER_APP_TIER],
    },
  ]);
  return rows
    .map(toAppRow)
    .filter(isRemoteMcpRow)
    .map((app) => app.appSlug);
}

/**
 * An id as an MCP app: a built-in's (with its row, if it has one), or a
 * remote app's row (a tombstone included: `on` and `show` say how to add
 * it again). Anything else is PROVIDER_APP_UNKNOWN, naming the built-ins
 * and the remote apps there are, or for a deployed app's id, the command
 * that removes a deployed app.
 */
export async function resolveMcpApp(
  db: D1Database,
  id: string,
): Promise<McpAppRef> {
  const found = await installOrganization(db);
  const organization = found?.organization ?? null;
  const app = organization ? await rowFor(db, organization.id, id) : null;
  if (isProviderAppId(id)) {
    return {
      kind: "builtin",
      id,
      organization,
      app: app && app.tier === PROVIDER_APP_TIER ? app : null,
    };
  }
  if (app && isRemoteMcpRow(app))
    return { kind: "remote", id, organization, app };
  if (
    app &&
    app.tier !== PROVIDER_APP_TIER &&
    app.status !== DELETED_APP_STATUS
  ) {
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
      ? {
          rerun: `${CLI} mcp add ${id}`,
          rerunNote: "adds the server at that address",
        }
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
      ? {
          rerun: `${CLI} mcp add ${url} --name ${ref.id}`,
          rerunNote: "adds it again",
        }
      : { rerun: `${CLI} mcp list`, rerunNote: "lists the MCP apps" },
  );
}

export interface RemoteMcpAddInput {
  url: string;
  /** `--name`: the app id (derived from the URL's host when absent). */
  id?: string;
  /** The display name (default: the id). */
  name?: string;
  description?: string;
  /** The auth block: `{ kind: "none" }`, or `{ kind: "provider", provider? }` (no provider: the app's own `<id>-mcp`). */
  auth: unknown;
  /** The provider registry as the Gateway resolves it, the app's own row included when it is about to be written. */
  lookupProvider?: (providerId: string) => Capability | undefined;
  /** An OAuth row's scopes, from discovery: what the app's capability entry lists and the connect asks for. */
  scopes?: readonly string[] | null;
  /** Before the server is looked at, for a credential that may be the app's own OAuth row (the registry's `mayBeOwnOAuth`). */
  mayBeOwnOAuth?: boolean;
  risk?: string;
  /** What the URL is checked against: the Gateway's own address and app domain. */
  env: RemoteMcpUrlEnv;
  deployer: Deployer;
  /** Names the organization created when the Gateway has none yet. */
  organizationName: string;
  now?: number;
  /** The app's own provider row's statements (./providers.ts), written in the app's batch. */
  providerWrites?: readonly D1Statement[];
}

/** What a remote MCP app is planned against: the organization and the id's row. */
interface RemoteMcpAddContext {
  organization: Organization;
  hasOwner: boolean;
  /** The id the rules take: `--name`, else the URL's host's. */
  id: string;
  existingApp: StoredAppRow | null;
}

interface RemoteMcpAdded {
  plan: RemoteMcpAddPlan;
  organization: Organization;
  /** The Gateway has an owner. */
  hasOwner: boolean;
}

/**
 * Read what adding `url` is planned against, creating the install
 * organization when the Gateway has none yet (as every add has).
 */
export function readRemoteMcpAddContext(
  db: D1Database,
  input: Pick<RemoteMcpAddInput, "url" | "id" | "deployer" | "organizationName" | "now">,
): Promise<RemoteMcpAddContext> {
  return registryCall(async () => {
    const now = input.now ?? Date.now();
    const url = input.url.trim();
    const id = (input.id ?? "").trim() || remoteMcpIdFromUrl(url) || "";
    const { organization, hasOwner } = await ensureInstallOrganization(db, input.organizationName, now);
    const [existing = []] = await db.run([
      {
        sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND app_slug = ?`,
        params: [organization.id, id],
      },
    ]);
    return {
      organization,
      hasOwner,
      id,
      existingApp: existing[0] ? toAppRow(existing[0]) : null,
    };
  });
}

/** The registry's plan for the add (every refusal raised as the CLI's error), writing nothing. */
export function planRemoteMcpAdd(
  context: RemoteMcpAddContext,
  input: Omit<RemoteMcpAddInput, "organizationName" | "providerWrites">,
): RemoteMcpAddPlan {
  try {
    return planRemoteMcpAppAdd({
      organizationId: context.organization.id,
      url: input.url.trim(),
      id: input.id,
      name: input.name,
      description: input.description,
      auth: input.auth,
      ...(input.lookupProvider ? { lookupProvider: input.lookupProvider } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.mayBeOwnOAuth ? { mayBeOwnOAuth: true } : {}),
      risk: input.risk,
      env: input.env,
      existingApp: (slug) => {
        if (slug !== context.id) throw new Error(`The rules asked for "${slug}", not "${context.id}".`);
        return context.existingApp;
      },
      actor: input.deployer.actor,
      now: input.now ?? Date.now(),
    });
  } catch (error) {
    throw asEveryAppError(error);
  }
}

/** What adding a remote MCP app writes, in one batch (the row; a revived one's leftovers cleared). */
function addWrites(plan: RemoteMcpAddPlan, now: number): D1Statement[] {
  const { app } = plan;
  if (plan.kind === "new") {
    return [
      {
        sql: `INSERT INTO apps (id, organization_id, app_slug, name, description, hostname,
  worker_name, tier, manifest, status, version_id, deployed_at, deployed_by_actor,
  everyone, created_at, updated_at, scope)
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
    ];
  }
  // Its own tombstone comes back as new: nothing of the old access, tokens,
  // snapshot or listing is kept.
  return [
    {
      sql: `UPDATE apps SET name = ?, description = ?, manifest = ?, status = ?, everyone = 0,
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
    ...withoutAppData(app, now),
    remoteToolsDelete(app),
  ];
}

function remoteToolsDelete(
  app: Pick<StoredAppRow, "id" | "organizationId">,
): D1Statement {
  return {
    sql: "DELETE FROM remote_mcp_tools WHERE app_row_id = ? AND organization_id = ?",
    params: [app.id, app.organizationId],
  };
}

/**
 * Write a planned add in one batch: the app's own provider row
 * (`providerWrites`, ./providers.ts) when it has one, the app row (or its
 * own tombstone revived as new), and `mcp_app.added`.
 */
export function writeRemoteMcpAdd(
  db: D1Database,
  context: RemoteMcpAddContext,
  plan: RemoteMcpAddPlan,
  input: Pick<RemoteMcpAddInput, "deployer" | "now" | "providerWrites">,
): Promise<RemoteMcpAdded> {
  return registryCall(async () => {
    const now = input.now ?? Date.now();
    const { organization } = context;
    const added = await queueEventFromCli(db, {
      organizationId: organization.id,
      type: "mcp_app.added",
      actor: operatorActor(input.deployer),
      data: {
        app: { id: plan.app.appSlug, rowId: plan.app.id, name: plan.app.name },
        kind: "remote",
      },
      appRowId: plan.app.id,
      // The revival is conditional on the tombstone: only if the row was written now.
      onlyIf: {
        sql: "EXISTS (SELECT 1 FROM apps WHERE id = ? AND status = ? AND updated_at = ?)",
        params: [plan.app.id, plan.app.status, now],
      },
      now,
    });
    await db.run([
      ...(input.providerWrites ?? []),
      ...addWrites(plan, now),
      ...added,
    ]);
    return {
      plan,
      organization,
      hasOwner: context.hasOwner,
    };
  });
}

/**
 * Register a remote MCP server in the install organization (created when
 * the Gateway has none yet): the row `active` at once, granted to nobody
 * (owners and admins open it by their role), or its own tombstone revived
 * as new; with `providerWrites`, the app's own provider row in the same
 * batch. The registry's refusals (REMOTE_MCP_URL_REFUSED,
 * REMOTE_MCP_INVALID, REMOTE_MCP_PROVIDER_HOST, REMOTE_MCP_EXISTS,
 * APP_TIER_MISMATCH) write nothing.
 */
export async function addRemoteMcpApp(
  db: D1Database,
  input: RemoteMcpAddInput,
): Promise<RemoteMcpAdded> {
  const context = await readRemoteMcpAddContext(db, input);
  const plan = planRemoteMcpAdd(context, input);
  return writeRemoteMcpAdd(db, context, plan, input);
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
    await db.run([
      {
        sql: "UPDATE apps SET status = ?, everyone = ?, updated_at = ? WHERE id = ?",
        params: [update.status, update.everyone ? 1 : 0, now, app.id],
      },
      ...withoutAppData(app, now),
      remoteToolsDelete(app),
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
export async function refreshMcpAppTools(
  db: D1Database,
  app: StoredAppRow,
): Promise<ToolSnapshot | null> {
  const scoped = [app.id, app.organizationId];
  const [catalog = []] = await db.run([
    {
      sql: "SELECT status, tool_count, fetched_at, last_error FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: "DELETE FROM app_tools WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: "DELETE FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
  ]);
  return toSnapshot(catalog[0]);
}

/** What a remote app's credential is checked against: the Gateway's settings, its providers, the OAuth connections. */
export interface CredentialContext {
  /** The setting names on the Gateway Worker. */
  gatewayNames: readonly string[];
  /** The catalog and the registered rows, as the Gateway resolves them. */
  registry: CapabilityLookup & { bound(id: string): boolean };
  /** The install organization's active connections, by {@link connectionKey} (the provider, and an app allowed to use them): whose they are. */
  connections: ReadonlyMap<string, string[]>;
  /** The providers with a client uploaded in the Gateway (Admin → Providers, or its own Add an MCP server). */
  uploadedClients: ReadonlySet<string>;
}

/**
 * A remote app's credential as `mcp list` and `mcp show` report it, never
 * a value: none; an API key (its setting, whether it is set, and whether
 * it was set for the hosts the provider has now); an OAuth provider (its
 * client, and how many are connected); a provider the Gateway doesn't have;
 * or a registration from before provider credentials.
 */
export type CredentialState =
  | { kind: "none" }
  | { kind: "key"; provider: string; setting: string; set: boolean; bound: boolean }
  | {
      kind: "oauth";
      provider: string;
      /** The client: its id's setting, set and bound, or uploaded in the Gateway. */
      client: { setting: string; set: boolean; bound: boolean; uploaded: boolean };
      /** How many members have connected it and allowed the app, and who (emails). */
      connected: number;
      people: string[];
    }
  | { kind: "missing"; provider: string }
  | { kind: "predates"; problem: string };

/** Where a connection is counted: its provider, for an app its person allowed to use it. */
export function connectionKey(providerId: string, appId: string): string {
  return `${providerId} ${appId}`;
}

/** The credential of app `appId`'s block (or of a block that can't be read: `problem`). */
export function credentialState(
  remote: RemoteMcpBlock | null,
  problem: string | null,
  context: CredentialContext,
  appId: string,
): CredentialState {
  if (!remote) return { kind: "predates", problem: problem ?? "its registration can't be read" };
  const provider = remoteMcpProviderOf(remote.auth);
  if (!provider) return { kind: "none" };
  const capability = context.registry.get(provider);
  if (!capability || (capability.mode !== "api_key" && capability.mode !== "oauth_client")) {
    return { kind: "missing", provider };
  }
  const settings = capabilitySettings(capability);
  const set = settings.every((name) => context.gatewayNames.includes(name));
  const bound = context.registry.bound(provider);
  if (capability.mode === "api_key") {
    return { kind: "key", provider, setting: settings[0] ?? capability.auth.secret, set, bound };
  }
  const people = context.connections.get(connectionKey(provider, appId)) ?? [];
  return {
    kind: "oauth",
    provider,
    client: { setting: capability.secrets.clientId, set, bound, uploaded: context.uploadedClients.has(provider) },
    connected: people.length,
    people: [...people],
  };
}

/** Whether the credential lets the Gateway serve the app: nothing to set, a bound key, a client and a connection. */
export function credentialReady(state: CredentialState): boolean {
  switch (state.kind) {
    case "none":
      return true;
    case "key":
      return state.set && state.bound;
    case "oauth":
      return ((state.client.set && state.client.bound) || state.client.uploaded) && state.connected > 0;
    default:
      return false;
  }
}

/**
 * Read what each remote app's credential is checked against
 * ({@link CredentialContext}), for the install organization's
 * connections: `gatewayNames` are what `secret list` read.
 */
export async function readCredentialContext(
  db: D1Database,
  install: Pick<InstallRecord, "gatewayHost" | "appBaseDomain">,
  gatewayNames: readonly string[],
): Promise<CredentialContext> {
  const found = await installOrganization(db);
  const [registry, connections, uploaded] = await Promise.all([
    gatewayRegistry(db, install),
    found ? listConnections(db, { organizationId: found.organization.id }) : Promise.resolve([]),
    readUploadedClients(db),
  ]);
  const byProvider = new Map<string, string[]>();
  for (const connection of connections) {
    if (connection.status !== "active") continue;
    for (const app of connection.apps) {
      const key = connectionKey(connection.providerId, app.id);
      const people = byProvider.get(key) ?? [];
      people.push(connection.userEmail ?? connection.label ?? connection.userId);
      byProvider.set(key, people);
    }
  }
  return { gatewayNames, registry, connections: byProvider, uploadedClients: new Set(uploaded.keys()) };
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
  /** Why a remote app's block can't be read (one from before provider credentials), else null. */
  problem: string | null;
  /** A built-in's Gateway setting holding its key; null for a remote app (its credential is a provider). */
  keyName: string | null;
  snapshot: ToolSnapshot | null;
}

/** Why a remote row's block can't be read, or null. */
export function remoteProblemOf(app: Pick<StoredAppRow, "manifest">): string | null {
  try {
    return remoteMcpBlockProblem(JSON.parse(app.manifest ?? "null"));
  } catch {
    return "its manifest isn't JSON";
  }
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
        sql: `SELECT ${APP_COLUMNS} FROM apps WHERE organization_id = ? AND tier = ? AND status != '${DELETED_APP_STATUS}' ORDER BY app_slug`,
        params: [found.organization.id, PROVIDER_APP_TIER],
      },
      {
        sql: "SELECT app_row_id, status, tool_count, fetched_at, last_error FROM app_tool_catalogs WHERE organization_id = ?",
        params: [found.organization.id],
      },
    ]);
    rows.push(...apps.map(toAppRow));
    for (const catalog of catalogs)
      snapshots.set(String(catalog["app_row_id"]), toSnapshot(catalog)!);
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
      problem: null,
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
        problem: remote ? null : remoteProblemOf(app),
        keyName: null,
        snapshot: snapshots.get(app.id) ?? null,
      };
    });
  return [...builtins, ...remotes];
}

/** Where an MCP app stands, as `mcp list` and `mcp show` say it. */
export type McpAppState = "on" | "off" | "needs setup" | "not added";

/**
 * An MCP app's state: not added (a built-in with no live row), off (not
 * `active`), needs setup (a built-in's key isn't set; a remote app's block
 * can't be read, or its credential isn't ready: {@link credentialReady}),
 * or on.
 */
export function mcpAppState(
  entry: Pick<McpAppEntry, "kind" | "app" | "keyName">,
  gatewayNames: readonly string[],
  credential: CredentialState | null,
): McpAppState {
  if (!entry.app || entry.app.status === DELETED_APP_STATUS) return "not added";
  if (entry.app.status !== "active") return "off";
  if (entry.kind === "remote") return credential && credentialReady(credential) ? "on" : "needs setup";
  if (entry.keyName && !gatewayNames.includes(entry.keyName)) return "needs setup";
  return "on";
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

/** What `mcp show` reads beyond the row: the snapshot and the tools. */
interface McpAppDetail {
  snapshot: ToolSnapshot | null;
  /** A remote app's tools as last listed, joined with the catalog. */
  remoteTools: RemoteToolEntry[];
  /** The catalog's tools (`app_tools`), for a built-in. */
  catalogTools: CatalogToolEntry[];
}

/** The hints a stored `risk_hint` stands for, in `remoteToolRisk`'s terms. */
function hintsOf(riskHint: string): {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
} {
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
    const source: RemoteToolRiskSource =
      ruled.source === "default" && riskHint === "write"
        ? "hint"
        : ruled.source;
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
  const [catalog = [], tools = [], listed = []] = await db.run([
    {
      sql: "SELECT status, tool_count, fetched_at, last_error FROM app_tool_catalogs WHERE app_row_id = ? AND organization_id = ?",
      params: scoped,
    },
    {
      sql: "SELECT name, title, risk FROM app_tools WHERE app_row_id = ? AND organization_id = ? ORDER BY name",
      params: scoped,
    },
    ...(remote
      ? [
          {
            sql: `SELECT upstream_name, local_name, title, risk_hint, listed, problem, listed_at FROM remote_mcp_tools
WHERE app_row_id = ? AND organization_id = ? ORDER BY upstream_name`,
            params: scoped,
          },
        ]
      : [{ sql: "SELECT 1 WHERE 0" }]),
  ]);
  const catalogRisks = new Map(
    tools.map((tool) => [String(tool["name"]), String(tool["risk"])]),
  );
  return {
    snapshot: toSnapshot(catalog[0]),
    remoteTools: remote
      ? remoteToolEntries(ref.id, remote, listed, catalogRisks)
      : [],
    catalogTools: tools.map((tool) => ({
      name: `${ref.id}_${String(tool["name"])}`,
      title: text(tool["title"]),
      risk: String(tool["risk"]),
    })),
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
  /** Who runs the command: the `mcp_app.tool_changed` event's actor. Without one, no event. */
  deployer?: Deployer,
): Promise<RemoteToolChanged> {
  return registryCall(async () => {
    const [matches = []] = await db.run([
      {
        sql: `SELECT upstream_name, local_name FROM remote_mcp_tools
WHERE app_row_id = ?1 AND (upstream_name = ?2 OR local_name = ?2 OR ?3 || local_name = ?2)
ORDER BY (upstream_name = ?2) DESC, upstream_name LIMIT 1`,
        params: [ref.app.id, tool, `${ref.id}_`],
      },
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
      const update = remoteMcpAppUpdate(app, {
        tool: { name: serverName, override },
      });
      const after = update.remote.tools[serverName] ?? null;
      const [changed = []] = await db.run([
        {
          sql: `UPDATE apps SET manifest = ?, name = ?, description = ?, updated_at = ?
WHERE id = ? AND manifest = ? AND status != '${DELETED_APP_STATUS}' RETURNING id`,
          params: [
            update.manifest,
            update.name,
            update.description,
            now,
            app.id,
            app.manifest,
          ],
        },
        // mcp_app.tool_changed: the override after the change (the Gateway's Edit dialog queues the same), in the write's batch.
        ...(deployer
          ? await queueEventFromCli(db, {
              organizationId: app.organizationId,
              type: "mcp_app.tool_changed",
              actor: operatorActor(deployer),
              data: {
                ...mcpAppEventData(app),
                tool: serverName,
                ...(after?.risk ? { risk: after.risk } : {}),
                ...(after?.enabled !== undefined
                  ? { enabled: after.enabled }
                  : {}),
                ...(after === null ? { cleared: true } : {}),
              },
              appRowId: app.id,
              onlyIf: { sql: "changes() > 0", params: [] },
              now,
            })
          : []),
      ]);
      if (changed.length > 0) {
        return {
          serverName,
          listedName: local ? `${ref.id}_${local}` : null,
          inListing: Boolean(match),
          before,
          after,
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

/**
 * Which live remote MCP apps use each provider, across organizations (the
 * Gateway has one set of settings): what `secret list` says a provider's
 * setting is for.
 */
export async function remoteMcpProviderUses(db: D1Database): Promise<Map<string, string[]>> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT app_slug, tier, manifest FROM apps WHERE tier = ? AND status != '${DELETED_APP_STATUS}' ORDER BY app_slug`,
      params: [PROVIDER_APP_TIER],
    },
  ]);
  const uses = new Map<string, string[]>();
  for (const row of rows) {
    const block = remoteMcpBlockOf({ tier: String(row["tier"]), manifest: text(row["manifest"]) });
    const provider = block ? remoteMcpProviderOf(block.auth) : null;
    if (!provider) continue;
    uses.set(provider, [...(uses.get(provider) ?? []), String(row["app_slug"])]);
  }
  return uses;
}
