/**
 * The registry rules for remote MCP apps (`@every-app/sdk/internal`
 * remoteMcp.ts; docs/design/2026-10-mcp-by-url.md): a remote MCP server
 * the operator, an owner or an admin registers by URL as an MCP app of the
 * Gateway's own. Pure functions over rows the caller read, like
 * ./providerApps.ts: the CLI runs them against the Gateway's D1 under the
 * Cloudflare login (ADR-0003), the Gateway's server functions and
 * workspace tools run them in-process for owners and admins.
 *
 * A remote MCP app's row is a provider-tier row (no Worker, no hostname,
 * `active` from the start) whose manifest carries the `remote` block: the
 * one URL, the credential (none, or a provider of the registry: a catalog
 * entry, a registered row, or the app's own `<id>-mcp` row planned by
 * {@link planRemoteMcpProviderRow}), the risk default, the per-tool
 * overrides and a revision. Remote MCP apps are not metered
 * ({@link isMeteredAppRow}): their calls are counted and audited, never
 * capped. The same id as a
 * deployed app's or a built-in provider's is refused, tombstones included.
 * Who opens the app follows a deployed app's rule: the owners and the
 * admins; an admin grants others or makes it available to everyone.
 *
 * `on` and `off` are the status, for both kinds of MCP app: `active`
 * serves, `disabled` keeps everything (access, tokens, the snapshot) and
 * serves nothing. `remove` is the tombstone (what `off` used to be).
 */
import {
  canonicalJson,
  hasRemoteMcpBlock,
  isProviderAppId,
  parseRemoteMcpAuth,
  parseRemoteMcpBlock,
  providerBindingKey,
  PROVIDER_APP_TIER,
  remoteMcpAppManifest,
  remoteMcpIdFromUrl,
  remoteMcpIdProblem,
  remoteMcpOf,
  remoteMcpProviderHosts,
  remoteMcpProviderId,
  remoteMcpUrlProblem,
  resolveProviderRow,
  REMOTE_MCP_RISK_DEFAULTS,
  type Capability,
  type CapabilitySettings,
  type ProviderRow,
  type RegistrableCapability,
  type RemoteMcpAuth,
  type RemoteMcpBlock,
  type RemoteMcpRiskDefault,
  type RemoteMcpToolOverride,
  type RemoteMcpUrlEnv,
} from "@every-app/sdk/internal";
import {
  DELETED_APP_STATUS,
  deleteUpdate,
  RegistrationError,
  type AppRow,
} from "./registration";

export interface RemoteMcpAddInput {
  organizationId: string;
  /** The server's URL as given. */
  url: string;
  /** The app id; derived from the URL's host when absent. */
  id?: string | null;
  name?: string | null;
  description?: string | null;
  /**
   * The credential as given: `{ kind: "none" }` (the default), or
   * `{ kind: "provider", provider? }`; a provider left out is the app's
   * own row, `<id>-mcp` ({@link planRemoteMcpProviderRow}).
   */
  auth?: unknown;
  /**
   * The provider registry as the caller resolves it: the gateway's
   * registry, plus the app's own `<id>-mcp` row when it is about to be
   * written (its capability, from {@link planRemoteMcpProviderRow}).
   * Required when `auth` names a provider.
   */
  lookupProvider?: (providerId: string) => Capability | undefined;
  /** The Gateway's settings, for an API-key provider whose host is a setting (`hostSetting`). */
  providerSettings?: CapabilitySettings;
  /** An OAuth provider's scopes the connect asks for (discovery's; none: the server decides). */
  scopes?: readonly string[] | null;
  risk?: string | null;
  /** The Gateway's environment the URL is checked against. */
  env: RemoteMcpUrlEnv;
  /** The organization's row for the id (tombstones included), once the id is known. */
  existingApp: (id: string) => AppRow | null;
  /**
   * A shared-scope app (the platform's, visible to every organization on a
   * hosted gateway) under this id, if any: a remote server can't take its
   * id, since both would list under the same tool prefix.
   */
  sharedApp?: (id: string) => AppRow | null;
  /** Who added it, as the row records it (`deployed_by_actor`). */
  actor: string | null;
  now: number;
}

export interface RemoteMcpAddPlan {
  /** `new`: insert `app`. `revived`: the id's own tombstone comes back as new. */
  kind: "new" | "revived";
  id: string;
  app: AppRow;
  remote: RemoteMcpBlock;
  /** The provider the app's credential is, as resolved; null for none. */
  provider: { id: string; capability: Capability } | null;
}

function refuse(
  code:
    | "REMOTE_MCP_INVALID"
    | "REMOTE_MCP_URL_REFUSED"
    | "REMOTE_MCP_PROVIDER_HOST",
  message: string,
): never {
  throw new RegistrationError({ status: 400, code, message });
}

/** The auth block as given, the app's own provider id filled in when a provider kind names none. */
function authFor(id: string, raw: unknown): RemoteMcpAuth {
  const given =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { kind: raw ?? "none" };
  const withDefault =
    given["kind"] === "provider" && given["provider"] === undefined
      ? { ...given, provider: remoteMcpProviderId(id) }
      : given;
  const parsed = parseRemoteMcpAuth(withDefault);
  if (!parsed.ok) refuse("REMOTE_MCP_INVALID", parsed.problem);
  return parsed.auth;
}

/**
 * The provider `auth` names, checked for a remote MCP app at `url`: it
 * exists, it is an API-key provider or an OAuth provider the Gateway runs
 * the flow for, and the URL's host is
 * one of the hosts the provider sends its credential to
 * (`REMOTE_MCP_PROVIDER_HOST`). Returns the capability and those hosts.
 */
export function checkRemoteMcpProvider(input: {
  url: string;
  auth: Extract<RemoteMcpAuth, { kind: "provider" }>;
  lookupProvider?: (providerId: string) => Capability | undefined;
  providerSettings?: CapabilitySettings;
}): { capability: Capability; hosts: string[] } {
  const { auth } = input;
  const capability = input.lookupProvider?.(auth.provider);
  if (!capability) {
    refuse(
      "REMOTE_MCP_INVALID",
      `there is no provider ${auth.provider} on this Gateway (pnpm everyapp provider list names them)`,
    );
  }
  const hosts = remoteMcpProviderHosts(capability, input.providerSettings);
  if (!hosts) {
    refuse(
      "REMOTE_MCP_INVALID",
      `${auth.provider} can't be an MCP server's credential: it must be an API-key provider or an OAuth provider the Gateway connects people to`,
    );
  }
  let host = "";
  try {
    host = new URL(input.url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    refuse("REMOTE_MCP_URL_REFUSED", "the URL doesn't parse");
  }
  if (!hosts.includes(host)) {
    refuse(
      "REMOTE_MCP_PROVIDER_HOST",
      `${auth.provider} sends its key to ${hosts.length > 0 ? hosts.join(", ") : "no host"}, not to ${host}`,
    );
  }
  return { capability, hosts };
}

/** A remote MCP app's row is a provider-tier row with a `remote` block. */
export function isRemoteMcpRow(
  app: Pick<AppRow, "tier" | "manifest">,
): boolean {
  if (app.tier !== PROVIDER_APP_TIER || !app.manifest) return false;
  try {
    return hasRemoteMcpBlock(JSON.parse(app.manifest));
  } catch {
    return false;
  }
}

/** An MCP app's row of either kind: a built-in provider's or a remote server's. */
export function isMcpAppRow(app: Pick<AppRow, "tier">): boolean {
  return app.tier === PROVIDER_APP_TIER;
}

/** The stored `remote` block of a row, or null (a built-in's row, or an unreadable block). */
export function remoteMcpBlockOf(
  app: Pick<AppRow, "tier" | "manifest">,
): RemoteMcpBlock | null {
  if (app.tier !== PROVIDER_APP_TIER || !app.manifest) return null;
  try {
    return remoteMcpOf(JSON.parse(app.manifest));
  } catch {
    return null;
  }
}

/** The id's row must be this organization's and this id's. */
function assertRowMatches(
  organizationId: string,
  id: string,
  existingApp: AppRow | null,
): void {
  if (
    existingApp &&
    (existingApp.organizationId !== organizationId ||
      existingApp.appSlug !== id)
  ) {
    throw new Error("existingApp is another organization's or app's row.");
  }
}

/** A row that isn't a remote MCP app's: a deployed app's, or the built-in's. */
function assertRemoteRow(id: string, existingApp: AppRow): void {
  if (isRemoteMcpRow(existingApp)) return;
  const what =
    existingApp.tier === PROVIDER_APP_TIER
      ? "the Gateway's built-in MCP app"
      : `an app deployed to this Gateway${existingApp.status === DELETED_APP_STATUS ? " (deleted, its names still its organization's)" : ""}`;
  throw new RegistrationError({
    status: 409,
    code: "APP_TIER_MISMATCH",
    message: `"${id}" is ${what}; a remote MCP server can't take its id.`,
  });
}

/**
 * Register a remote MCP server: what to write, from the input and the
 * organization's row for the id (if any). Refuses a URL
 * the rules refuse (`REMOTE_MCP_URL_REFUSED`; a provider host only with
 * that provider), a bad id, auth block, provider or risk
 * (`REMOTE_MCP_INVALID`), a provider whose hosts don't include the URL's
 * (`REMOTE_MCP_PROVIDER_HOST`), an id in use (`APP_TIER_MISMATCH` for a
 * deployed app's or the built-in's; `REMOTE_MCP_EXISTS` for a remote app
 * that is on or off already: edit or remove it instead). The app's own
 * provider row is planned apart ({@link planRemoteMcpProviderRow}), first,
 * so `lookupProvider` can answer for it.
 */
export function planRemoteMcpAppAdd(
  input: RemoteMcpAddInput,
): RemoteMcpAddPlan {
  const url = input.url.trim();
  const id = (input.id ?? "").trim() || remoteMcpIdFromUrl(url);
  if (!id) {
    const urlProblem = remoteMcpUrlProblem(url, input.env);
    if (urlProblem) refuse("REMOTE_MCP_URL_REFUSED", urlProblem);
    refuse(
      "REMOTE_MCP_INVALID",
      "no app id could be read from the URL's host; give one with --name",
    );
  }
  const idProblem = remoteMcpIdProblem(id);
  if (idProblem) refuse("REMOTE_MCP_INVALID", idProblem);
  const auth = authFor(id, input.auth);
  // The reserved-host rule gives way only to a provider of the registry
  // the app names, never to the app's own row (which names whatever host
  // the URL has).
  const named =
    auth.kind === "provider" && auth.provider !== remoteMcpProviderId(id)
      ? input.lookupProvider?.(auth.provider)
      : undefined;
  const urlProblem = remoteMcpUrlProblem(url, input.env, {
    providerHosts: named
      ? (remoteMcpProviderHosts(named, input.providerSettings) ?? [])
      : [],
  });
  if (urlProblem) refuse("REMOTE_MCP_URL_REFUSED", urlProblem);
  let provider: { id: string; capability: Capability } | null = null;
  if (auth.kind === "provider") {
    const checked = checkRemoteMcpProvider({
      url,
      auth,
      ...(input.lookupProvider ? { lookupProvider: input.lookupProvider } : {}),
      ...(input.providerSettings
        ? { providerSettings: input.providerSettings }
        : {}),
    });
    provider = { id: auth.provider, capability: checked.capability };
  }
  const shared = input.sharedApp?.(id);
  if (shared && shared.status !== DELETED_APP_STATUS) {
    throw new RegistrationError({
      status: 409,
      code: "APP_TIER_MISMATCH",
      message: `"${id}" is a shared app every organization sees; a remote MCP server can't take its id.`,
    });
  }
  const existingApp = input.existingApp(id);
  assertRowMatches(input.organizationId, id, existingApp);
  const risk = (input.risk ?? "annotations").trim();
  if (!(REMOTE_MCP_RISK_DEFAULTS as readonly string[]).includes(risk)) {
    refuse(
      "REMOTE_MCP_INVALID",
      `risk must be one of ${REMOTE_MCP_RISK_DEFAULTS.join(", ")}`,
    );
  }
  // A revived tombstone continues its revision count: a snapshot or an
  // isolate's cache from the removed registration must read as stale.
  const previousRev = existingApp
    ? (remoteMcpBlockOf(existingApp)?.rev ?? 0)
    : 0;
  const remote: RemoteMcpBlock = {
    url,
    auth,
    risk: risk as RemoteMcpRiskDefault,
    tools: {},
    rev: previousRev + 1,
  };
  const manifest = remoteMcpAppManifest({
    id,
    name: input.name,
    description: input.description,
    remote,
    providerCapability: provider?.capability ?? null,
    scopes: input.scopes ?? null,
  });

  if (existingApp) {
    if (isProviderAppId(id) || !isRemoteMcpRow(existingApp)) {
      assertRemoteRow(id, existingApp);
    }
    if (existingApp.status !== DELETED_APP_STATUS) {
      throw new RegistrationError({
        status: 409,
        code: "REMOTE_MCP_EXISTS",
        message: `"${id}" is an MCP app on this Gateway already (${existingApp.status === "active" ? "on" : "off"}); remove it first, or change it in place.`,
      });
    }
  }
  const rowId = existingApp?.id ?? crypto.randomUUID();
  const app: AppRow = {
    id: rowId,
    organizationId: input.organizationId,
    appSlug: id,
    name: manifest.name,
    description: manifest.description,
    hostname: null,
    workerName: null,
    tier: PROVIDER_APP_TIER,
    scope: "org",
    manifest: JSON.stringify(manifest),
    status: "active",
    versionId: null,
    deployedAt: input.now,
    deployedByActor: input.actor,
    everyone: false,
  };
  return {
    kind: existingApp ? "revived" : "new",
    id,
    app,
    remote,
    provider,
  };
}

export interface RemoteMcpProviderRowInput {
  /** The app the row is for: its id is `<appId>-mcp`. */
  appId: string;
  /** The spec, from `mcpStaticProviderSpec` or `mcpOAuthProviderSpec` (`@every-app/sdk/internal`). */
  spec: Record<string, unknown>;
  /** The `providers` row with that id, if there is one. */
  existing: ProviderRow | null;
  /** The settings the gateway's other rows hold (`registry.settingNames()` of the rows, this one's left out). */
  rowSettings?: ReadonlySet<string>;
  /** A host no row may name on this gateway, with why (`gatewayHostRefusal` with its hosts). */
  refuseHost?: (host: string) => string | null;
}

/**
 * What to do with the app's own provider row (`<appId>-mcp`): `insert` a
 * new one; `keep` the one there when its spec is the same; `replace` it
 * when it differs. A replaced row keeps its `bound_to`: the registry reads
 * the key only while that still equals {@link providerBindingKey} of the
 * new spec, so a changed host, auth placement, endpoint, resource or
 * issuer unbinds the key or client until it is set again (the pin), and a
 * changed name does not. A row of that id registered by hand (no `mcp`
 * tag) is refused rather than replaced. `mcp remove` never deletes the row.
 */
export type RemoteMcpProviderRowPlan = {
  action: "insert" | "replace" | "keep";
  id: string;
  /** The spec as the row stores it (JSON text). */
  spec: string;
  capability: RegistrableCapability;
  /** The binding key of the new spec, what `secret set` writes to `bound_to`. */
  bindingKey: string;
  /** Whether the row's key or client is bound to this spec already (false for `insert`). */
  bound: boolean;
};

export function planRemoteMcpProviderRow(
  input: RemoteMcpProviderRowInput,
): RemoteMcpProviderRowPlan {
  const id = remoteMcpProviderId(input.appId);
  if (input.spec["id"] !== id) {
    throw new Error(`planRemoteMcpProviderRow: the spec is not ${id}'s`);
  }
  const resolved = resolveProviderRow(
    { id, spec: input.spec },
    {
      rowSettings: input.rowSettings ?? new Set(),
      ...(input.refuseHost ? { refuseHost: input.refuseHost } : {}),
    },
  );
  if (!resolved.ok) {
    refuse(
      resolved.refusal.code === "PROVIDER_HOST_REFUSED"
        ? "REMOTE_MCP_URL_REFUSED"
        : "REMOTE_MCP_INVALID",
      `the server's credential can't be registered as ${id}: ${resolved.refusal.message}`,
    );
  }
  const capability = resolved.capability;
  const bindingKey = providerBindingKey(capability);
  const spec = JSON.stringify(input.spec);
  if (!input.existing) {
    return { action: "insert", id, spec, capability, bindingKey, bound: false };
  }
  let existingSpec: unknown = input.existing.spec;
  if (typeof existingSpec === "string") {
    try {
      existingSpec = JSON.parse(existingSpec);
    } catch {
      existingSpec = null;
    }
  }
  const tags =
    existingSpec && typeof existingSpec === "object"
      ? (existingSpec as Record<string, unknown>)["tags"]
      : undefined;
  if (existingSpec !== null && !(Array.isArray(tags) && tags.includes("mcp"))) {
    refuse(
      "REMOTE_MCP_INVALID",
      `${id} is a provider registered by hand, not this MCP app's own; remove it (pnpm everyapp provider remove ${id}) or give the app another id with --name`,
    );
  }
  const bound = (input.existing.boundTo ?? null) === bindingKey;
  if (
    existingSpec !== null &&
    canonicalJson(existingSpec) === canonicalJson(input.spec)
  ) {
    return { action: "keep", id, spec, capability, bindingKey, bound };
  }
  return { action: "replace", id, spec, capability, bindingKey, bound };
}

/**
 * Whether an app row is metered (caps, cap checks, cap alerts): every
 * deployed app and built-in MCP app is; a remote MCP app (a provider-tier
 * row with a `remote` block, readable or not) is not. Its calls are still
 * counted in usage and audited.
 */
export function isMeteredAppRow(
  app: Pick<AppRow, "tier" | "manifest">,
): boolean {
  return !isRemoteMcpRow(app);
}

/** The words of `APP_NOT_METERED`: a cap asked of a remote MCP app. */
export function appNotMeteredMessage(name: string): string {
  return `${name} is an MCP server added by URL; it isn't metered, so it takes no cap.`;
}

export interface RemoteMcpChange {
  /** The whole override map replaces the stored one. */
  tools?: Record<string, RemoteMcpToolOverride>;
  /** One tool's override merged into the stored map (`null` clears it). */
  tool?: { name: string; override: RemoteMcpToolOverride | null };
  risk?: string;
  name?: string | null;
  description?: string | null;
}

/**
 * Change a remote MCP app in place: the risk default, the overrides (all,
 * or one tool's), the name or the description. The URL and the auth are
 * not changed here: a server at another address is another app (and a
 * changed address would move a credential; see the binding in the
 * design). Returns the updated manifest JSON and the row fields to write,
 * with `rev` bumped so the Gateway re-lists on first use.
 */
export function remoteMcpAppUpdate(
  app: AppRow,
  change: RemoteMcpChange,
): {
  manifest: string;
  name: string;
  description: string;
  remote: RemoteMcpBlock;
} {
  const current = remoteMcpBlockOf(app);
  if (!current) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `"${app.appSlug}" is not a remote MCP app.`,
    });
  }
  if (app.status === DELETED_APP_STATUS) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `"${app.appSlug}" was removed.`,
    });
  }
  let risk: RemoteMcpRiskDefault = current.risk;
  if (change.risk !== undefined) {
    if (
      !(REMOTE_MCP_RISK_DEFAULTS as readonly string[]).includes(change.risk)
    ) {
      refuse(
        "REMOTE_MCP_INVALID",
        `risk must be one of ${REMOTE_MCP_RISK_DEFAULTS.join(", ")}`,
      );
    }
    risk = change.risk as RemoteMcpRiskDefault;
  }
  let tools = { ...current.tools };
  if (change.tools) tools = { ...change.tools };
  if (change.tool) {
    const { name, override } = change.tool;
    if (!name.trim()) refuse("REMOTE_MCP_INVALID", "name the tool");
    if (override === null) {
      delete tools[name];
    } else {
      const merged = { ...tools[name], ...override };
      if (merged.risk === undefined) delete merged.risk;
      if (merged.enabled === undefined || merged.enabled === true) {
        delete merged.enabled;
      }
      if (Object.keys(merged).length === 0) delete tools[name];
      else tools[name] = merged;
    }
  }
  // The catalog depends on the risk default and the overrides alone: only
  // a change there bumps the revision (and re-lists on first use).
  const catalogChanged =
    canonicalJson({ risk, tools }) !==
    canonicalJson({ risk: current.risk, tools: current.tools });
  const remote: RemoteMcpBlock = {
    ...current,
    risk,
    tools,
    rev: catalogChanged ? current.rev + 1 : current.rev,
  };
  const checked = parseRemoteMcpBlock(remote);
  if (!checked.ok) refuse("REMOTE_MCP_INVALID", checked.problem);
  const stored = JSON.parse(app.manifest ?? "{}") as Record<string, unknown>;
  const manifest = remoteMcpAppManifest({
    id: app.appSlug,
    name: change.name === undefined ? app.name : change.name,
    description:
      change.description === undefined ? app.description : change.description,
    remote,
  });
  // Keep anything else the stored manifest carried, and its provider
  // entry as it was written (with the OAuth scopes it lists).
  const next = {
    ...stored,
    ...manifest,
    ...(stored["capabilities"] === undefined
      ? {}
      : { capabilities: stored["capabilities"] }),
  };
  return {
    manifest: JSON.stringify(next),
    name: manifest.name,
    description: manifest.description,
    remote,
  };
}

export type McpAppStatus = "active" | "disabled";

/**
 * Turn an MCP app of either kind on or off: the status update to write,
 * or null when nothing changes (it is in that state already). A
 * tombstone or a row that isn't an MCP app's is refused: `on` after
 * `remove` is `add` again (or, for a built-in, `mcp on`, which revives it).
 */
export function mcpAppStatusUpdate(
  app: AppRow,
  status: McpAppStatus,
): { status: McpAppStatus } | null {
  if (!isMcpAppRow(app)) {
    throw new RegistrationError({
      status: 409,
      code: "APP_TIER_MISMATCH",
      message: `"${app.appSlug}" is an app deployed to this Gateway, not an MCP app.`,
    });
  }
  if (app.status === DELETED_APP_STATUS) {
    throw new RegistrationError({
      status: 404,
      code: "APP_NOT_FOUND",
      message: `"${app.appSlug}" was removed; add it again.`,
    });
  }
  if (app.status === status) return null;
  return { status };
}

/**
 * Remove an MCP app of either kind: the tombstone update to write (a
 * deleted app's, {@link deleteUpdate}; the caller drops everyone's access,
 * its tokens, its tools snapshot and its place in AI connections with
 * it), or null when there is nothing to remove: no row, a tombstone
 * already, or a deployed app's row, which this never touches.
 */
export function mcpAppRemoveUpdate(
  existingApp: AppRow | null,
): ReturnType<typeof deleteUpdate> {
  if (!existingApp || !isMcpAppRow(existingApp)) return null;
  return deleteUpdate(existingApp);
}
