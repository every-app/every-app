/**
 * The provider registry's rows in the Gateway's D1 (`providers`, migration
 * 0013; docs/design/2026-10-provider-registry.md), written by the CLI under
 * the operator's Cloudflare login (ADR-0003) like every registry change.
 * The rules are the SDK's (`@every-app/sdk/internal` providerSpec.ts and
 * providerRegistry.ts), run here before a write and again by the gateway
 * every time it reads a row; this file adds the checks only the CLI can
 * make (no registered app holds a row's setting as a secret of its own; a
 * row an app lists isn't removed without --force) and the I/O.
 *
 * `add` and `remove` queue `provider.added` and `provider.removed` (the
 * outbox, events.ts) in the batch that writes the row, on the install
 * organization, whose Gateway the registry is, as the operator: only when
 * the write lands, and nothing on a Gateway without the event tables or
 * before it has an organization.
 *
 * The OAuth side (migrations 0016, 0025 and 0034;
 * docs/design/2026-11-oauth-one-connection.md): the clients uploaded under
 * Admin → Providers, the connections, each one person's to one provider,
 * and the apps that person allowed to use theirs (`provider_app_access`).
 */
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import {
  capabilitySettings,
  checkProviderRow,
  describeSpecProblems,
  gatewayHostRefusal,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
  secretNames,
  type RegistrableCapability,
  type ProviderRegistry,
  type ProviderRow,
  type RegisteredProvider,
  unregisteredPresetIds,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI, thisCommand } from "@/lib/output/command";
import { listed } from "@/lib/output/text";
import type { InstallRecord } from "./install";
import { operatorActor, queueEventFromCli } from "./events";
import { installOrganization, listApps, text, type Deployer } from "./registry";

/** What the host rule needs of the install: the Gateway's host and its apps' base domain. */
type ProviderInstall = Pick<InstallRecord, "gatewayHost" | "appBaseDomain">;

/** A stored row as the registry reads it, with the spec's text as stored. */
interface StoredProviderRow extends ProviderRow {
  spec: string;
}

/** Every `providers` row, in the order they were added. */
async function readProviderRows(db: D1Database): Promise<StoredProviderRow[]> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT id, spec, added_by, added_at, bound_to FROM providers ORDER BY added_at, id",
    },
  ]);
  return rows.map((row) => ({
    id: String(row["id"]),
    spec: String(row["spec"]),
    addedBy: text(row["added_by"]),
    addedAt: row["added_at"] == null ? null : Number(row["added_at"]),
    boundTo: text(row["bound_to"]),
  }));
}

/** This Gateway's host rule: its own host and everything under its apps' base domain. */
function refuseHostFor(install: ProviderInstall): (host: string) => string | null {
  return (host) =>
    gatewayHostRefusal(host, {
      gatewayHost: install.gatewayHost,
      appBaseDomain: install.appBaseDomain,
    });
}

/** The catalog and `rows` as the Gateway resolves them, with its host rule. */
function registryOf(rows: readonly ProviderRow[], install: ProviderInstall): ProviderRegistry {
  return providerRegistry(rows, { refuseHost: refuseHostFor(install) });
}

/**
 * The catalog and this Gateway's registered providers, as the Gateway
 * reads them: what `status`, `secret`, `configure` and `deploy` validate
 * and describe an app's settings against once connected.
 */
export async function gatewayRegistry(
  db: D1Database,
  install: ProviderInstall,
): Promise<ProviderRegistry> {
  return registryOf(await readProviderRows(db), install);
}

/** The registered rows holding any of `names`, with the names each holds. */
export function providerRowsNaming(
  registry: ProviderRegistry,
  names: readonly string[],
): RegisteredProvider[] {
  return registry
    .rows()
    .filter((row) => capabilitySettings(row.capability).some((name) => names.includes(name)));
}

interface AddProviderInput {
  /** The spec as JSON parsed it (from the file or URL `provider add` was given). */
  spec: unknown;
  /** Who registers it: the Cloudflare login (its actor is the row's `added_by`). */
  deployer: Deployer;
  /** Replace the row with the same id, unbinding its key. */
  replace?: boolean;
  install: ProviderInstall;
  now?: number;
}

interface AddedProvider {
  id: string;
  capability: RegistrableCapability;
  /** The row was there and replaced (its key must be set again). */
  replaced: boolean;
}

/**
 * Register a provider: the spec parsed (PROVIDER_SPEC_INVALID), checked
 * against the catalog, the other rows and this Gateway's hosts
 * (PROVIDER_BUILTIN, PROVIDER_SECRET_TAKEN, PROVIDER_HOST_REFUSED), and
 * against every registered app's stored manifest (a setting an app lists
 * as its own secret is PROVIDER_SECRET_TAKEN, naming the app); an id with a
 * row is PROVIDER_EXISTS unless `replace`, which writes the new spec and
 * leaves the row unbound until `secret set` sets its key again
 * (`providers.value-bound-to-hosts`).
 */
export async function addProvider(db: D1Database, input: AddProviderInput): Promise<AddedProvider> {
  const parsed = parseProviderSpec(input.spec);
  if (!parsed.ok) {
    throw new EveryAppError(
      "PROVIDER_SPEC_INVALID",
      `The spec isn't one this Gateway takes\n${describeSpecProblems(parsed.problems)}`,
      { fix: "fix each field named above, then add it again" },
    );
  }
  const { id, capability } = parsed;
  const rows = await readProviderRows(db);
  const others = registryOf(
    rows.filter((row) => row.id !== id),
    input.install,
  );
  const refusal = checkProviderRow(id, capability, {
    rowSettings: new Set(others.rows().flatMap((row) => capabilitySettings(row.capability))),
    refuseHost: refuseHostFor(input.install),
  });
  if (refusal) {
    switch (refusal.code) {
      case "PROVIDER_BUILTIN":
        throw new EveryAppError("PROVIDER_BUILTIN", `${id} is built in\nA registered provider can't take a built-in provider's id.`, {
          fix: `give the provider another id in its spec; ${CLI} provider show ${id} prints the built-in one`,
        });
      case "PROVIDER_SECRET_TAKEN":
        throw new EveryAppError("PROVIDER_SECRET_TAKEN", `${id} can't use that setting: ${refusal.message}`, {
          fix: `name the provider's settings after its id, ${id.toUpperCase().replace(/-/g, "_")}_…, and none another provider or the Gateway reads`,
        });
      case "PROVIDER_HOST_REFUSED":
        throw new EveryAppError("PROVIDER_HOST_REFUSED", `${id}'s key can't be sent there: ${refusal.message}`, {
          fix: "list only the provider's own public API hosts under hosts",
        });
      default:
        throw new EveryAppError("PROVIDER_SPEC_INVALID", `The spec isn't one this Gateway takes\n${refusal.message}`, {
          fix: "fix the spec, then add it again",
        });
    }
  }
  const settings = capabilitySettings(capability);
  for (const app of await listApps(db)) {
    if (!app.manifest) continue;
    const own = secretNames(app.manifest).map((name) => name.toUpperCase());
    const taken = settings.filter((name) => own.includes(name));
    if (taken.length > 0) {
      throw new EveryAppError(
        "PROVIDER_SECRET_TAKEN",
        `${listed(taken)} ${taken.length === 1 ? "is" : "are"} ${app.appSlug}'s own secret\n${app.appSlug}'s deployed manifest lists ${taken.length === 1 ? "it" : "them"} under secrets, so a provider can't read ${taken.length === 1 ? "it" : "them"} from the Gateway.`,
        {
          fix: `name the provider's settings otherwise, or drop ${listed(taken)} from ${app.appSlug}'s secrets and deploy it again`,
        },
      );
    }
  }
  const existing = rows.find((row) => row.id === id);
  if (existing && !input.replace) {
    throw new EveryAppError(
      "PROVIDER_EXISTS",
      `${id} is registered on this Gateway already\nReplacing it writes the new spec; its key must then be set again before the Gateway sends it.`,
      { rerun: thisCommand(["--replace"]), rerunNote: "replaces it", authorize: true },
    );
  }
  const now = input.now ?? Date.now();
  const stored = JSON.stringify(input.spec);
  // Only if the write below landed: the row as written now. A replace is a registration too.
  const event = await providerEvent(
    db,
    "provider.added",
    { id, name: capability.label, kind: capability.mode === "oauth_client" ? "oauth" : capability.mode },
    input.deployer,
    now,
    {
      sql: "EXISTS (SELECT 1 FROM providers WHERE id = ? AND spec = ? AND updated_at = ?)",
      params: [id, stored, now],
    },
  );
  const [written = []] = await db.run([
    existing
      ? {
          sql: "UPDATE providers SET spec = ?, updated_at = ?, bound_to = NULL, bound_at = NULL WHERE id = ? RETURNING id",
          params: [stored, now, id],
        }
      : {
          sql: `INSERT INTO providers (id, spec, added_by, added_at, updated_at, bound_to, bound_at)
VALUES (?1, ?2, ?3, ?4, ?4, NULL, NULL) ON CONFLICT(id) DO NOTHING RETURNING id`,
          params: [id, stored, input.deployer.actor, now],
        },
    ...event,
  ]);
  if (written.length === 0) {
    // Another run added or removed it between the read and the write.
    throw new EveryAppError("PROVIDER_EXISTS", `${id} changed on this Gateway while this ran`, {
      rerun: `${CLI} provider list`,
      rerunNote: "shows it as it is now",
    });
  }
  return { id, capability, replaced: Boolean(existing) };
}

/**
 * Register the OAuth presets among `ids` (the capabilities of an app
 * being deployed) that this Gateway has no row for, each from its preset,
 * as `provider add` writes it: the deploy needs no step of its own for
 * Google or GitHub, and the operator only sets the client. A row another
 * run wrote meanwhile is left as it is. The ids registered.
 */
export async function registerPresetProviders(
  db: D1Database,
  ids: readonly string[],
  input: Pick<AddProviderInput, "deployer" | "install" | "now">,
): Promise<string[]> {
  if (!ids.some((id) => Object.hasOwn(OAUTH_PRESETS, id))) return [];
  const registry = await gatewayRegistry(db, input.install);
  const added: string[] = [];
  for (const id of unregisteredPresetIds(ids, registry)) {
    try {
      await addProvider(db, { ...input, spec: OAUTH_PRESETS[id] });
      added.push(id);
    } catch (error) {
      if (!(error instanceof EveryAppError && error.code === "PROVIDER_EXISTS")) throw error;
    }
  }
  return added;
}

interface RemovedProvider {
  id: string;
  name: string;
  /** The Gateway settings the row named: they stay set until `secret unset`. */
  settings: string[];
  /** The registered apps that list it (removed anyway with --force). */
  apps: string[];
  /** The connections (people's tokens) deleted with an OAuth provider's row, each with the access apps had to it. */
  connections: number;
  /** Whether a client uploaded under Admin → Providers was deleted with the row. */
  client: boolean;
}

/**
 * Remove a registered provider. An id with no row is PROVIDER_NOT_FOUND,
 * and a row a registered app's stored
 * manifest lists under `capabilities` PROVIDER_IN_USE (naming the apps)
 * unless `force`. The Gateway settings it named stay: `secret unset`
 * removes them, and no row reads them again without a new `secret set`.
 */
export async function removeProvider(
  db: D1Database,
  id: string,
  deployer: Deployer,
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {},
): Promise<RemovedProvider> {
  const row = (await readProviderRows(db)).find((each) => each.id === id);
  if (!row) {
    throw new EveryAppError("PROVIDER_NOT_FOUND", `No provider ${id} is registered on this Gateway`, {
      rerun: `${CLI} provider list`,
      rerunNote: "shows which are",
    });
  }
  const parsed = parseProviderSpec(safeJson(row.spec));
  const apps = (await listApps(db))
    .filter((app) => app.manifest?.capabilities && Object.hasOwn(app.manifest.capabilities, id))
    .map((app) => app.appSlug);
  if (apps.length > 0 && !force) {
    throw new EveryAppError(
      "PROVIDER_IN_USE",
      `${listed(apps)} ${apps.length === 1 ? "lists" : "list"} ${id} under capabilities\nRemoving it stops ${apps.length === 1 ? "its" : "their"} calls to it at once: the Gateway answers that it doesn't offer ${id}.`,
      { rerun: thisCommand(["--force"]), rerunNote: "removes it anyway", authorize: true },
    );
  }
  const name = parsed.ok ? parsed.capability.label : id;
  // Queued before the delete, only while the row is there: a second remove
  // racing this one finds none and queues nothing.
  const event = await providerEvent(
    db,
    "provider.removed",
    { id, name, kind: parsed.ok ? (parsed.capability.mode === "oauth_client" ? "oauth" : parsed.capability.mode) : "api_key" },
    deployer,
    now,
    {
      sql: "EXISTS (SELECT 1 FROM providers WHERE id = ?)",
      params: [id],
    },
  );
  // An OAuth provider's connections, the access apps had to them and its
  // uploaded client go with the row: tokens for a provider the Gateway no
  // longer serves open nothing, and a row added again under the id must
  // not inherit them.
  const results = await db.run([
    ...event,
    { sql: "DELETE FROM provider_connections WHERE provider_id = ? RETURNING id", params: [id] },
    { sql: "DELETE FROM oauth_clients WHERE provider_id = ? RETURNING provider_id", params: [id] },
    { sql: "DELETE FROM provider_app_access WHERE provider_id = ?", params: [id] },
    { sql: "DELETE FROM providers WHERE id = ?", params: [id] },
  ]);
  const deleted = results.slice(event.length, event.length + 2);
  return {
    id,
    name,
    settings: parsed.ok ? [...capabilitySettings(parsed.capability)] : [],
    apps,
    connections: deleted[0]?.length ?? 0,
    client: (deleted[1]?.length ?? 0) > 0,
  };
}

/**
 * The outbox statements for a registry change: the catalogue's
 * `{ provider: { id, name } }` on the install organization, as the
 * operator, written only when `onlyIf` holds when the batch runs. None
 * before the Gateway has an organization.
 */
async function providerEvent(
  db: D1Database,
  type: "provider.added" | "provider.removed",
  provider: { id: string; name: string; kind?: "api_key" | "oauth" | "ai" },
  deployer: Deployer,
  now: number,
  onlyIf: { sql: string; params: Array<string | number> },
): Promise<D1Statement[]> {
  const found = await installOrganization(db);
  if (!found) return [];
  return queueEventFromCli(db, {
    organizationId: found.organization.id,
    type,
    actor: operatorActor(deployer),
    data: {
      provider: { id: provider.id, name: provider.name, ...(provider.kind ? { kind: provider.kind } : {}) },
    },
    onlyIf,
    now,
  });
}

// A remote MCP app's own row (`<appId>-mcp`, `everyapp mcp add`).

/** What `mcp add` plans the app's own provider row against: the row there, the other rows' settings, the host rule. */
interface RemoteMcpProviderContext {
  existing: (ProviderRow & { spec: string }) | null;
  /** The settings every other row names (the app's own row may not take one). */
  rowSettings: Set<string>;
  refuseHost: (host: string) => string | null;
}

/**
 * The app's own provider row and what its plan is checked against
 * (`planRemoteMcpProviderRow` in `@every-app/perimeter/registry`).
 */
export async function remoteMcpProviderContext(
  db: D1Database,
  install: ProviderInstall,
  providerId: string,
): Promise<RemoteMcpProviderContext> {
  const rows = await readProviderRows(db);
  const others = registryOf(
    rows.filter((row) => row.id !== providerId),
    install,
  );
  return {
    existing: rows.find((row) => row.id === providerId) ?? null,
    rowSettings: new Set(others.rows().flatMap((row) => capabilitySettings(row.capability))),
    refuseHost: refuseHostFor(install),
  };
}

/**
 * The statements that write a remote MCP app's own provider row as
 * planned, for the batch that writes the app: `insert` the row (unbound
 * until `secret set` sets its key or client), `replace` its spec over the
 * one read (its `bound_to` kept: the registry reads the key only while it
 * equals the new spec's binding key, so a changed host or endpoint
 * unbinds it), nothing to `keep`. An insert or replace queues
 * `provider.added`, as `provider add` does for both.
 */
export async function remoteMcpProviderRowWrites(
  db: D1Database,
  plan: { action: "insert" | "replace" | "keep"; id: string; spec: string; capability: RegistrableCapability },
  existingSpec: string | null,
  deployer: Deployer,
  now: number,
): Promise<D1Statement[]> {
  if (plan.action === "keep") return [];
  const event = await providerEvent(
    db,
    "provider.added",
    { id: plan.id, name: plan.capability.label, kind: plan.capability.mode === "oauth_client" ? "oauth" : plan.capability.mode },
    deployer,
    now,
    {
      sql: "EXISTS (SELECT 1 FROM providers WHERE id = ? AND spec = ? AND updated_at = ?)",
      params: [plan.id, plan.spec, now],
    },
  );
  return [
    // A replaced spec (another server, other endpoints) never gets the
    // tokens issued under the old one: its connections go, with the access
    // apps had to them, and members connect again.
    ...(plan.action === "replace"
      ? [
          { sql: "DELETE FROM provider_connections WHERE provider_id = ?", params: [plan.id] },
          { sql: "DELETE FROM provider_app_access WHERE provider_id = ?", params: [plan.id] },
        ]
      : []),
    plan.action === "replace"
      ? {
          sql: "UPDATE providers SET spec = ?, updated_at = ? WHERE id = ? AND spec = ?",
          params: [plan.spec, now, plan.id, existingSpec ?? ""],
        }
      : {
          sql: `INSERT INTO providers (id, spec, added_by, added_at, updated_at, bound_to, bound_at)
VALUES (?1, ?2, ?3, ?4, ?4, NULL, NULL) ON CONFLICT(id) DO NOTHING`,
          params: [plan.id, plan.spec, deployer.actor, now],
        },
    ...event,
  ];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * After `secret set` put `names` on the Gateway Worker: bind every row the
 * Gateway serves whose settings include one of them to the hosts and auth
 * it has now (`bound_to`, `bound_at`), so the Gateway reads its key
 * (`providers.value-bound-to-hosts`). A row replaced since it was read is
 * left unbound. The ids bound, in row order.
 */
export async function bindProviderSettings(
  db: D1Database,
  install: ProviderInstall,
  names: readonly string[],
  now = Date.now(),
): Promise<string[]> {
  const rows = await readProviderRows(db);
  if (rows.length === 0) return [];
  const registry = registryOf(rows, install);
  const bound = providerRowsNaming(registry, names);
  if (bound.length === 0) return [];
  const results = await db.run(
    bound.map((row) => ({
      sql: "UPDATE providers SET bound_to = ?, bound_at = ? WHERE id = ? AND spec = ? RETURNING id",
      params: [
        providerBindingKey(row.capability),
        now,
        row.id,
        rows.find((each) => each.id === row.id)!.spec,
      ],
    })),
  );
  return results.flatMap((result) => result.map((each) => String(each["id"])));
}

// OAuth providers: the uploaded clients (migration 0016), the connections (migration 0025) and the apps allowed to use them (migration 0034).

/** A client uploaded under Admin → Providers, as the CLI reports it: the id, never the secret. */
export interface UploadedClient {
  providerId: string;
  clientId: string;
  hasSecret: boolean;
  /** The provider binding it was pasted for (the SDK's `providerBindingKey`), or null for none recorded. */
  boundTo: string | null;
  addedBy: string | null;
  addedAt: number | null;
}

/** Every client uploaded in the UI (`oauth_clients`), by provider id. */
export async function readUploadedClients(db: D1Database): Promise<Map<string, UploadedClient>> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT provider_id, client_id, client_secret_enc IS NOT NULL AS has_secret, bound_to, added_by, added_at FROM oauth_clients",
    },
  ]);
  return new Map(
    rows.map((row) => [
      String(row["provider_id"]),
      {
        providerId: String(row["provider_id"]),
        clientId: String(row["client_id"]),
        hasSecret: Boolean(Number(row["has_secret"])),
        boundTo: text(row["bound_to"]),
        addedBy: text(row["added_by"]),
        addedAt: row["added_at"] == null ? null : Number(row["added_at"]),
      },
    ]),
  );
}

/** An app a person allowed to use their connection: its id (slug), its row and its name. */
interface ConnectionApp {
  id: string;
  rowId: string;
  name: string;
}

/**
 * One person's connection to an OAuth provider, as `provider connections`
 * reports it: never a token. `apps` are the apps that person allowed to
 * use it (`provider_app_access`), by name; a deleted app is left out.
 */
export interface ProviderConnection {
  id: string;
  organizationId: string;
  providerId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  apps: ConnectionApp[];
  label: string | null;
  /** The scopes the provider granted, canonical (Google's without its prefix). */
  scopes: string[];
  /** The scopes the allowed apps list for the provider, as they wrote them, each once. */
  listedScopes: string[];
  status: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

interface ConnectionFilter {
  /** The organization's connections (default: every organization's). */
  organizationId?: string;
  providerId?: string;
  /** A person's, by email (matched without case). */
  userEmail?: string;
  /** The ones an app is allowed to use, by its id (slug). */
  appSlug?: string;
}

/** The access rows `x` of connection `c`, each with its app's row `a`; a deleted app's left out. */
const CONNECTION_APPS = `provider_app_access x JOIN apps a ON a.id = x.app_row_id
    WHERE x.organization_id = c.organization_id AND x.provider_id = c.provider_id AND x.user_id = c.user_id
      AND a.status != '${DELETED_APP_STATUS}'`;

function connectionWhere(filter: ConnectionFilter): { sql: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.organizationId) {
    clauses.push("c.organization_id = ?");
    params.push(filter.organizationId);
  }
  if (filter.providerId) {
    clauses.push("c.provider_id = ?");
    params.push(filter.providerId);
  }
  if (filter.userEmail) {
    clauses.push("lower(u.email) = ?");
    params.push(filter.userEmail.trim().toLowerCase());
  }
  if (filter.appSlug) {
    clauses.push(`EXISTS (SELECT 1 FROM ${CONNECTION_APPS} AND a.app_slug = ?)`);
    params.push(filter.appSlug.trim());
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function safeStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** An allowed app as the query reads it: with the scopes its manifest lists for the provider. */
type ConnectionAppRow = ConnectionApp & { scopes?: unknown };

function connectionAppRows(value: unknown): ConnectionAppRow[] {
  return JSON.parse(String(value)) as ConnectionAppRow[];
}

/** A connection's `apps` column (a JSON array of `{ id, rowId, name }`), by name. */
function connectionApps(value: unknown): ConnectionApp[] {
  return connectionAppRows(value)
    .map(({ id, rowId, name }) => ({ id, rowId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The scopes a connection's allowed apps list for its provider, each once. */
function listedScopes(value: unknown): string[] {
  const scopes = connectionAppRows(value).flatMap((app) =>
    Array.isArray(app.scopes) ? app.scopes.filter((scope): scope is string => typeof scope === "string") : [],
  );
  return [...new Set(scopes)];
}

/** The connections `filter` names, newest first, each with the apps allowed to use it. */
export async function listConnections(db: D1Database, filter: ConnectionFilter = {}): Promise<ProviderConnection[]> {
  const where = connectionWhere(filter);
  const [rows = []] = await db.run([
    {
      sql: `SELECT c.id, c.organization_id, c.provider_id, c.user_id, u.email AS user_email, u.name AS user_name,
  c.label, c.scopes, c.status, c.created_at, c.last_used_at, c.expires_at,
  (SELECT json_group_array(json_object('id', a.app_slug, 'rowId', a.id, 'name', a.name,
      'scopes', CASE WHEN json_valid(a.manifest)
        THEN json(json_extract(a.manifest, '$.capabilities."' || c.provider_id || '".scopes')) END))
    FROM ${CONNECTION_APPS}) AS apps
FROM provider_connections c LEFT JOIN users u ON u.id = c.user_id
${where.sql}
ORDER BY c.created_at DESC, c.id`,
      params: where.params,
    },
  ]);
  return rows.map((row) => ({
    id: String(row["id"]),
    organizationId: String(row["organization_id"]),
    providerId: String(row["provider_id"]),
    userId: String(row["user_id"]),
    userEmail: text(row["user_email"]),
    userName: text(row["user_name"]),
    apps: connectionApps(row["apps"]),
    label: text(row["label"]),
    scopes: safeStringArray(row["scopes"]),
    listedScopes: listedScopes(row["apps"]),
    status: String(row["status"] ?? "active"),
    createdAt: Number(row["created_at"]),
    lastUsedAt: row["last_used_at"] == null ? null : Number(row["last_used_at"]),
    expiresAt: row["expires_at"] == null ? null : Number(row["expires_at"]),
  }));
}

/** The connections of each provider, by id: what `provider list` and `provider show` count. */
export async function countConnections(db: D1Database): Promise<Map<string, number>> {
  const [rows = []] = await db.run([
    { sql: "SELECT provider_id, count(*) AS n FROM provider_connections GROUP BY provider_id" },
  ]);
  return new Map(rows.map((row) => [String(row["provider_id"]), Number(row["n"])]));
}

/**
 * Delete the connections `filter` names (`provider disconnect`), each with
 * the access apps had to it, queueing `provider.disconnected` for each in
 * the batch that deletes it, as the operator, with `revoked: false`: the
 * CLI holds no token and can't revoke at the provider; the done event says
 * where to. The rows deleted.
 */
export async function removeConnections(
  db: D1Database,
  filter: Omit<ConnectionFilter, "appSlug"> & { providerId: string; providerName: string },
  deployer: Deployer,
  now = Date.now(),
): Promise<ProviderConnection[]> {
  const connections = await listConnections(db, filter);
  if (connections.length === 0) return [];
  const statements: D1Statement[] = [];
  for (const connection of connections) {
    statements.push(
      ...(await queueEventFromCli(db, {
        organizationId: connection.organizationId,
        type: "provider.disconnected",
        actor: operatorActor(deployer),
        data: {
          provider: { id: filter.providerId, name: filter.providerName },
          account: {
            user: {
              id: connection.userId,
              ...(connection.userEmail ? { email: connection.userEmail } : {}),
              ...(connection.userName ? { name: connection.userName } : {}),
            },
            ...(connection.label ? { label: connection.label } : {}),
          },
          revoked: false,
        },
        onlyIf: { sql: "EXISTS (SELECT 1 FROM provider_connections WHERE id = ?)", params: [connection.id] },
        now,
      })),
      { sql: "DELETE FROM provider_connections WHERE id = ?", params: [connection.id] },
      {
        sql: "DELETE FROM provider_app_access WHERE organization_id = ? AND provider_id = ? AND user_id = ?",
        params: [connection.organizationId, connection.providerId, connection.userId],
      },
    );
  }
  await db.run(statements);
  return connections;
}

/**
 * Take one app's access to the connections `filter` names away (`provider
 * disconnect --app`): the app's `provider_app_access` row for each, and
 * nothing else. The connections stay for the other apps, so no token goes
 * and no event is queued (the Gateway queues none for this either). The
 * connections the app could use, as they are now, without it.
 */
export async function removeAppAccess(
  db: D1Database,
  filter: ConnectionFilter & { providerId: string; appSlug: string },
): Promise<ProviderConnection[]> {
  const appSlug = filter.appSlug.trim();
  const connections = await listConnections(db, filter);
  if (connections.length === 0) return [];
  await db.run(
    connections.flatMap((connection) =>
      connection.apps
        .filter((app) => app.id === appSlug)
        .map((app) => ({
          sql: "DELETE FROM provider_app_access WHERE organization_id = ? AND provider_id = ? AND user_id = ? AND app_row_id = ?",
          params: [connection.organizationId, connection.providerId, connection.userId, app.rowId],
        })),
    ),
  );
  return connections.map((connection) => ({
    ...connection,
    apps: connection.apps.filter((app) => app.id !== appSlug),
  }));
}
