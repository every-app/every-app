/**
 * MCP apps from Admin → Apps (docs/design/2026-10-mcp-by-url.md, section
 * 4, "The UI"): add a remote MCP server by URL, change it, turn an MCP app
 * of either kind on or off, remove one, list its tools again, and show it
 * with every tool's risk and where that risk comes from. The rules are the
 * registry's (@every-app/perimeter/registry remoteMcpApps.ts), the same the
 * CLI runs against D1; a refusal comes back as a PublicError with the
 * rule's code and sentence, which the form shows as it is.
 *
 * A server's credential is a provider (docs/design/2026-11-mcp-apps-auth.md):
 * a static one becomes the app's own API-key row (`<appId>-mcp`) whose
 * value the operator sets in a terminal; OAuth is discovered and a client
 * registered from here, sealed into `oauth_clients`, and each member
 * connects their own account; or an existing provider whose hosts include
 * the URL's. No value passes through here but the sealed paste of an
 * OAuth client a server can't register (Admin → Apps only).
 *
 * Owners and admins do all of it, remove included (as deleting an app
 * is). The server functions' middleware checks the role; each operation
 * checks it again here.
 *
 * `on`/`off` are the status for both kinds (`active` serves, `disabled`
 * keeps access, tokens and the snapshot and serves nothing); `remove` is
 * the tombstone, which #599's `off` used to be.
 *
 * Each write announces itself on the event bus once it has happened
 * (docs/design/2026-10-events-out.md, section 5): `mcp_app.added` for an
 * add, `mcp_app.enabled` or `mcp_app.disabled` for a status that changed,
 * `mcp_app.removed` for a remove, the acting member as the actor and the
 * kind read from the row. The bus never throws, so a webhook never undoes
 * the change that caused it.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  DELETED_APP_STATUS,
  isRemoteMcpRow,
  mcpAppRemoveUpdate,
  mcpAppStatusUpdate,
  planRemoteMcpAppAdd,
  planRemoteMcpProviderRow,
  remoteMcpAppUpdate,
  remoteMcpBlockOf,
  type AppRow,
  type RemoteMcpAddInput,
  type RemoteMcpAddPlan,
  type RemoteMcpChange,
  type RemoteMcpProviderRowPlan,
} from "@every-app/perimeter/registry";
import {
  capabilitySettings,
  chooseTokenEndpointAuthMethod,
  discoverMcpOAuth,
  isRemoteMcpProviderIdOf,
  mcpOAuthProviderSpec,
  mcpStaticProviderSpec,
  PROVIDER_APP_TIER,
  registerMcpClient,
  remoteMcpAuthLabel,
  remoteMcpIdFromUrl,
  remoteMcpProviderHosts,
  remoteMcpProviderId,
  remoteMcpRedirectUri,
  remoteToolEnabled,
  remoteToolRisk,
  isToolRisk,
  type Capability,
  type CapabilitySettings,
  type McpOAuthDiscovery,
  type McpOAuthFetch,
  type McpProviderSpecResult,
  type ProviderRegistry,
  type RemoteMcpBlock,
  type RemoteMcpUrlEnv,
  type ToolRisk,
} from "@every-app/sdk/internal";
import { SETUP_CLI } from "@/server/app-setup";
import { GatewayError, PublicError, getPublicErrorCode } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue, type BuiltEvent } from "@/server/events/catalogue";
import { actorFor } from "@/server/events/subjects";
import type { OrgContext } from "@/server/organization/orgContext";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import {
  McpAppRepository,
  registryRow,
} from "@/server/repositories/McpAppRepository";
import { OAuthClientRepository } from "@/server/repositories/OAuthClientRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { resolveOAuthClient } from "@/server/oauth/client";
import {
  gatewayProviders,
  invalidateGatewayProviders,
  refusedGatewayHost,
  registryFromRows,
} from "@/server/providers";
import { remoteMcpConnectPath } from "@/server/remote-mcp/bind";
import { SealingUnavailableError } from "@/server/secrets/sealed";
import {
  logToolSync,
  syncAppTools,
  type SyncableApp,
} from "@/server/toolbus/catalog-sync";
import type {
  AddRemoteMcpAppInput,
  UpdateRemoteMcpAppInput,
} from "@/schemas/mcpApp";
import type {
  AddedRemoteMcpApp,
  McpAppConnectionStatus,
  McpAppCredential,
  McpAppDetails,
  McpAppSnapshot,
  McpAppTool,
  RefreshedMcpAppTools,
  RemoteToolRiskHint,
} from "@/types/mcpApp";

/**
 * How long adding a server with no credential waits for its tools to be
 * listed, so the answer can say how many; a listing still running then
 * finishes after the response, and the result view says the Gateway lists
 * them on first use. Under the proxy's own 15 s for a listing.
 */
const ADD_LISTING_BUDGET_MS = 8_000;
/** How long Refresh tools waits for the listing it asked for. */
const REFRESH_LISTING_BUDGET_MS = 20_000;

function settings(): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

function setting(name: string): string | null {
  const value = settings()[name];
  return typeof value === "string" && value.trim() ? value : null;
}

/** What a remote server's URL is checked against: this Gateway's own addresses. */
function urlEnv(): RemoteMcpUrlEnv {
  return {
    gatewayUrl: setting("GATEWAY_URL") ?? "",
    appBaseDomain: setting("APP_BASE_DOMAIN"),
    thirdPartyDomain: setting("THIRD_PARTY_DOMAIN"),
  };
}

/** Whether the Gateway has a setting set, read as app-setup reads it. */
function isSet(name: string): boolean {
  return setting(name) !== null;
}

function assertAdmin(ctx: OrgContext): void {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    throw new GatewayError(
      "UNAUTHORIZED",
      "Unauthorized: Organization admin access required",
    );
  }
}

/**
 * A registry rule's refusal as the public error a form shows: its code
 * and its sentence. Anything else is thrown as it was.
 */
function asPublicError(error: unknown): unknown {
  const code = getPublicErrorCode(error);
  if (code && error instanceof Error && error.name === "RegistrationError") {
    return new PublicError(code, error.message);
  }
  return error;
}

function notFound(): PublicError {
  return new PublicError("APP_NOT_FOUND", "No MCP app with that id.");
}

/** The organization's live MCP app row (either kind), or APP_NOT_FOUND. */
async function findMcpRow(ctx: OrgContext, id: string) {
  const row = await AppRepository.findById(id, ctx.orgId);
  if (!row || row.tier !== PROVIDER_APP_TIER) throw notFound();
  return row;
}

/** The organization's live remote MCP app row, or APP_NOT_FOUND. */
async function findRemoteRow(ctx: OrgContext, id: string) {
  const row = await findMcpRow(ctx, id);
  if (!isRemoteMcpRow(row)) {
    throw new PublicError(
      "APP_NOT_FOUND",
      `"${row.appSlug}" is the Gateway's built-in MCP app, not a remote server.`,
    );
  }
  return row;
}

/**
 * The row as a sync reaches it. The manifest is what tells a remote
 * server's row from a built-in's (catalog-sync's appFetcherFor): without
 * it a remote row would be listed as a built-in provider, and fail.
 */
function syncable(
  app: Pick<AppRow, "id" | "organizationId" | "appSlug" | "name" | "manifest">,
): SyncableApp {
  return {
    rowId: app.id,
    organizationId: app.organizationId,
    appSlug: app.appSlug,
    hostname: null,
    workerName: null,
    tier: PROVIDER_APP_TIER,
    versionId: null,
    manifest: app.manifest,
    name: app.name,
  };
}

type McpAppKind = "builtin" | "remote";

/** Which kind of MCP app a row is: a remote server's when it has a remote block. */
function kindOf(row: Pick<AppRow, "tier" | "manifest">): McpAppKind {
  return isRemoteMcpRow(row) ? "remote" : "builtin";
}

/**
 * Announce an MCP app write on the event bus, the acting member as the
 * actor and the app as the event names it. Never throws.
 */
async function announce(
  ctx: OrgContext,
  app: Pick<AppRow, "id" | "appSlug" | "name">,
  build: (subject: {
    app: { id: string; rowId: string; name: string };
  }) => BuiltEvent,
): Promise<void> {
  await emit(async () => ({
    organizationId: ctx.orgId,
    actor: await actorFor(ctx),
    ...build({ app: { id: app.appSlug, rowId: app.id, name: app.name } }),
  }));
}

type Listing = {
  status: McpAppSnapshot["status"];
  toolCount: number;
  error: string | null;
};

/**
 * List an MCP app's tools now (catalog-sync's syncAppTools, the seam the
 * /mcp path takes on first use), waiting up to `budgetMs`: the listing's
 * outcome, or null when it didn't finish in time (it finishes after the
 * response) or couldn't start (the app can't be reached from here yet).
 * `previousNames` are the tool names a dropped snapshot held, so the
 * listing's app.tools_changed compares against them. Never throws.
 */
async function listToolsWithin(
  app: SyncableApp,
  budgetMs: number,
  previousNames?: readonly string[],
): Promise<Listing | null> {
  const listing: Promise<Listing | null> = syncAppTools(app, {
    previousNames,
  }).then(
    (result) => {
      logToolSync(app, result, "first_use");
      return {
        status: result.status,
        toolCount: result.toolCount,
        error: result.error ?? null,
      };
    },
    (error: unknown) => {
      logEvent(
        "mcp.catalog.sync_failed",
        {
          app: app.appSlug,
          trigger: "first_use",
          message: error instanceof Error ? error.message : String(error),
        },
        "warn",
      );
      return null;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), budgetMs);
  });
  const outcome = await Promise.race([listing, late]);
  clearTimeout(timer);
  if (outcome === "late") {
    waitUntil(listing);
    return null;
  }
  return outcome;
}

/** The Gateway's own fetch for OAuth discovery and client registration; tests stand in for the servers. */
let oauthFetch: McpOAuthFetch | undefined;

/** Tests stand in for a server's metadata and registration endpoints; `undefined` restores `fetch`. */
export function setMcpOAuthFetchForTests(
  fetcher: McpOAuthFetch | undefined,
): void {
  oauthFetch = fetcher;
}

function discoveryFetch(): McpOAuthFetch {
  return oauthFetch ?? ((input, init) => fetch(input, init));
}

function gatewayUrl(): string {
  return (setting("GATEWAY_URL") ?? "").trim().replace(/\/+$/, "");
}

/** The words a person reads in place of a bare problem: a sentence, ending once. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The provider settings named for `secret set`: the ones an API-key provider reads. */
function apiKeySetupCommand(capability: Capability): string | null {
  if (capability.mode !== "api_key") return null;
  return `${SETUP_CLI} secret set ${capabilitySettings(capability).join(" ")}`;
}

/** Whether an API-key provider's key is set and bound to the hosts it has now. */
function apiKeyReady(
  providerId: string,
  capability: Capability,
  registry: ProviderRegistry,
): boolean {
  if (capability.mode !== "api_key") return false;
  return (
    registry.bound(providerId) &&
    capabilitySettings(capability).every((name) => isSet(name))
  );
}

/** A synthesized provider row's spec, or the rules' refusal as a public error. */
function specOrRefuse(result: McpProviderSpecResult): Record<string, unknown> {
  if (!result.ok) {
    throw new PublicError("REMOTE_MCP_INVALID", sentence(result.problem));
  }
  return result.spec;
}

interface OAuthClientChoice {
  clientId: string;
  clientSecret: string | null;
  inject: "form" | "basic";
  registered: "dcr" | "pasted";
}

/**
 * Find how the server signs in (RFC 9728 and RFC 8414 metadata, fetched
 * from here: https, public hosts, no redirects, bounded) and get a client:
 * the pasted one (Admin → Apps only), else one the server registers for
 * this Gateway (RFC 7591). Refuses `REMOTE_MCP_OAUTH_DISCOVERY` when the
 * metadata can't be read, `REMOTE_MCP_OAUTH_NO_CLIENT` when no client can
 * be had (with the redirect URI to register one by hand).
 */
async function oauthClientFor(
  url: string,
  appId: string,
  name: string,
  auth: AddRemoteMcpAppInput["auth"],
  allowPastedClient: boolean,
): Promise<{ discovery: McpOAuthDiscovery; client: OAuthClientChoice }> {
  const fetcher = discoveryFetch();
  const discovered = await discoverMcpOAuth({ url, fetch: fetcher });
  if (!discovered.ok) {
    throw new PublicError(
      "REMOTE_MCP_OAUTH_DISCOVERY",
      sentence(
        `The Gateway couldn't find how ${url} signs in: ${discovered.problem}`,
      ),
    );
  }
  const discovery = discovered.discovery;
  const redirectUri = remoteMcpRedirectUri(gatewayUrl(), appId);
  if (auth.clientId) {
    if (!allowPastedClient) {
      throw new PublicError(
        "INVALID_INPUT",
        "A client id and secret are pasted in Admin → Apps or given to the CLI, never through a tool.",
      );
    }
    const secret = auth.clientSecret ?? null;
    const method = chooseTokenEndpointAuthMethod(
      discovery.tokenEndpointAuthMethods,
    );
    return {
      discovery,
      client: {
        clientId: auth.clientId,
        clientSecret: secret,
        inject: secret && method === "client_secret_basic" ? "basic" : "form",
        registered: "pasted",
      },
    };
  }
  const registration = await registerMcpClient({
    discovery,
    redirectUri,
    clientName: `EveryApp (${name})`.slice(0, 100),
    fetch: fetcher,
  });
  if (!registration.ok) {
    throw new PublicError(
      "REMOTE_MCP_OAUTH_NO_CLIENT",
      `${sentence(registration.problem)} Register a client with ${discovery.issuer} using the redirect URI ${redirectUri}, then paste its client id and secret in Admin → Apps.`,
    );
  }
  return {
    discovery,
    client: {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret ?? null,
      inject: registration.inject,
      registered: "dcr",
    },
  };
}

/** Seal an OAuth client into `oauth_clients`, bound to the row's binding key. */
async function sealClient(
  providerId: string,
  client: OAuthClientChoice,
  bindingKey: string,
  addedBy: string,
): Promise<void> {
  try {
    await OAuthClientRepository.upsert(
      {
        providerId,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        boundTo: bindingKey,
        addedBy,
      },
      env as never,
    );
  } catch (error) {
    if (error instanceof SealingUnavailableError) {
      throw new PublicError(
        "SEALING_UNAVAILABLE",
        "This Gateway can't seal a secret: BETTER_AUTH_SECRET is not set",
      );
    }
    throw error;
  }
}

/** Write the app's own provider row as planned: insert it, replace its spec (its binding kept), or keep it. */
async function writeProviderRow(
  plan: RemoteMcpProviderRowPlan,
  addedBy: string,
): Promise<void> {
  if (plan.action === "insert") {
    const written = await ProviderRepository.insert({
      id: plan.id,
      spec: plan.spec,
      addedBy,
    });
    // Written meanwhile by another add: this spec replaces it, its binding kept.
    if (!written)
      await ProviderRepository.replaceSpec({ id: plan.id, spec: plan.spec });
  } else if (plan.action === "replace") {
    await ProviderRepository.replaceSpec({ id: plan.id, spec: plan.spec });
    // Tokens issued under the old spec (another server, other endpoints)
    // never go to the new one: every connection is dropped, and members
    // connect again.
    await ProviderConnectionRepository.removeAllForProvider(plan.id);
  }
  if (plan.action !== "keep") invalidateGatewayProviders();
}

/**
 * Register a remote MCP server for the organization: the row (owners and
 * admins open it by their role; an admin grants anyone else), with its
 * credential as a provider. A static credential (bearer, header,
 * query, basic) becomes the app's own API-key row, `<appId>-mcp`, whose
 * value the operator sets with `secret set` (never here). OAuth discovers
 * the server's authorization server, registers a client (or takes the
 * pasted one, Admin → Apps only), writes the app's own `oauth2-user` row
 * and seals the client into `oauth_clients` bound to it; each member then
 * connects their own account. `provider` names an existing provider whose
 * hosts include the URL's (`REMOTE_MCP_PROVIDER_HOST`). For a server that
 * needs nothing more, its tools are listed within the request so the
 * answer can say how many.
 */
async function add(
  ctx: OrgContext,
  input: AddRemoteMcpAppInput,
  actor: string | null,
  options: { allowPastedClient?: boolean } = { allowPastedClient: true },
): Promise<AddedRemoteMcpApp> {
  assertAdmin(ctx);
  const url = input.url.trim();
  const credentialKind = input.auth.kind;
  // The id the rules will settle on, so its row (a tombstone included) is
  // read before they run: they read rows, they don't fetch them.
  const wanted = input.id ?? remoteMcpIdFromUrl(url);
  const [existing, registry] = await Promise.all([
    wanted ? AppRepository.findByAppSlug(wanted, ctx.orgId) : undefined,
    gatewayProviders(),
  ]);
  const base = {
    organizationId: ctx.orgId,
    url,
    id: input.id ?? null,
    name: input.name ?? null,
    description: input.description ?? null,
    risk: input.risk ?? null,
    env: urlEnv(),
    existingApp: (id: string) =>
      existing && existing.appSlug === id ? registryRow(existing) : null,
    actor,
    now: Date.now(),
  };
  const plan = (input: Partial<RemoteMcpAddInput>) => {
    try {
      return planRemoteMcpAppAdd({ ...base, ...input });
    } catch (error) {
      throw asPublicError(error);
    }
  };
  const addedBy = actor ?? ctx.userId;
  const ownKinds = credentialKind !== "none" && credentialKind !== "provider";
  // Every rule but the credential's first (the id, the URL, an id in use),
  // so nothing is fetched or written for a server the rules refuse.
  if (ownKinds) plan({ auth: { kind: "none" } });

  let added: RemoteMcpAddPlan;
  let providerRow: RemoteMcpProviderRowPlan | null = null;
  let client: OAuthClientChoice | null = null;
  let issuer: string | null = null;
  let scopes: string[] = [];
  if (credentialKind === "none") {
    added = plan({ auth: { kind: "none" } });
  } else if (credentialKind === "provider") {
    if (!input.auth.provider) {
      throw new PublicError(
        "INVALID_INPUT",
        "Choose the provider whose credential the server takes.",
      );
    }
    // Another organization's server's own row (`<appId>-mcp`) holds that
    // organization's key: never one to point a second app at.
    if (
      input.auth.provider.endsWith("-mcp") &&
      registry.sourceOf(input.auth.provider) === "row" &&
      (await McpAppRepository.providerUsedByOtherOrganization(
        input.auth.provider,
        ctx.orgId,
      ))
    ) {
      throw new PublicError(
        "REMOTE_MCP_INVALID",
        `${input.auth.provider} is the credential of another organization's MCP app on this Gateway.`,
      );
    }
    added = plan({
      auth: {
        kind: "provider",
        provider: input.auth.provider,
      },
      lookupProvider: (id) => registry.get(id),
      providerSettings: settings() as CapabilitySettings,
    });
  } else {
    const appId = wanted!;
    const name = input.name ?? appId;
    let spec: Record<string, unknown>;
    if (credentialKind === "oauth") {
      const got = await oauthClientFor(
        url,
        appId,
        name,
        input.auth,
        options.allowPastedClient === true,
      );
      client = got.client;
      issuer = got.discovery.issuer;
      scopes = got.discovery.scopes;
      spec = specOrRefuse(
        mcpOAuthProviderSpec({
          appId,
          name,
          url,
          discovery: got.discovery,
          client: {
            hasSecret: client.clientSecret !== null,
            inject: client.inject,
          },
        }),
      );
    } else {
      spec = specOrRefuse(
        mcpStaticProviderSpec({
          appId,
          name,
          url,
          kind: credentialKind,
          header: input.auth.header ?? null,
          prefix: input.auth.prefix ?? null,
          param: input.auth.param ?? null,
        }),
      );
    }
    const providerId = remoteMcpProviderId(appId);
    // The row and its key are the Gateway's: never another organization's
    // app's credential to rewrite or share.
    if (
      await McpAppRepository.providerUsedByOtherOrganization(
        providerId,
        ctx.orgId,
      )
    ) {
      throw new PublicError(
        "REMOTE_MCP_INVALID",
        `${providerId} is the credential of another organization's MCP app on this Gateway; give this app another name.`,
      );
    }
    const rows = await ProviderRepository.all();
    const others = registryFromRows(
      rows.filter((row) => row.id !== providerId),
    );
    try {
      providerRow = planRemoteMcpProviderRow({
        appId,
        spec,
        existing: rows.find((row) => row.id === providerId) ?? null,
        rowSettings: new Set(
          others.rows().flatMap((row) => capabilitySettings(row.capability)),
        ),
        refuseHost: (host) => refusedGatewayHost(host, env as never),
      });
    } catch (error) {
      throw asPublicError(error);
    }
    const ownRow = providerRow;
    added = plan({
      auth: { kind: "provider" },
      scopes,
      lookupProvider: (id) =>
        id === ownRow.id ? ownRow.capability : registry.get(id),
      providerSettings: settings() as CapabilitySettings,
    });
    await writeProviderRow(providerRow, addedBy);
    if (client)
      await sealClient(providerRow.id, client, providerRow.bindingKey, addedBy);
  }
  await McpAppRepository.writeRemoteApp(added.app);
  // A revived tombstone is added again, as a new one is.
  await announce(ctx, added.app, (subject) =>
    catalogue.mcpAppAdded({ ...subject, kind: "remote" }),
  );

  const provider = added.provider;
  const capability = provider?.capability ?? null;
  const fresh = await gatewayProviders();
  let secret: string | null = null;
  let setupCommand: string | null = null;
  let connectPath: string | null = null;
  let ready = provider === null;
  if (provider && capability?.mode === "api_key") {
    secret = capabilitySettings(capability)[0] ?? null;
    ready = apiKeyReady(provider.id, capability, fresh);
    if (!ready) setupCommand = apiKeySetupCommand(capability);
  } else if (provider && capability?.mode === "oauth_client") {
    connectPath = remoteMcpConnectPath(provider.id, added.id);
  }
  let listing: Listing | null = null;
  if (ready) {
    listing = await listToolsWithin(syncable(added.app), ADD_LISTING_BUDGET_MS);
  }
  return {
    rowId: added.app.id,
    appId: added.id,
    name: added.app.name,
    kind: added.kind,
    authKind: added.remote.auth.kind,
    credentialKind,
    provider: provider?.id ?? null,
    secret,
    setupCommand,
    connectPath,
    oauth: client && issuer ? { issuer, registered: client.registered } : null,
    toolCount: listing ? listing.toolCount : null,
    toolsStatus: listing ? listing.status : null,
  };
}

/**
 * Change a remote MCP app in place (the risk default, the per-tool
 * overrides, the name or the description), its revision bumped so the
 * Gateway lists the tools again on first use. The URL and the auth never
 * change here: a server elsewhere is another app.
 */
async function update(
  ctx: OrgContext,
  input: UpdateRemoteMcpAppInput,
): Promise<{ remote: RemoteMcpBlock; name: string; description: string }> {
  assertAdmin(ctx);
  const row = await findRemoteRow(ctx, input.id);
  const change: RemoteMcpChange = {};
  if (input.risk !== undefined) change.risk = input.risk;
  if (input.tools !== undefined) change.tools = input.tools;
  if (input.tool !== undefined) change.tool = input.tool;
  if (input.name !== undefined) change.name = input.name;
  if (input.description !== undefined) change.description = input.description;
  let next;
  try {
    next = remoteMcpAppUpdate(registryRow(row), change);
  } catch (error) {
    throw asPublicError(error);
  }
  await McpAppRepository.updateRemoteApp(row.id, ctx.orgId, {
    manifest: next.manifest,
    name: next.name,
    description: next.description,
  });
  const subject = { id: row.appSlug, rowId: row.id, name: next.name };
  if (change.tool) {
    const override = next.remote.tools[change.tool.name] ?? null;
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.mcpAppToolChanged({
        app: subject,
        kind: "remote",
        tool: change.tool!.name,
        risk: override?.risk,
        enabled: override?.enabled,
        cleared: override === null ? true : undefined,
      }),
    }));
  }
  const changed = (
    [
      ["risk", change.risk !== undefined],
      ["tools", change.tools !== undefined],
      ["name", change.name !== undefined && next.name !== row.name],
      [
        "description",
        change.description !== undefined &&
          next.description !== row.description,
      ],
    ] as const
  )
    .filter(([, did]) => did)
    .map(([field]) => field);
  if (changed.length > 0) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.mcpAppUpdated({
        app: subject,
        kind: "remote",
        changed,
        risk: changed.includes("risk") ? next.remote.risk : undefined,
      }),
    }));
  }
  return {
    remote: next.remote,
    name: next.name,
    description: next.description,
  };
}

/**
 * Turn an MCP app of either kind on (`active`: served) or off
 * (`disabled`: access, tokens and the snapshot kept, nothing served).
 */
async function setStatus(
  ctx: OrgContext,
  input: { id: string; status: "active" | "disabled" },
): Promise<{ status: "active" | "disabled"; changed: boolean }> {
  assertAdmin(ctx);
  const row = await findMcpRow(ctx, input.id);
  let change;
  try {
    change = mcpAppStatusUpdate(registryRow(row), input.status);
  } catch (error) {
    throw asPublicError(error);
  }
  if (change) {
    const { status } = change;
    await McpAppRepository.setStatus(row.id, ctx.orgId, status);
    const kind = kindOf(row);
    await announce(ctx, row, (subject) =>
      status === "active"
        ? catalogue.mcpAppEnabled({ ...subject, kind })
        : catalogue.mcpAppDisabled({ ...subject, kind }),
    );
  }
  return { status: input.status, changed: change !== null };
}

/**
 * Remove an MCP app of either kind: the tombstone, with everyone's
 * access, its tokens, its snapshot and its place in AI connections. The
 * provider row and the key or client it holds stay on the Gateway
 * (`provider remove` and `secret unset` clean up).
 */
async function remove(ctx: OrgContext, input: { id: string }): Promise<void> {
  assertAdmin(ctx);
  const row = await AppRepository.findById(input.id, ctx.orgId);
  if (!row || !mcpAppRemoveUpdate(registryRow(row))) throw notFound();
  await AppRepository.tombstone(row);
  const kind = kindOf(row);
  await announce(ctx, row, (subject) =>
    catalogue.mcpAppRemoved({ ...subject, kind }),
  );
}

/**
 * List an MCP app's tools again now: the snapshot dropped, the listing
 * taken within the request, and what changed against the last one.
 */
async function refreshTools(
  ctx: OrgContext,
  input: { id: string },
): Promise<RefreshedMcpAppTools> {
  assertAdmin(ctx);
  const row = await findMcpRow(ctx, input.id);
  const listed = (names: string[]) =>
    names.map((name) => `${row.appSlug}_${name}`);
  const previousNames = await AppToolRepository.toolNames(row.id, ctx.orgId);
  const before = new Set(listed(previousNames));
  await AppToolRepository.deleteSnapshot(row.id, ctx.orgId);
  // The names the dropped snapshot held: a refresh that lists the same
  // tools is no app.tools_changed.
  const listing = await listToolsWithin(
    syncable(row),
    REFRESH_LISTING_BUDGET_MS,
    previousNames,
  );
  const after = listed(await AppToolRepository.toolNames(row.id, ctx.orgId));
  const afterSet = new Set(after);
  return {
    status: listing?.status ?? null,
    toolCount: after.length,
    added: after.filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !afterSet.has(name)).sort(),
    error:
      listing === null
        ? "The Gateway couldn't list its tools just now; it tries again on first use."
        : listing.error,
  };
}

function riskHintOf(value: string): RemoteToolRiskHint {
  return isToolRisk(value) || value === "destructive" ? value : "unknown";
}

/** The hints a stored risk hint stands for, as remoteToolRisk reads them. */
function hintsOf(hint: RemoteToolRiskHint) {
  if (hint === "read") return { readOnlyHint: true };
  if (hint === "destructive") return { destructiveHint: true };
  return undefined;
}

/**
 * Whether the snapshot was taken from the block as it stands: its version
 * is the block's revision (`remote:<rev>`, the design's section 2), so the
 * risks it serves are the block's.
 */
function snapshotIsCurrent(
  versionId: string | null | undefined,
  block: RemoteMcpBlock,
): boolean {
  if (!versionId) return false;
  const prefix = `remote:${block.rev}`;
  return versionId === prefix || versionId.startsWith(`${prefix}:`);
}

const NO_CREDENTIAL: McpAppCredential = {
  kind: "none",
  provider: null,
  providerName: null,
  own: false,
  name: null,
  set: false,
  state: "none",
  connections: 0,
  connectPath: null,
  viewer: null,
};

/**
 * Where a remote app's credential stands, for `ctx`'s member: its
 * provider, an API key's setting and whether it is set and bound, an
 * OAuth provider's client, how many members have connected it in the app
 * and the member's own connection. Never a value or a token.
 */
async function credentialOf(
  ctx: OrgContext,
  block: RemoteMcpBlock,
  appSlug: string,
): Promise<McpAppCredential> {
  if (block.auth.kind === "none") return NO_CREDENTIAL;
  const providerId = block.auth.provider;
  const registry = await gatewayProviders();
  const capability = registry.get(providerId);
  const hosts = capability
    ? remoteMcpProviderHosts(capability, settings() as CapabilitySettings)
    : null;
  const own = isRemoteMcpProviderIdOf(providerId, appSlug);
  const named = {
    provider: providerId,
    providerName:
      capability && capability.mode !== "service"
        ? capability.label
        : providerId,
    own,
  };
  if (!capability || !hosts) {
    return {
      ...NO_CREDENTIAL,
      kind: capability?.mode === "oauth_client" ? "oauth" : "api_key",
      ...named,
      state: "missing",
    };
  }
  if (capability.mode === "api_key") {
    const names = capabilitySettings(capability);
    const set = names.every((name) => isSet(name));
    return {
      ...NO_CREDENTIAL,
      kind: "api_key",
      ...named,
      name: names[0] ?? null,
      set,
      state: !set
        ? "not_set"
        : registry.bound(providerId)
          ? "ready"
          : "bound_elsewhere",
    };
  }
  if (capability.mode !== "oauth_client") {
    return { ...NO_CREDENTIAL, kind: "api_key", ...named, state: "missing" };
  }
  const [client, connections, row] = await Promise.all([
    resolveOAuthClient({
      id: providerId,
      capability,
      env: env as never,
      lookup: registry,
    }),
    ProviderConnectionRepository.listByOrganization(ctx.orgId),
    AppRepository.findByAppSlug(appSlug, ctx.orgId),
  ]);
  // The app's own connections: each member's, made in this app.
  const ofApp = connections.filter(
    (connection) =>
      connection.providerId === providerId && connection.appRowId === row?.id,
  );
  const active = ofApp.filter((connection) => connection.status === "active");
  const mine = ofApp.find((connection) => connection.userId === ctx.userId);
  return {
    ...NO_CREDENTIAL,
    kind: "oauth",
    ...named,
    state: !client
      ? "no_client"
      : active.length > 0
        ? "connected"
        : "not_connected",
    connections: active.length,
    connectPath: remoteMcpConnectPath(providerId, appSlug),
    viewer: mine ? { status: mine.status, label: mine.label } : null,
  };
}

/** The command that sets a credential that needs setting: an API key's `secret set`. */
async function credentialSetupCommand(
  block: RemoteMcpBlock,
  credential: McpAppCredential,
): Promise<string | null> {
  if (
    credential.kind !== "api_key" ||
    (credential.state !== "not_set" && credential.state !== "bound_elsewhere")
  ) {
    return null;
  }
  if (block.auth.kind !== "provider") return null;
  const capability = (await gatewayProviders()).get(block.auth.provider);
  return capability ? apiKeySetupCommand(capability) : null;
}

/**
 * For any member: whether an OAuth MCP app is connected for them (their
 * own connection, made in the app) and where they connect it. Null for a built-in, a removed app, or an app
 * whose credential isn't an OAuth provider. Never a token.
 */
async function connection(
  ctx: OrgContext,
  input: { appId: string },
): Promise<McpAppConnectionStatus | null> {
  const row = await AppRepository.findByAppSlug(input.appId, ctx.orgId);
  if (!row || row.status === DELETED_APP_STATUS) return null;
  const block = remoteMcpBlockOf(row);
  if (!block || block.auth.kind !== "provider") return null;
  const providerId = block.auth.provider;
  const capability = (await gatewayProviders()).get(providerId);
  if (capability?.mode !== "oauth_client") return null;
  const found = await ProviderConnectionRepository.find({
    organizationId: ctx.orgId,
    providerId,
    userId: ctx.userId,
    appRowId: row.id,
  });
  return {
    providerName: capability.label,
    connectPath: remoteMcpConnectPath(providerId, row.appSlug),
    connection: found ? { status: found.status, label: found.label } : null,
  };
}

/**
 * An MCP app as its dialog shows it: the row, the stored block, the
 * credential's state, the snapshot, and every tool the server listed with
 * its listed name, its risk and where that risk comes from (an override,
 * the app's default, the server's hint, or the fallback), on or off, and
 * why it isn't listed. An override for a tool the server no longer lists
 * is shown too, so it can be cleared.
 */
async function get(
  ctx: OrgContext,
  input: { id: string },
): Promise<McpAppDetails> {
  assertAdmin(ctx);
  const row = await findMcpRow(ctx, input.id);
  const block = remoteMcpBlockOf(row);
  const catalog = await AppToolRepository.findCatalog(row.id, ctx.orgId);
  const snapshot: McpAppSnapshot = {
    status: catalog?.status ?? null,
    fetchedAt: catalog?.fetchedAt ?? null,
    lastError: catalog?.lastError ?? null,
    toolCount: catalog?.toolCount ?? 0,
  };
  const status = row.status === "active" ? "active" : "disabled";
  if (!block) {
    return {
      id: row.id,
      appId: row.appSlug,
      name: row.name,
      description: row.description,
      status,
      kind: kindOf(row),
      remote: null,
      origin: null,
      authKind: null,
      authLabel: null,
      credential: null,
      setupCommand: null,
      snapshot,
      tools: [],
    };
  }
  const [credential, rows] = await Promise.all([
    credentialOf(ctx, block, row.appSlug),
    McpAppRepository.findListedTools(row.id, ctx.orgId),
  ]);
  const current = snapshotIsCurrent(catalog?.versionId, block);
  const tools: McpAppTool[] = rows.map((tool) => {
    const riskHint = riskHintOf(tool.riskHint);
    const decided = remoteToolRisk(hintsOf(riskHint), block, tool.upstreamName);
    const served =
      current && tool.listed && tool.servedRisk && isToolRisk(tool.servedRisk)
        ? (tool.servedRisk as ToolRisk)
        : null;
    return {
      upstreamName: tool.upstreamName,
      localName: tool.localName,
      listedName: tool.localName ? `${row.appSlug}_${tool.localName}` : null,
      title: tool.title ?? tool.servedTitle ?? null,
      riskHint,
      risk: served ?? decided.risk,
      source: decided.source,
      enabled: remoteToolEnabled(block, tool.upstreamName),
      listed: tool.listed,
      problem: tool.problem,
    };
  });
  const seen = new Set(rows.map((tool) => tool.upstreamName));
  for (const upstreamName of Object.keys(block.tools).sort()) {
    if (seen.has(upstreamName)) continue;
    const decided = remoteToolRisk(undefined, block, upstreamName);
    tools.push({
      upstreamName,
      localName: null,
      listedName: null,
      title: null,
      riskHint: "unknown",
      risk: decided.risk,
      source: decided.source,
      enabled: remoteToolEnabled(block, upstreamName),
      listed: false,
      problem:
        rows.length > 0 ? "The server doesn't list it now." : "Not listed yet.",
    });
  }
  let origin: string | null = null;
  try {
    origin = new URL(block.url).origin;
  } catch {
    origin = null;
  }
  return {
    id: row.id,
    appId: row.appSlug,
    name: row.name,
    description: row.description,
    status,
    kind: "remote",
    remote: block,
    origin,
    authKind: block.auth.kind,
    authLabel: remoteMcpAuthLabel(
      block.auth,
      block.auth.kind === "provider"
        ? (await gatewayProviders()).get(block.auth.provider)
        : undefined,
    ),
    credential,
    setupCommand: await credentialSetupCommand(block, credential),
    snapshot,
    tools,
  };
}

export const McpAppService = {
  add,
  update,
  setStatus,
  remove,
  refreshTools,
  get,
  connection,
} as const;
