/**
 * The gateway's own `${GATEWAY_URL}/mcp`: one MCP server for every app a
 * caller may use, under `<appId>_<tool>` names, plus the built-in
 * `everyapp_*` tools.
 *
 * The caller is already resolved (mcp-auth/validate.ts, or for a
 * Cloudflare Access assertion mcp-auth/access-caller.ts): an OAuth
 * connection, a personal access token, or the person Access vouches for.
 * This serves, from the catalogs in D1, the apps the caller reaches: active
 * apps of their organization they have access to and, on the hosted
 * gateway, the shared apps, narrowed to the connection's chosen apps or the
 * token's app. `tools/call` reaches exactly one app over its service
 * binding, with an identity minted for that call. An app that needs setup
 * (a required setting of its manifest isn't set: server/app-setup.ts)
 * serves no tools here, as its host serves nothing; the instructions and
 * `everyapp_list_apps` name it, with the command that opens it when the
 * app is the caller's organization's own (a shared app seen from another
 * organization is the platform's to fix), so a connected client can tell
 * its user.
 *
 * /mcp keeps nothing between requests, so the tools are fetched before the
 * answer, never after it. The snapshots are normally taken when an app is
 * activated or deployed; an app a client uses (a POST) that has none yet,
 * or one from another version than the app runs, is synced within the
 * request, up to a few seconds, and what finished is in the answer. One
 * whose last sync failed is retried in the background after five minutes,
 * so a broken app never slows a request. A connected client still learns
 * of a changed list (an app added, removed or redeployed): the ToolBus
 * compares each 2025-era request's session with the list, and holds a
 * 2026-07-28 `subscriptions/listen` stream that re-reads the catalogs
 * through the view's `refresh` (see packages/toolbus/src/http.ts).
 *
 * How `tools/list` presents the apps' tools is the view's `listing`
 * (packages/toolbus/src/view.ts): every tool under its own name, or
 * compactly (the built-ins only, with `everyapp_search_tools` and the
 * `everyapp_call_read` / `everyapp_call_write` wrappers) once a full
 * listing would grow past what clients that load every tool take. A caller
 * of any kind chooses for itself with `X-EveryApp-Tools: full|compact` or
 * `?tools=full|compact` ({@link listingChoice}); the choice is read once
 * from the request and carried by the view's `refresh`, so a held stream
 * re-reads in the mode it was opened in.
 */
import { env } from "cloudflare:workers";
import { extractBearerCredential, logEvent } from "@every-app/perimeter";
import { parseSecretNames } from "@every-app/perimeter/registry";
import {
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  PROVIDER_APP_IDS,
  PROVIDER_APP_TIER,
  PROVIDER_APPS,
  providerAppKeySetting,
  type AppSetup,
} from "@every-app/sdk/internal";
import {
  ViewRefusedError,
  isOwnerOrAdmin,
  type McpPrincipal,
  type OfferedApp,
  type ToolBusApp,
  type ToolBusView,
  type UnavailableApp,
} from "@every-app/toolbus";
import { appSetupFor, parsedManifest, SETUP_CLI } from "@/server/app-setup";
import { platformPolicy } from "@/server/platform-policy";
import {
  providerAudience,
  providerBaseUrl,
  providerCatalogVersion,
} from "@/server/provider-apps";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { resolveAccessCaller } from "@/server/mcp-auth/access-caller";
import {
  resolveOauthCaller,
  resolvePatCaller,
  type McpCaller,
} from "@/server/mcp-auth/validate";
import {
  INLINE_SYNCS_MAX,
  RETRY_FAILED_MCP_SYNC_MS,
  RETRY_FAILED_SYNC_MS,
  syncUnsyncedCatalogs,
} from "./catalog-sync";
import { registersProviders, servedApp, toolBusHttp } from "./runtime";

/**
 * Browser origins allowed to call the gateway's /mcp besides its own:
 * MCP_ALLOWED_ORIGINS, comma or space separated (e.g. MCP Inspector's
 * `http://localhost:6274`). Empty by default; AI apps call from servers.
 */
function allowedOrigins(): string[] {
  return (env.MCP_ALLOWED_ORIGINS ?? "").split(/[\s,]+/).flatMap((value) => {
    if (!value) return [];
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? [url.origin.toLowerCase()]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Whether a browser's `Origin` may call the gateway's `/mcp`: none (a
 * server), the gateway's own, or one of MCP_ALLOWED_ORIGINS. The ToolBus
 * applies the same rule to every request (packages/toolbus/src/http.ts);
 * the Access path applies it first, before anything is verified or read
 * for the person, since Access vouches for a browser's cookie too.
 */
export function browserOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (origin === new URL(request.url).origin) return true;
  return allowedOrigins().includes(origin.toLowerCase());
}

type RefusedCaller = Extract<McpCaller, { kind: "refused" }>;

/** The request header that chooses how the gateway's /mcp lists tools. */
const LISTING_HEADER = "x-everyapp-tools";
/** The /mcp query parameter that chooses the same. */
const LISTING_QUERY_PARAM = "tools";

type Listing = NonNullable<ToolBusView["listing"]>;

function parseListing(value: string | null): Listing | undefined {
  const choice = value?.trim().toLowerCase();
  return choice === "full" || choice === "compact" ? choice : undefined;
}

/**
 * The caller's explicit choice of how `tools/list` presents the apps'
 * tools, for any kind of caller: `X-EveryApp-Tools: full|compact` or
 * `?tools=full|compact` on `/mcp`, case-insensitive, the header first when
 * both are given. Anything else is no choice, and the view decides from
 * the size of the full listing (`gatewaySurfaceView`). A query string
 * leaves the protected resource what it is: the routers match the path,
 * `/mcp`, and the OAuth resource server hands the request on as it came.
 */
export function listingChoice(request: Request): Listing | undefined {
  return (
    parseListing(request.headers.get(LISTING_HEADER)) ??
    parseListing(new URL(request.url).searchParams.get(LISTING_QUERY_PARAM))
  );
}

/**
 * What an AI app can show its user for a refusal it can do something about:
 * the Access path has no consent page or token to explain it, so the 403
 * body says what to do.
 */
function refusalMessage(reason: RefusedCaller["reason"]): string | null {
  switch (reason) {
    case "not_connected":
      return `No Every App account is connected to this Cloudflare Access identity. Open ${env.GATEWAY_URL?.trim() || "the gateway"} in your browser, sign in once, then connect again.`;
    case "account_deactivated":
      return "This account has been deactivated.";
    case "organization_unresolved":
      return "You belong to several organizations here. Open the gateway in your browser and pick one first.";
    default:
      return null;
  }
}

interface ServeGatewayMcpOptions {
  /**
   * When the credential that authenticated this request expires, in
   * seconds since the epoch (an OAuth access token's, an Access
   * assertion's): a held `subscriptions/listen` stream ends no later than
   * that, so it never outlives the token that opened it. A personal token
   * needs none: each poll resolves it again, expiry included.
   */
  credentialExpiresAt?: number | undefined;
}

export async function serveGatewayMcp(
  request: Request,
  caller: McpCaller,
  options: ServeGatewayMcpOptions = {},
): Promise<Response> {
  if (caller.kind === "refused") {
    const message = refusalMessage(caller.reason);
    return Response.json(
      {
        error: "forbidden",
        reason: caller.reason,
        ...(message ? { message } : {}),
      },
      { status: 403 },
    );
  }
  // A credential narrowed to apps (a personal token bound to one app, a
  // connection consented to "Only these apps") reaches those apps' tools
  // and nothing of the workspace's: the ToolBus hides every workspace tool
  // from it (policy.ts, reason app_scoped_credential), whatever the
  // person's role, so a crm-only token handed to a CI job cannot invite,
  // deactivate or regrant.
  const principal: McpPrincipal = {
    ...caller.principal,
    appScope:
      caller.apps.appRowId !== undefined ||
      caller.apps.connectionId !== undefined
        ? "selected"
        : "all",
  };
  const scope = {
    organizationId: principal.organizationId,
    userId: principal.userId,
    sharedApps: platformPolicy(env).sharedApps,
    ...caller.apps,
  };

  if (request.method === "POST") {
    await syncUnsyncedApps(scope);
  }

  let view: ToolBusView;
  try {
    view = await gatewayView({
      requestId: request.headers.get("cf-ray") ?? undefined,
      principal,
      scope,
      recheck: recheckFor(request, caller),
      credentialExpiresAt: options.credentialExpiresAt,
      listing: listingChoice(request),
    });
  } catch (error) {
    logEvent(
      "mcp.catalog.unavailable",
      {
        surface: "gateway",
        org: principal.organizationId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "The tool catalog is unavailable." },
        id: null,
      },
      { status: 503 },
    );
  }

  const serve = await toolBusHttp();
  return serve(request, view);
}

/**
 * Whether the caller still stands, for a held stream's polls: a revoked
 * connection, a removed or deactivated member, a suspended organization or
 * a revoked token takes effect on the next request, and a poll is one.
 * Throws `ViewRefusedError` when it doesn't, which ends the stream at that
 * poll; any other failure (the row can't be read just now) leaves the
 * stream open, pushing nothing, for up to three polls. A poll is no use of
 * the credential, so it leaves last-used alone.
 */
function recheckFor(request: Request, caller: McpCaller): () => Promise<void> {
  if (caller.kind !== "caller") return async () => undefined;
  const { principal } = caller;
  const refused = () => {
    throw new ViewRefusedError("the caller no longer stands");
  };
  if (principal.credential.kind === "access") {
    // The same person, in the same organization: deactivated, removed, or
    // suspended ends the stream; so does a browser that moved to another
    // organization since (the next request acts there).
    const email = principal.credential.id;
    return async () => {
      const again = await resolveAccessCaller(email);
      if (
        again.kind !== "caller" ||
        again.principal.userId !== principal.userId ||
        again.principal.organizationId !== principal.organizationId
      ) {
        refused();
      }
    };
  }
  if (principal.credential.kind === "oauth") {
    const props = {
      v: 1,
      kind: "oauth",
      connectionId: principal.credential.id,
      userId: principal.userId,
      organizationId: principal.organizationId,
    };
    const scope =
      principal.access === "write"
        ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE]
        : [MCP_READ_SCOPE];
    return async () => {
      const again = await resolveOauthCaller(props, scope, { touch: false });
      if (!again || again === "insufficient_scope" || again.kind !== "caller") {
        refused();
      }
    };
  }
  const token = extractBearerCredential(request.headers);
  if (token?.startsWith("epat_")) {
    return async () => {
      const again = await resolvePatCaller(token, { touch: false });
      if (!again || again.kind !== "caller") refused();
    };
  }
  return async () => undefined;
}

/**
 * Why an app serves no tools, for its user: the one command that opens it,
 * or plain "needs setup" for a caller who can't run it (`canFix`: a shared
 * app seen from another organization is the platform's to fix).
 */
function needsSetupReason(setup: AppSetup): string {
  if (!setup.command) return "needs setup";
  return `needs setup: an admin runs ${setup.command.command}`;
}

/**
 * The provider apps an owner or admin of the install organization could
 * turn on (docs/design/2026-10-proactive-next-steps.md, rule 2): the
 * gateway holds the provider's key (its setting is set in env) and the
 * install organization has no row for the app. Decided from the rows,
 * never from the caller's view: a grant they lack, a connection that chose
 * other apps, a token bound to one app or a failed catalog sync keeps an
 * app out of `known` (the catalogs read for this view) while it is on, and
 * nobody is told to turn on what is on; `known` only short-circuits, since
 * an app the caller sees has its row. Not offered either while a deployed
 * app of the organization lists the provider's capability (OpenSEO lists
 * `dataforseo`): the key is that app's, and the line would never go. A
 * member sees nothing, since it is operator state; another organization's
 * owner neither, since `mcp on` writes the install organization's row
 * (ADR-0003). Nothing is read until the state is there: the role and env
 * are free, and the two reads (the install organization, its rows) run
 * only while a key is set and the caller's view lacks its app.
 */
async function offeredProviderApps(
  principal: McpPrincipal,
  known: ReadonlySet<string>,
): Promise<OfferedApp[]> {
  if (!isOwnerOrAdmin(principal.orgRole)) return [];
  const settings = env as unknown as Readonly<Record<string, unknown>>;
  const isSet = (value: unknown) =>
    typeof value === "string" ? value.trim().length > 0 : Boolean(value);
  const candidates = PROVIDER_APP_IDS.filter(
    (id) => !known.has(id) && isSet(settings[providerAppKeySetting(id)]),
  );
  if (candidates.length === 0) return [];
  const install = await OrganizationRepository.findInstallOrganizationId();
  if (install !== principal.organizationId) return [];
  const rows = await AppRepository.findSlugsAndManifests(install);
  const off = candidates.filter(
    (id) =>
      !rows.some((row) => row.appSlug === id) &&
      !rows.some(
        (row) =>
          row.tier !== PROVIDER_APP_TIER &&
          manifestListsCapability(row.manifest, PROVIDER_APPS[id].capability),
      ),
  );
  return off.map((id) => ({
    appId: id,
    name: PROVIDER_APPS[id].name,
    command: `${SETUP_CLI} mcp on ${id}`,
  }));
}

/** Whether a stored manifest lists `capability` under `capabilities`. */
function manifestListsCapability(
  manifest: unknown,
  capability: string,
): boolean {
  const capabilities = parsedManifest(manifest)?.["capabilities"];
  return (
    typeof capabilities === "object" &&
    capabilities !== null &&
    Object.hasOwn(capabilities, capability)
  );
}

interface GatewayViewInput {
  requestId: string | undefined;
  principal: McpPrincipal;
  scope: Parameters<typeof AppToolRepository.findVisibleCatalogs>[0];
  recheck: () => Promise<void>;
  credentialExpiresAt: number | undefined;
  /** The caller's explicit listing choice ({@link listingChoice}), if any. */
  listing: Listing | undefined;
}

/**
 * The caller's view of the catalogs as they are now. A held
 * `subscriptions/listen` stream re-reads it through `refresh` (after the
 * caller is rechecked), so an app that appears, goes or is redeployed
 * reaches the connected client, and a caller that lost access stops
 * hearing about them. Captures no Request: a stream lives up to half an
 * hour, and no longer than the credential that opened it. What was read
 * from the request (the id, the listing choice) is carried as values, so
 * every re-read is the same caller's view in the same mode.
 */
async function gatewayView(input: GatewayViewInput): Promise<ToolBusView> {
  const { principal, scope, requestId, listing, credentialExpiresAt } = input;
  const catalogs = await AppToolRepository.findVisibleCatalogs(scope);
  // Each app's setup, read together: one cached report per row, version
  // and recorded names (app-setup.ts), so this costs nothing per request.
  const setups = await Promise.all(
    catalogs.map((catalog) =>
      appSetupFor({
        rowId: catalog.appRowId,
        versionId: catalog.versionId,
        secretNames: parseSecretNames(catalog.secretNames),
        appId: catalog.appSlug,
        tier: catalog.tier,
        manifest: catalog.manifest,
        // The command is for the app's own organization; a shared app seen
        // from another is named without one, as the app lists do.
        canFix: catalog.organizationId === principal.organizationId,
      }),
    ),
  );
  const apps: ToolBusApp[] = [];
  const unavailable: UnavailableApp[] = [];
  catalogs.forEach((catalog, index) => {
    const setup = setups[index];
    if (setup && !setup.ready) {
      unavailable.push({
        appId: catalog.appSlug,
        name: catalog.name,
        reason: needsSetupReason(setup),
      });
      return;
    }
    apps.push(
      servedApp(
        {
          rowId: catalog.appRowId,
          appId: catalog.appSlug,
          // A provider app's identities are minted for its row, never a
          // Worker name, and its tools live on the gateway itself.
          audience:
            catalog.tier === PROVIDER_APP_TIER
              ? providerAudience(catalog.appRowId)
              : (catalog.workerName ?? ""),
          name: catalog.name,
          ...(catalog.description ? { description: catalog.description } : {}),
          baseUrl:
            catalog.tier === PROVIDER_APP_TIER
              ? providerBaseUrl()
              : `https://${catalog.hostname ?? ""}`,
          catalogHash: catalog.catalogHash,
          ...(catalog.instructions
            ? { instructions: catalog.instructions }
            : {}),
          tools: catalog.tools,
        },
        {
          // The app row's own organization, where its catalog is kept; the
          // call's identity carries the caller's (principal).
          rowId: catalog.appRowId,
          organizationId: catalog.organizationId,
          appSlug: catalog.appSlug,
          hostname: catalog.hostname,
          workerName: catalog.workerName,
          tier: catalog.tier,
          versionId: catalog.versionId,
          manifest: catalog.manifest,
          name: catalog.name,
        },
      ),
    );
  });

  // An MCP app with no serving snapshot (a remote server that couldn't be
  // listed: its credential unset or bound elsewhere, or the server down)
  // has no page where its user would learn why: it is named here.
  const unserved = await AppToolRepository.findVisibleUnservedMcpApps(scope);
  for (const app of unserved) {
    const setup = await appSetupFor({
      rowId: app.appRowId,
      versionId: app.versionId,
      secretNames: parseSecretNames(app.secretNames),
      appId: app.appSlug,
      tier: app.tier,
      manifest: app.manifest,
      canFix: app.organizationId === principal.organizationId,
    });
    unavailable.push({
      appId: app.appSlug,
      name: app.name,
      reason:
        setup && !setup.ready
          ? needsSetupReason(setup)
          : app.catalogStatus === "empty"
            ? "its server lists no tools"
            : app.lastError
              ? `its tools couldn't be listed: ${app.lastError}`
              : "its tools are being listed; list tools again in a moment",
    });
  }

  const offered = await offeredProviderApps(
    principal,
    new Set(catalogs.map((catalog) => catalog.appSlug)),
  );

  const { gatewaySurfaceView } = await import("@every-app/toolbus");
  return {
    ...gatewaySurfaceView(principal, apps, {
      ...(requestId ? { requestId } : {}),
      allowedOrigins: allowedOrigins(),
      unavailable,
      offered,
      // The caller's own choice; without one the view decides from the
      // size of the full listing (the workspace tools this gateway lists
      // the caller counted), on this read and on every re-read.
      ...(listing ? { listing } : {}),
      workspace: true,
      providers: registersProviders(),
    }),
    refresh: async () => {
      await input.recheck();
      return gatewayView(input);
    },
    ...(credentialExpiresAt !== undefined
      ? { listenUntil: credentialExpiresAt * 1000 }
      : {}),
  };
}

/**
 * Sync the reachable apps whose tools aren't snapshotted, before the
 * catalogs are read: those with no snapshot, or one from another version,
 * within the request's budget; those whose last sync failed in the
 * background. Never fails the request: a sync it misses happens on a later
 * one.
 */
async function syncUnsyncedApps(
  scope: Parameters<typeof AppToolRepository.findVisibleUnsyncedApps>[0],
): Promise<void> {
  try {
    const unsynced = await AppToolRepository.findVisibleUnsyncedApps(scope, {
      failedBefore: new Date(Date.now() - RETRY_FAILED_SYNC_MS),
      mcpFailedBefore: new Date(Date.now() - RETRY_FAILED_MCP_SYNC_MS),
      limit: INLINE_SYNCS_MAX,
      providerCatalogVersion: await providerCatalogVersion(),
    });
    await syncUnsyncedCatalogs(unsynced, "first_use");
  } catch (error) {
    logEvent(
      "mcp.catalog.unavailable",
      {
        surface: "gateway",
        org: scope.organizationId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
  }
}
