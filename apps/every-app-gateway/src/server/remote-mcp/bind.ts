/**
 * A remote MCP app's credential, and whose it is
 * (docs/design/2026-11-mcp-apps-auth.md, phases 2 and 3). The block names
 * a provider of the registry, or none:
 *
 * - an API-key provider (a catalog entry such as `elevenlabs`, a
 *   registered row, or the app's own `<appId>-mcp` row): one key the
 *   Gateway holds in its settings, read only while the row is bound to the
 *   hosts and auth it has now (`providers.value-bound-to-hosts`, the
 *   registry's `bound`), placed on the request as the provider's `auth`
 *   says (headers, or query parameters on the URL the client posts to);
 * - an OAuth provider with a Gateway-run flow: a member's connection to
 *   the provider, which they allowed this app to use at
 *   `/connect/<provider>?app=<app>`. A call uses the caller's own
 *   connection; a listing, which no one in particular makes, uses the one
 *   used most recently among those the app may use. The access token comes from the existing lease and refresh
 *   (oauth/tokens.ts `accessTokenFor`) and goes as `Authorization: Bearer`.
 *
 * Either way the credential goes only to a URL on one of the provider's
 * hosts: the row's URL is checked against them here, before every fetch,
 * so a row edited by hand can't point a key or a token anywhere else.
 *
 * Nothing here returns a value except as the headers and query the client
 * sends (and `secrets`, every form of it an error must never show), and
 * nothing logs one.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  authorizationFor,
  capabilitySettings,
  isRemoteMcpProviderIdOf,
  remoteMcpProviderHosts,
  remoteMcpUrlProblem,
  type ApiKeyCapability,
  type Capability,
  type CapabilitySettings,
  type OAuthClientCapability,
  type ProviderRegistry,
  type RemoteMcpBlock,
} from "@every-app/sdk/internal";
import { gatewayProviders } from "@/server/providers";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { SETUP_CLI } from "@/server/setup-cli";
import type { OAuthClientResolver } from "../oauth/client";
import type { Fetch } from "../oauth/tokens";

/** The registry facts about the row the credential is for. */
interface CredentialRoute {
  rowId: string;
  organizationId: string;
  appSlug: string;
  name?: string;
}

/** Who is calling: a member (a tool call), or no one (a listing). */
export type CredentialCaller = { id: string } | null;

export type CredentialState =
  /** `auth.kind: none`: nothing to send. */
  | { kind: "none" }
  /**
   * The credential to send: `headers` and `query` (parameters set on the
   * URL), `secrets` (every form of the value an error must never show),
   * and `key`, what tells one credential from another for the client
   * cache (whose it is and its value, in memory only).
   */
  | {
      kind: "ready";
      provider: string;
      headers: Record<string, string>;
      query: Record<string, string>;
      secrets: string[];
      key: string;
      /**
       * For an OAuth provider: whose connection it is, where to reconnect
       * it, and which write of its tokens this one is (`rejected`, when
       * the server answers 401 for it).
       */
      oauth?: {
        connectionId: string;
        connectUrl: string;
        label: string;
        version: number;
      };
    }
  /**
   * The member has no usable connection to the app's OAuth provider: a
   * call answers this as a tool error, never a protocol error.
   */
  | { kind: "connect"; message: string; connectUrl: string }
  /** Nothing can be sent for anyone: what the app lacks, in plain words. */
  | { kind: "needs_setup"; reason: string };

interface CredentialDeps {
  /** The token and refresh fetches (tests stand in for the provider). */
  fetchUpstream?: Fetch;
  resolveClient?: OAuthClientResolver;
  providers?: () => Promise<ProviderRegistry>;
  /**
   * The server answered 401 for this connection's token of this version
   * (a ready credential's `oauth`): refresh it, though it isn't due. Not
   * applied to another connection, which a listing may pick by now.
   */
  rejected?: { connectionId: string; version: number };
}

function settings(): CapabilitySettings & Record<string, unknown> {
  return env as unknown as CapabilitySettings & Record<string, unknown>;
}

function read(name: string): string | null {
  const value = settings()[name];
  return typeof value === "string" ? value : null;
}

function gatewayUrl(): string {
  return (read("GATEWAY_URL") ?? "").trim().replace(/\/+$/, "");
}

/**
 * Where a member connects the provider for a remote MCP app, a path on
 * the Gateway: back to Your connections → Accounts afterwards, which shows
 * the connection (an MCP app has no page to return to).
 */
export function remoteMcpConnectPath(
  provider: string,
  appSlug: string,
): string {
  return `/connect/${encodeURIComponent(provider)}?app=${encodeURIComponent(appSlug)}&return=${encodeURIComponent("/connections/accounts")}`;
}

/** The same, as a full URL for a message an AI client relays. */
function remoteMcpConnectUrl(provider: string, appSlug: string): string {
  return `${gatewayUrl()}${remoteMcpConnectPath(provider, appSlug)}`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** The connect sentence a call answers with. */
function connectMessage(label: string, url: string, again: boolean): string {
  return again
    ? `Reconnect your ${label} account to use this tool: ${url}`
    : `Connect your ${label} account to use this tool: ${url}`;
}

/** An API-key provider's credential: its key while set and bound, placed as its `auth` says. */
function apiKeyCredential(
  providerId: string,
  capability: ApiKeyCapability,
  registry: ProviderRegistry,
): CredentialState {
  const names = capabilitySettings(capability);
  const command = `${SETUP_CLI} secret set ${names.join(" ")}`;
  const values = settings();
  const auth = authorizationFor(capability, values);
  if (!auth) {
    return {
      kind: "needs_setup",
      reason: `its key isn't set for this server: its operator runs ${command}`,
    };
  }
  // A registered row's key is read only for the hosts and auth it was set
  // for: a row replaced since reads nothing until the key is set again.
  if (!registry.bound(providerId)) {
    return {
      kind: "needs_setup",
      reason: `its key was set for other hosts or another auth than ${providerId} has now: its operator runs ${command} again`,
    };
  }
  // Every form of the value an error could carry: each setting's raw value
  // and, for a user:password pair, each half.
  const secrets: string[] = [];
  for (const name of names) {
    const value = values[name];
    if (typeof value !== "string" || !value.trim()) continue;
    secrets.push(value, value.trim());
    const colon = value.indexOf(":");
    if (capability.auth.kind === "basic" && colon > 0) {
      secrets.push(value.slice(0, colon), value.slice(colon + 1));
    }
  }
  return {
    kind: "ready",
    provider: providerId,
    headers: auth.headers,
    query: auth.query,
    secrets: [...new Set(secrets.filter((part) => part.length > 0))],
    key: `key:${providerId}:${JSON.stringify([auth.headers, auth.query])}`,
  };
}

/** An OAuth provider's credential: the connection the caller (or the listing) uses. */
async function oauthCredential(
  providerId: string,
  capability: OAuthClientCapability,
  registry: ProviderRegistry,
  block: RemoteMcpBlock,
  route: CredentialRoute,
  caller: CredentialCaller,
  deps: CredentialDeps,
): Promise<CredentialState> {
  const label = capability.label;
  const connectUrl = remoteMcpConnectUrl(providerId, route.appSlug);
  // The OAuth side loads on first use, as the proxy's does: it reads D1
  // and the event bus, which a key-only or credential-less app never needs.
  const [{ resolveOAuthClient }, { gatewayHeldTokens }] = await Promise.all([
    import("../oauth/client"),
    import("../oauth/heldTokens"),
  ]);
  const client = await (deps.resolveClient ?? resolveOAuthClient)({
    id: providerId,
    capability,
    env: settings() as never,
    lookup: registry,
  });
  if (!client) {
    return {
      kind: "needs_setup",
      reason: `the Gateway holds no OAuth client for ${label}: add the server again, or an owner or admin adds a client under Manage workspace → Providers`,
    };
  }
  let connection: Awaited<
    ReturnType<typeof ProviderConnectionRepository.find>
  > = null;
  if (caller) {
    const owner = {
      organizationId: route.organizationId,
      providerId,
      userId: caller.id,
    };
    connection = await ProviderConnectionRepository.find(owner);
    // The caller's own connection, which they allowed this app to use.
    const allowed =
      connection !== null &&
      (await ProviderAppAccessRepository.find({
        ...owner,
        appRowId: route.rowId,
      })) !== null;
    if (!connection || !allowed || connection.status === "expired") {
      return {
        kind: "connect",
        message: connectMessage(label, connectUrl, allowed),
        connectUrl,
      };
    }
  } else {
    connection = await ProviderConnectionRepository.latestActiveForApp(
      route.organizationId,
      providerId,
      route.rowId,
    );
    if (!connection) {
      return {
        kind: "needs_setup",
        reason: `nobody has connected ${label} yet: a member connects at ${connectUrl}`,
      };
    }
  }
  const fetchUpstream: Fetch =
    deps.fetchUpstream ?? ((request) => fetch(request));
  const held = gatewayHeldTokens({ fetchUpstream });
  // A const keeps the narrowing (not null) inside the callbacks below.
  const heldConnection = connection;
  const token = await held.accessToken({
    connection: heldConnection,
    providerId,
    capability,
    client,
    organizationId: route.organizationId,
    ...(deps.rejected?.connectionId === connection.id
      ? { rejected: deps.rejected.version }
      : {}),
  });
  if (!token.ok) {
    if (token.reason === "reconnect" && token.first) {
      waitUntil(
        held
          .expired({
            connection: heldConnection,
            providerId,
            capability,
            organizationId: route.organizationId,
            appRowId: route.rowId,
          })
          .catch(() => undefined),
      );
    }
    logEvent(
      "mcp.remote.connection_unusable",
      {
        app: route.appSlug,
        appRowId: route.rowId,
        provider: providerId,
        reason: token.reason,
      },
      "warn",
    );
    // A refresh that failed for a passing reason (the provider was down,
    // or another call's refresh didn't land in time) leaves the connection
    // as it was: try again, not reconnect.
    const passing = token.reason === "retry";
    if (caller) {
      return {
        kind: "connect",
        message: passing
          ? `${label} could not refresh your connection's token; try again in a moment.`
          : connectMessage(label, connectUrl, true),
        connectUrl,
      };
    }
    return {
      kind: "needs_setup",
      reason: passing
        ? `${label} could not refresh the token of the connection it lists with; try again in a moment`
        : `the ${label} connection it lists with needs to be made again: connect at ${connectUrl}`,
    };
  }
  if (caller) {
    waitUntil(
      held
        .used({
          connection: heldConnection,
          providerId,
          capability,
          organizationId: route.organizationId,
          appId: route.appSlug,
          appRowId: route.rowId,
        })
        .catch(() => undefined),
    );
  }
  return {
    kind: "ready",
    provider: providerId,
    headers: { authorization: `Bearer ${token.accessToken}` },
    query: {},
    secrets: [token.accessToken],
    key: `oauth:${connection.id}:${token.accessToken}`,
    oauth: {
      connectionId: connection.id,
      connectUrl,
      label,
      version: token.version,
    },
  };
}

/**
 * The credential for a row's `remote` block, for `caller` (a member's
 * tool call) or for a listing (null): what to send, the connect sentence
 * a call answers with, or why nothing can be sent. Reads the Gateway's
 * env, the registry and the connection; writes only what a refresh and
 * `last_used_at` write.
 */
export async function credentialFor(
  block: RemoteMcpBlock,
  route: CredentialRoute,
  caller: CredentialCaller,
  deps: CredentialDeps = {},
): Promise<CredentialState> {
  if (block.auth.kind === "none") return { kind: "none" };
  const providerId = block.auth.provider;
  const registry = await (deps.providers ?? gatewayProviders)();
  const capability: Capability | undefined = registry.get(providerId);
  const hosts = capability
    ? remoteMcpProviderHosts(capability, settings())
    : null;
  if (!capability || !hosts) {
    return {
      kind: "needs_setup",
      reason: capability
        ? `${providerId} can't be an MCP server's credential: remove the app and add it again`
        : `its provider ${providerId} isn't on this Gateway: remove the app and add it again`,
    };
  }
  // The URL must be on one of the provider's hosts before anything is
  // read: a key or a token goes nowhere else.
  const host = hostOf(block.url);
  if (!host || !hosts.includes(host)) {
    logEvent(
      "mcp.remote.provider_host_mismatch",
      { app: route.appSlug, appRowId: route.rowId, provider: providerId, host },
      "warn",
    );
    return {
      kind: "needs_setup",
      reason: `${providerId} sends its credential to ${hosts.join(", ") || "no host"}, not to ${host ?? "this URL"}`,
    };
  }
  if (capability.mode === "api_key") {
    return apiKeyCredential(providerId, capability, registry);
  }
  if (capability.mode === "oauth_client") {
    return oauthCredential(
      providerId,
      capability,
      registry,
      block,
      route,
      caller,
      deps,
    );
  }
  return {
    kind: "needs_setup",
    reason: `${providerId} can't be an MCP server's credential: remove the app and add it again`,
  };
}

/**
 * Why a row's URL is refused by this Gateway's rules, checked before
 * anything is read or fetched; null when it isn't. A reserved host (one
 * whose key the Gateway holds for apps) is allowed only for an app that
 * names that host's provider, or whose own row is OAuth (each member's
 * own token goes, never the Gateway's key); never for an own static row.
 */
export async function urlRefusal(
  block: RemoteMcpBlock,
  appSlug: string,
  deps: Pick<CredentialDeps, "providers"> = {},
): Promise<string | null> {
  let providerHosts: string[] = [];
  if (block.auth.kind === "provider") {
    const registry = await (deps.providers ?? gatewayProviders)();
    const named = registry.get(block.auth.provider);
    const own = isRemoteMcpProviderIdOf(block.auth.provider, appSlug);
    if (named && (!own || named.mode === "oauth_client")) {
      providerHosts = remoteMcpProviderHosts(named, settings()) ?? [];
    }
  }
  const problem = remoteMcpUrlProblem(
    block.url,
    {
      gatewayUrl: read("GATEWAY_URL") ?? "",
      appBaseDomain: read("APP_BASE_DOMAIN"),
      thirdPartyDomain: read("THIRD_PARTY_DOMAIN"),
    },
    { providerHosts },
  );
  return problem ? `its address is refused by this Gateway (${problem})` : null;
}
