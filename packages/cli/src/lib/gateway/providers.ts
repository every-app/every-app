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
 * A Gateway from before migration 0013 has no table: `add` and `remove`
 * refuse with the command that brings it up to date, and every reader
 * reads it as no rows.
 *
 * `add` and `remove` queue `provider.added` and `provider.removed` (the
 * outbox, events.ts) in the batch that writes the row, on the install
 * organization, whose Gateway the registry is, as the operator: only when
 * the write lands, and nothing on a Gateway without the event tables or
 * before it has an organization.
 *
 * The scope-set overlays (`provider_scope_sets`, migration 0019;
 * `everyapp provider scope-set add|remove`) are read into the same
 * registry and written here under the same login, checked by the SDK's
 * `resolveScopeSetRow` against the built-in client's catalog entry.
 */
import {
  capabilitySettings,
  checkProviderRow,
  CAPABILITY_IDS,
  describeSpecProblems,
  gatewayHostRefusal,
  overlayableClient,
  parseProviderSpec,
  providerBindingKey,
  providerRegistry,
  resolveScopeSetRow,
  secretNames,
  type OAuthScopeSet,
  type RegistrableCapability,
  type ProviderRegistry,
  type ProviderRow,
  type RegisteredProvider,
  type ScopeSetRow,
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

const knownTables = new WeakMap<D1Database, Map<string, Promise<boolean>>>();

/** Whether the Gateway's D1 has `table`. Asked of each database once per table. */
function hasTable(db: D1Database, table: string): Promise<boolean> {
  let tables = knownTables.get(db);
  if (!tables) {
    tables = new Map();
    knownTables.set(db, tables);
  }
  let known = tables.get(table);
  if (!known) {
    known = db
      .run([
        { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [table] },
      ])
      .then(([rows = []]) => rows.length > 0);
    tables.set(table, known);
  }
  return known;
}

/**
 * Whether the Gateway's D1 has the `providers` table (migration 0013,
 * 2026-10-25). Asked of each database once.
 */
function hasProvidersTable(db: D1Database): Promise<boolean> {
  return hasTable(db, "providers");
}

/**
 * Whether the Gateway's D1 has the OAuth tables (`oauth_clients`,
 * `provider_connections`; migration 0016, 2026-10-25). A Gateway without
 * them has no uploaded clients and no connections.
 */
function hasOAuthTables(db: D1Database): Promise<boolean> {
  return hasTable(db, "provider_connections");
}

/** A stored row as the registry reads it, with the spec's text as stored. */
interface StoredProviderRow extends ProviderRow {
  spec: string;
}

/** Every `providers` row, in the order they were added; none on a Gateway without the table. */
async function readProviderRows(db: D1Database): Promise<StoredProviderRow[]> {
  if (!(await hasProvidersTable(db))) return [];
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

/** Whether the Gateway's D1 has the `provider_scope_sets` table (migration 0019, 2026-10-26). */
function hasScopeSetsTable(db: D1Database): Promise<boolean> {
  return hasTable(db, "provider_scope_sets");
}

/** A stored overlay row, with the spec's text as stored. */
interface StoredScopeSetRow extends ScopeSetRow {
  spec: string;
}

/** Every `provider_scope_sets` row, in the order they were added; none on a Gateway without the table. */
async function readScopeSetRows(db: D1Database): Promise<StoredScopeSetRow[]> {
  if (!(await hasScopeSetsTable(db))) return [];
  const [rows = []] = await db.run([
    {
      sql: "SELECT provider_id, name, spec, added_by, added_at FROM provider_scope_sets ORDER BY added_at, provider_id, name",
    },
  ]);
  return rows.map((row) => ({
    providerId: String(row["provider_id"]),
    name: String(row["name"]),
    spec: String(row["spec"]),
    addedBy: text(row["added_by"]),
    addedAt: row["added_at"] == null ? null : Number(row["added_at"]),
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

/** The catalog, `rows` and the scope-set overlays as the Gateway resolves them, with its host rule. */
function registryOf(
  rows: readonly ProviderRow[],
  install: ProviderInstall,
  scopeSets: readonly ScopeSetRow[] = [],
): ProviderRegistry {
  return providerRegistry(rows, { refuseHost: refuseHostFor(install), scopeSets });
}

/**
 * The catalog and this Gateway's registered providers, as the Gateway
 * reads them (the scope-set overlays on its built-in clients included):
 * what `status`, `secret`, `configure` and `deploy` validate and describe
 * an app's settings against once connected.
 */
export async function gatewayRegistry(
  db: D1Database,
  install: ProviderInstall,
): Promise<ProviderRegistry> {
  const [rows, scopeSets] = await Promise.all([readProviderRows(db), readScopeSetRows(db)]);
  return registryOf(rows, install, scopeSets);
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

/** `add` and `remove` on a Gateway whose D1 predates the table. */
function outdated(): EveryAppError {
  return new EveryAppError(
    "GATEWAY_OUTDATED",
    "This Gateway predates the provider registry\nIts database has no providers table until the Gateway is updated. Nothing was changed.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
}

/** The ids `everyapp` and the catalog's, which no row may take. */
function isBuiltinId(id: string): boolean {
  return id === "everyapp" || (CAPABILITY_IDS as readonly string[]).includes(id);
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
  if (!(await hasProvidersTable(db))) throw outdated();
  const rows = await readProviderRows(db);
  const others = registryOf(
    rows.filter((row) => row.id !== id),
    input.install,
    await readScopeSetRows(db),
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

interface RemovedProvider {
  id: string;
  name: string;
  /** The Gateway settings the row named: they stay set until `secret unset`. */
  settings: string[];
  /** The registered apps that list it (removed anyway with --force). */
  apps: string[];
  /** The connections (people's and the organization's tokens) deleted with an OAuth provider's row. */
  connections: number;
  /** Whether a client uploaded under Admin → Providers was deleted with the row. */
  client: boolean;
}

/**
 * Remove a registered provider. A built-in id is PROVIDER_BUILTIN, an id
 * with no row PROVIDER_NOT_FOUND, and a row a registered app's stored
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
  if (isBuiltinId(id)) {
    throw new EveryAppError("PROVIDER_BUILTIN", `${id} is built in\nOnly a provider registered with ${CLI} provider add can be removed.`, {
      rerun: `${CLI} provider list`,
      rerunNote: "shows which are registered",
    });
  }
  if (!(await hasProvidersTable(db))) throw outdated();
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
  // An OAuth provider's connections and uploaded client go with the row:
  // tokens for a provider the Gateway no longer serves open nothing, and a
  // row added again under the id must not inherit them.
  const oauth = await hasOAuthTables(db);
  const results = await db.run([
    ...event,
    ...(oauth
      ? [
          { sql: "DELETE FROM provider_connections WHERE provider_id = ? RETURNING id", params: [id] },
          { sql: "DELETE FROM oauth_clients WHERE provider_id = ? RETURNING provider_id", params: [id] },
        ]
      : []),
    { sql: "DELETE FROM providers WHERE id = ?", params: [id] },
  ]);
  const deleted = oauth ? results.slice(event.length, event.length + 2) : [];
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
  type: "provider.added" | "provider.removed" | "provider.updated",
  provider: { id: string; name: string; kind?: "api_key" | "oauth" | "ai" },
  deployer: Deployer,
  now: number,
  onlyIf: { sql: string; params: Array<string | number> },
  /** `provider.updated`'s `change`, and which scope set when that is what changed. */
  change?: { change: "scope_sets"; scopeSet: { name: string; action: "added" | "removed" } },
): Promise<D1Statement[]> {
  const found = await installOrganization(db);
  if (!found) return [];
  return queueEventFromCli(db, {
    organizationId: found.organization.id,
    type,
    actor: operatorActor(deployer),
    data: {
      provider: { id: provider.id, name: provider.name, ...(provider.kind ? { kind: provider.kind } : {}) },
      ...(change ?? {}),
    },
    onlyIf,
    now,
  });
}

// Scope-set overlays on built-in OAuth clients (migration 0019).

interface AddScopeSetInput {
  /** The built-in OAuth client (`google-workspace`). */
  providerId: string;
  /** The set's spec as JSON parsed it (`{ name, label, access, scopes, routes }`). */
  spec: unknown;
  deployer: Deployer;
  /** Replace the row of the same name. */
  replace?: boolean;
  now?: number;
}

interface AddedScopeSet {
  providerId: string;
  name: string;
  set: OAuthScopeSet;
  /** The client's label. */
  label: string;
  replaced: boolean;
}

/** `scope-set add|remove` on a Gateway whose D1 predates the table. */
function scopeSetsOutdated(): EveryAppError {
  return new EveryAppError(
    "GATEWAY_OUTDATED",
    "This Gateway predates scope-set overlays\nIts database has no provider_scope_sets table until the Gateway is updated. Nothing was changed.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
}

/** The client `scope-set` acts on: a built-in OAuth client with scope sets, or the refusal. */
function requireOverlayableClient(providerId: string) {
  const client = overlayableClient(providerId);
  if (!client) {
    throw new EveryAppError(
      "SCOPE_SET_PROVIDER_UNKNOWN",
      `${providerId} isn't a built-in OAuth client with scope sets\nScope sets are added to google-workspace, microsoft-365 or slack; a registered provider's sets are in its spec (${CLI} provider add --replace).`,
      { rerun: `${CLI} provider presets`, rerunNote: "names the built-in clients" },
    );
  }
  return client;
}

/**
 * Add a scope set to a built-in OAuth client: the spec parsed and checked
 * against the client's catalog entry (SCOPE_SET_INVALID: its routes on
 * the client's API hosts alone, an explicit access, a well-formed name;
 * SCOPE_SET_BUILTIN: one of the client's own names), written as a
 * `provider_scope_sets` row the Gateway serves within 30 seconds. A row
 * of the same name is SCOPE_SET_EXISTS unless `replace`. Queues
 * `provider.updated` (`change: "scope_sets"`) in the same batch.
 */
export async function addScopeSet(db: D1Database, input: AddScopeSetInput): Promise<AddedScopeSet> {
  const client = requireOverlayableClient(input.providerId);
  const spec = input.spec;
  const name =
    spec && typeof spec === "object" && !Array.isArray(spec) && typeof (spec as { name?: unknown }).name === "string"
      ? (spec as { name: string }).name
      : "";
  const resolved = resolveScopeSetRow({ providerId: input.providerId, name, spec });
  if (!resolved.ok) {
    const { code, message } = resolved.refusal;
    throw new EveryAppError(
      code === "SCOPE_SET_BUILTIN" ? "SCOPE_SET_BUILTIN" : "SCOPE_SET_INVALID",
      code === "SCOPE_SET_BUILTIN"
        ? `${name} is ${input.providerId}'s own\n${message}.`
        : `The scope set isn't one ${client.label} takes\n${message}`,
      { fix: code === "SCOPE_SET_BUILTIN" ? "give the set another name" : "fix each field named above, then add it again" },
    );
  }
  if (!(await hasScopeSetsTable(db))) throw scopeSetsOutdated();
  const rows = await readScopeSetRows(db);
  const existing = rows.find((row) => row.providerId === input.providerId && row.name === name);
  if (existing && !input.replace) {
    throw new EveryAppError(
      "SCOPE_SET_EXISTS",
      `${input.providerId} has a scope set ${name} already\nReplacing it changes what every app listing it may call.`,
      { rerun: thisCommand(["--replace"]), rerunNote: "replaces it", authorize: true },
    );
  }
  const now = input.now ?? Date.now();
  const stored = JSON.stringify(spec);
  const event = await providerEvent(
    db,
    "provider.updated",
    { id: input.providerId, name: client.label, kind: "oauth" },
    input.deployer,
    now,
    {
      sql: "EXISTS (SELECT 1 FROM provider_scope_sets WHERE provider_id = ? AND name = ? AND spec = ? AND updated_at = ?)",
      params: [input.providerId, name, stored, now],
    },
    { change: "scope_sets", scopeSet: { name, action: "added" } },
  );
  const [written = []] = await db.run([
    existing
      ? {
          sql: "UPDATE provider_scope_sets SET spec = ?, updated_at = ? WHERE provider_id = ? AND name = ? RETURNING name",
          params: [stored, now, input.providerId, name],
        }
      : {
          sql: `INSERT INTO provider_scope_sets (provider_id, name, spec, added_by, added_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(provider_id, name) DO NOTHING RETURNING name`,
          params: [input.providerId, name, stored, input.deployer.actor, now],
        },
    ...event,
  ]);
  if (written.length === 0) {
    throw new EveryAppError("SCOPE_SET_EXISTS", `${input.providerId}'s ${name} changed on this Gateway while this ran`, {
      rerun: `${CLI} provider show ${input.providerId}`,
      rerunNote: "shows its sets as they are now",
    });
  }
  return { providerId: input.providerId, name, set: resolved.set, label: client.label, replaced: Boolean(existing) };
}

interface RemovedScopeSet {
  providerId: string;
  name: string;
  label: string;
  /** The registered apps that list the set (removed anyway with --force). */
  apps: string[];
}

/**
 * Remove a scope set an operator added (never one of the client's own:
 * SCOPE_SET_BUILTIN; none of that name: SCOPE_SET_NOT_FOUND). A set a
 * registered app's stored manifest lists under `scopes` is
 * SCOPE_SET_IN_USE, naming the apps, unless `force`. Queues
 * `provider.updated` in the batch that deletes the row.
 */
export async function removeScopeSet(
  db: D1Database,
  providerId: string,
  name: string,
  deployer: Deployer,
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {},
): Promise<RemovedScopeSet> {
  const client = requireOverlayableClient(providerId);
  if (Object.hasOwn(client.scopePolicy!.sets, name)) {
    throw new EveryAppError("SCOPE_SET_BUILTIN", `${name} is ${providerId}'s own\nOnly a set added with ${CLI} provider scope-set add can be removed.`, {
      rerun: `${CLI} provider show ${providerId}`,
      rerunNote: "shows which were added",
    });
  }
  if (!(await hasScopeSetsTable(db))) throw scopeSetsOutdated();
  const row = (await readScopeSetRows(db)).find((each) => each.providerId === providerId && each.name === name);
  if (!row) {
    throw new EveryAppError("SCOPE_SET_NOT_FOUND", `${providerId} has no scope set ${name} added on this Gateway`, {
      rerun: `${CLI} provider show ${providerId}`,
      rerunNote: "shows its sets",
    });
  }
  const apps = (await listApps(db))
    .filter((app) => {
      const entry = app.manifest?.capabilities?.[providerId] as { scopes?: unknown } | undefined;
      return Array.isArray(entry?.scopes) && entry.scopes.includes(name);
    })
    .map((app) => app.appSlug);
  if (apps.length > 0 && !force) {
    throw new EveryAppError(
      "SCOPE_SET_IN_USE",
      `${listed(apps)} ${apps.length === 1 ? "lists" : "list"} ${name} under ${providerId}'s scopes\nRemoving it stops ${apps.length === 1 ? "its" : "their"} calls under it at once: the Gateway answers integration_scopes_undeclared.`,
      { rerun: thisCommand(["--force"]), rerunNote: "removes it anyway", authorize: true },
    );
  }
  const event = await providerEvent(
    db,
    "provider.updated",
    { id: providerId, name: client.label, kind: "oauth" },
    deployer,
    now,
    { sql: "EXISTS (SELECT 1 FROM provider_scope_sets WHERE provider_id = ? AND name = ?)", params: [providerId, name] },
    { change: "scope_sets", scopeSet: { name, action: "removed" } },
  );
  await db.run([...event, { sql: "DELETE FROM provider_scope_sets WHERE provider_id = ? AND name = ?", params: [providerId, name] }]);
  return { providerId, name, label: client.label, apps };
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
  const registry = registryOf(rows, install, await readScopeSetRows(db));
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

// OAuth providers: the uploaded clients and the connections (migration 0016).

/** A client uploaded under Admin → Providers, as the CLI reports it: the id, never the secret. */
export interface UploadedClient {
  providerId: string;
  clientId: string;
  hasSecret: boolean;
  addedBy: string | null;
  addedAt: number | null;
}

/** Every client uploaded in the UI (`oauth_clients`), by provider id; none on a Gateway without the table. */
export async function readUploadedClients(db: D1Database): Promise<Map<string, UploadedClient>> {
  if (!(await hasOAuthTables(db))) return new Map();
  const [rows = []] = await db.run([
    {
      sql: "SELECT provider_id, client_id, client_secret_enc IS NOT NULL AS has_secret, added_by, added_at FROM oauth_clients",
    },
  ]);
  return new Map(
    rows.map((row) => [
      String(row["provider_id"]),
      {
        providerId: String(row["provider_id"]),
        clientId: String(row["client_id"]),
        hasSecret: Boolean(Number(row["has_secret"])),
        addedBy: text(row["added_by"]),
        addedAt: row["added_at"] == null ? null : Number(row["added_at"]),
      },
    ]),
  );
}

/** One person's or one organization's connection to an OAuth provider, as `provider connections` reports it: never a token. */
export interface ProviderConnection {
  id: string;
  organizationId: string;
  providerId: string;
  account: "user" | "organization";
  userId: string | null;
  userEmail: string | null;
  label: string | null;
  scopeSets: string[];
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
  /** The organization's own connection only. */
  organization?: boolean;
}

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
  if (filter.organization) clauses.push("c.account_kind = 'organization'");
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

/** The connections `filter` names, newest first; none on a Gateway without the table. */
export async function listConnections(db: D1Database, filter: ConnectionFilter = {}): Promise<ProviderConnection[]> {
  if (!(await hasOAuthTables(db))) return [];
  const where = connectionWhere(filter);
  const [rows = []] = await db.run([
    {
      sql: `SELECT c.id, c.organization_id, c.provider_id, c.account_kind, c.user_id, u.email AS user_email, c.label,
  c.scope_sets, c.status, c.created_at, c.last_used_at, c.expires_at
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
    account: row["account_kind"] === "organization" ? "organization" : "user",
    userId: text(row["user_id"]),
    userEmail: text(row["user_email"]),
    label: text(row["label"]),
    scopeSets: safeStringArray(row["scope_sets"]),
    status: String(row["status"] ?? "active"),
    createdAt: Number(row["created_at"]),
    lastUsedAt: row["last_used_at"] == null ? null : Number(row["last_used_at"]),
    expiresAt: row["expires_at"] == null ? null : Number(row["expires_at"]),
  }));
}

/** The connections of each provider, by id: what `provider list` and `provider show` count. */
export async function countConnections(db: D1Database): Promise<Map<string, number>> {
  if (!(await hasOAuthTables(db))) return new Map();
  const [rows = []] = await db.run([
    { sql: "SELECT provider_id, count(*) AS n FROM provider_connections GROUP BY provider_id" },
  ]);
  return new Map(rows.map((row) => [String(row["provider_id"]), Number(row["n"])]));
}

/**
 * Delete the connections `filter` names (`provider disconnect`), queueing
 * `provider.disconnected` for each in the batch that deletes it, as the
 * operator, with `revoked: false`: the CLI holds no token and can't revoke
 * at the provider; the done event says where to. The rows deleted.
 */
export async function removeConnections(
  db: D1Database,
  filter: ConnectionFilter & { providerId: string; providerName: string },
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
            kind: connection.account,
            ...(connection.userId
              ? { user: { id: connection.userId, ...(connection.userEmail ? { email: connection.userEmail } : {}) } }
              : {}),
            ...(connection.label ? { label: connection.label } : {}),
          },
          revoked: false,
        },
        onlyIf: { sql: "EXISTS (SELECT 1 FROM provider_connections WHERE id = ?)", params: [connection.id] },
        now,
      })),
      { sql: "DELETE FROM provider_connections WHERE id = ?", params: [connection.id] },
    );
  }
  await db.run(statements);
  return connections;
}
