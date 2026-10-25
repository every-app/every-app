/**
 * Capability calls from apps (docs/capabilities.md). The AppGateway
 * entrypoint has already proven which app is calling; this checks the
 * app's registry row lists the capability, then dispatches on its kind:
 *
 *  - `api_key`: puts the gateway's key on the request and forwards it to
 *    the provider, so the app never sees the key;
 *  - `oauth_client`: completes a provider's token endpoint call with the
 *    gateway's OAuth client (capabilities/oauthClient.ts);
 *  - `service`: the gateway does the work itself (capabilities/email.ts,
 *    capabilities/members.ts).
 */
import {
  CATALOG,
  INTEGRATION_PROXY_PREFIX,
  MCP_WRITE_SCOPE,
  authorizationFor,
  declaredScopeSets,
  capabilitySettings,
  isAccountWidePath,
  parseIntegrationProxyPath,
  writeMethodsOf,
  type Capability,
  type CapabilityLookup,
  type CapabilitySecret,
  type EveryAppUser,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import {
  emailCapabilityStatus,
  handleEmailSend,
  loadGatewayMail,
  type GatewayMail,
} from "./capabilities/email";
import { forwardableHeaders } from "./capabilities/forward";
import {
  handleMembersList,
  membersCapabilityStatus,
  type ListAppMembers,
} from "./capabilities/members";
import { handleHeldTokenCall } from "./capabilities/heldToken";
import {
  handleOAuthClientCall,
  oauthClientStatus,
  type HeldConnectionStatus,
} from "./capabilities/oauthClient";
import type { OAuthClientResolver } from "./oauth/client";
import type { HeldTokenPort } from "./oauth/heldTokens";
import { capabilityRefusal as refusal } from "./capabilities/refusal";
import { platformPolicy } from "./platform-policy";
import { watchBody } from "./response-tap";

/**
 * The Gateway's settings by name, as the Worker env holds them: every
 * provider's key or client, the catalog's and the registered rows'. Named
 * by the catalog's settings for the type (a registered row's are read
 * through the same object as `CapabilitySettings`).
 */
export type IntegrationProxyEnv = Partial<Record<CapabilitySecret, string>> & {
  GATEWAY_DEPLOYMENT_MODE?: string;
};

/** Bytes of a response read for its top-level cost field (DataForSEO puts `cost` first). */
const COST_HEAD_BYTES = 2048;

/** Whom a call that will reach the provider is for, once admitted. */
export interface IntegrationCallAdmission {
  /** Who is calling, for the log line. */
  caller: {
    organizationId: string;
    appId: string;
    worker: string;
    orgSource: string;
  };
  /** The verified person behind the call, or null for background work. */
  user: EveryAppUser | null;
}

interface HandleIntegrationProxyRequestOptions {
  request: Request;
  /** The calling app's registry manifest `capabilities`. */
  capabilities: Record<string, CapabilityRequest> | undefined;
  /**
   * Where a capability id is found: the built-in catalog alone, or the
   * gateway's registry with its registered providers (server/providers).
   */
  lookup?: CapabilityLookup;
  /**
   * The `from` patterns stored for the calling app's installation
   * (`apps.email_senders`, RegisteredApp.emailSenders): what `email` lets it
   * send as. The manifest only declares that it sends. Absent: none.
   */
  emailSenders?: readonly string[];
  env: IntegrationProxyEnv;
  /**
   * Attribute a call the proxy would forward to its organization; throws to
   * refuse it. Status requests and calls the proxy refuses on its own never
   * reach it, so they need no organization.
   */
  admit: () => Promise<IntegrationCallAdmission>;
  fetchUpstream?: (request: Request) => Promise<Response>;
  /** The gateway's mail, for the `email` capability (loaded on first use). */
  mail?: () => Promise<GatewayMail>;
  /** The calling app's members, for the `members` capability. */
  listMembers: ListAppMembers;
  /**
   * Called once the moment a provider answered (its headers arrived),
   * before its body is forwarded: the call to count, whatever becomes of
   * the body (an app that stops reading is not heard in workerd, see
   * response-tap.ts). Never on a refusal, and not for the gateway's own
   * services (email, members).
   */
  onCall?: (report: IntegrationCallReport) => void;
  /**
   * Called once when a provider's body reported a cost (DataForSEO's
   * `cost`), to add to the call already reported through `onCall`. Reaches
   * the gateway when the head of the body was read, or the body to its end.
   */
  onCost?: (report: IntegrationCostReport) => void;
  /**
   * The Gateway-owned OAuth flow's side of the proxy
   * (docs/design/2026-10-oauth-providers.md section 7): where a client
   * beyond the Worker env comes from, the connections a held-token call
   * reads, and who is behind a status request (so it can report their
   * connection). Absent: the token-endpoint branch alone, on the env's
   * clients, as before.
   */
  oauth?: OAuthProxyDeps;
}

export interface OAuthProxyDeps {
  resolveClient: OAuthClientResolver;
  connections: HeldTokenPort;
  /**
   * Whom a status request is for, without admitting a call: the
   * organization and the person (null for background work), or null when
   * the request carries no usable attribution.
   */
  identify: () => Promise<{
    organizationId: string;
    user: EveryAppUser | null;
  } | null>;
}

interface IntegrationCallReport {
  capability: string;
  status: number;
}

interface IntegrationCostReport extends IntegrationCallReport {
  /** In US dollars, as the provider reported it. */
  cost: number;
}

export async function handleIntegrationProxyRequest({
  request,
  capabilities,
  lookup = CATALOG,
  emailSenders = [],
  env,
  admit,
  fetchUpstream = fetch,
  mail = loadGatewayMail,
  listMembers,
  onCall,
  onCost,
  oauth,
}: HandleIntegrationProxyRequestOptions): Promise<Response> {
  const url = new URL(request.url);
  const hosted = platformPolicy(env).hosted;
  const status = integrationStatusPath(url.pathname, lookup);
  if (status?.capability.mode === "service") {
    // Whether calls would go through, without calling the provider: apps
    // show "ask the operator to set it up" instead of failing mid-task.
    // Only an app that lists the capability learns whether a key is held.
    const entry = capabilities?.[status.id];
    return status.id === "email"
      ? emailCapabilityStatus({ entry, senders: emailSenders, hosted, mail })
      : membersCapabilityStatus(entry);
  }
  if (status?.capability.mode === "oauth_client") {
    const entry = capabilities?.[status.id];
    if (!oauth) {
      return oauthClientStatus({
        id: status.id,
        capability: status.capability,
        entry,
        env,
        lookup,
      });
    }
    const client = entry
      ? await oauth.resolveClient({
          id: status.id,
          capability: status.capability,
          env: env as never,
          lookup,
        })
      : null;
    let connection: HeldConnectionStatus | null | undefined;
    try {
      connection = status.capability.flow
        ? await heldConnectionStatus(oauth, status.id, status.capability, entry)
        : undefined;
    } catch (error) {
      // The status still answers; the connection is simply not reported.
      logEvent(
        "oauth.connection_lookup_failed",
        {
          capability: status.id,
          error: error instanceof Error ? error.name : "unknown",
        },
        "warn",
      );
      connection = undefined;
    }
    return oauthClientStatus({
      id: status.id,
      capability: status.capability,
      entry,
      env,
      lookup,
      client,
      ...(connection === undefined ? {} : { connection }),
    });
  }
  if (status?.capability.mode === "api_key") {
    const requested = Boolean(capabilities?.[status.id]);
    const configured =
      requested &&
      authorizationFor(status.capability, env) !== null &&
      (lookup.bound?.(status.id) ?? true);
    return Response.json({
      capability: status.id,
      requested,
      configured,
      ready: requested && configured,
    });
  }
  // An AI provider's status is the AI proxy's business: its path below
  // names no host, so it is refused as any malformed route is.
  const oauthClient = oauthClientCallId(url.pathname, lookup);
  if (oauthClient && oauth && oauthClient.capability.flow) {
    // A call to one of the provider's API hosts goes with the held token;
    // its token endpoints keep the app-driven branch below.
    const held = heldTokenUpstream(url, oauthClient.id, oauthClient.capability);
    if (held) {
      return handleHeldTokenCall({
        request,
        id: oauthClient.id,
        capability: oauthClient.capability,
        upstream: held,
        entry: capabilities?.[oauthClient.id],
        env,
        lookup,
        admit,
        fetchUpstream,
        resolveClient: oauth.resolveClient,
        connections: oauth.connections,
        ...(onCall ? { onCall } : {}),
      });
    }
  }
  if (oauthClient) {
    return handleOAuthClientCall({
      request,
      id: oauthClient.id,
      capability: oauthClient.capability,
      entry: capabilities?.[oauthClient.id],
      env,
      lookup,
      admit,
      fetchUpstream,
      ...(onCall ? { onCall } : {}),
      ...(oauth ? { resolveClient: oauth.resolveClient } : {}),
    });
  }
  // The settings resolve a provider's `hostSetting` (its host, when it is
  // the operator's) as they resolve an OAuth client's instance.
  const route = parseIntegrationProxyPath(
    url.pathname,
    url.search,
    env,
    lookup,
  );
  if (!route || route.kind === "oauth_client") {
    return refusal(
      400,
      "invalid_integration_route",
      "Integration calls go to /api/integrations/<provider>/<provider host>/<path>, for a host the provider uses, or to a route a gateway service declares (/api/integrations/email/send, /api/integrations/members/list).",
    );
  }
  if (route.kind === "service") {
    const entry = capabilities?.[route.id];
    return route.id === "email"
      ? handleEmailSend({
          request,
          entry,
          senders: emailSenders,
          hosted,
          admit,
          mail,
        })
      : handleMembersList({ request, entry, admit, listMembers });
  }

  const integration = route.capability;
  const entry = capabilities?.[route.id];
  // Approval is of the app: the deployed manifest listing the capability is
  // the grant, for calls with a person behind them and background work alike.
  if (!entry) {
    return refusal(
      403,
      "capability_not_requested",
      `This app doesn't list ${integration.label} in its capabilities. Add it to everyapp.config.ts (capabilities.${route.id}) and deploy again.`,
    );
  }
  if (isAccountWidePath(integration, route.upstream.pathname)) {
    return refusal(
      403,
      "integration_path_not_allowed",
      `${integration.label}'s ${route.upstream.pathname} describes the whole account the gateway's key belongs to, which every app shares.`,
    );
  }
  // A read method goes through on any grant. A write method goes through
  // only on a provider that offers write, for an entry that asks for it,
  // and never for an agent's read-only connection (below, once admitted).
  const method = request.method.toUpperCase();
  const reads = (integration.readMethods as readonly string[]).includes(method);
  const offersWrite = (integration.access as readonly string[]).includes(
    "write",
  );
  const writes =
    !reads &&
    offersWrite &&
    entry.access === "write" &&
    writeMethodsOf(integration).includes(method);
  if (!reads && !writes) {
    const writeMethods = writeMethodsOf(integration);
    // A write-only provider (a sender, a GraphQL API) has no read calls:
    // every method it offers needs the write grant.
    const needsWrite = integration.readMethods.length
      ? `${integration.label} calls may use ${integration.readMethods.join(" or ")} with access: "read"; ${method} needs access: "write" in the app's capabilities entry.`
      : `${integration.label} offers no read calls; ${method} needs access: "write" in the app's capabilities entry.`;
    return refusal(
      405,
      "integration_method_not_allowed",
      offersWrite && writeMethods.includes(method)
        ? needsWrite
        : `${integration.label} calls may use ${(offersWrite ? [...integration.readMethods, ...writeMethods] : integration.readMethods).join(" or ")}.`,
    );
  }

  const auth = authorizationFor(integration, env);
  if (!auth) {
    const names = capabilitySettings(integration);
    return refusal(
      503,
      "integration_not_configured",
      `${integration.label} isn't set up on this gateway. Its operator sets ${names.join(" and ")} with: everyapp secret set ${names.join(" ")}`,
    );
  }
  // A registered provider's value is read only for the hosts and auth it
  // was set for (`providers.value-bound-to-hosts`): a row replaced or
  // added again since reads nothing until the operator sets the key again.
  if (lookup.bound && !lookup.bound(route.id)) {
    const names = capabilitySettings(integration);
    return refusal(
      503,
      "integration_not_configured",
      `${integration.label}'s key was set for other hosts than the provider has now. Its operator sets it again with: everyapp secret set ${names.join(" ")}`,
    );
  }
  // One key reaches one whole account: on a hosted gateway that would be
  // every organization's, so until per-organization keys exist such a
  // provider is served on self-hosted gateways (one organization) only.
  if (integration.data === "account" && hosted) {
    return refusal(
      503,
      "integration_not_available_hosted",
      `${integration.label} isn't offered on a hosted gateway: its key reaches one whole account, which would be every organization's here.`,
    );
  }
  const { caller, user } = await admit();
  if (
    writes &&
    user?.channel === "mcp" &&
    !user.scopes.some((scope) => scope === MCP_WRITE_SCOPE || scope === "*")
  ) {
    return refusal(
      403,
      "integration_read_only",
      `This agent connection is read-only, and ${method} on ${integration.label} writes. Reconnect the agent with write access.`,
    );
  }

  const headers = forwardableHeaders(request.headers);
  for (const [name, value] of Object.entries(auth.headers)) {
    headers.set(name, value);
  }
  // `set` replaces every value the app sent under the parameter's name, so
  // the app's own copy of a query key never reaches the provider.
  for (const [name, value] of Object.entries(auth.query)) {
    route.upstream.searchParams.set(name, value);
  }
  const body = method === "GET" || method === "HEAD" ? null : request.body;
  const upstreamRequest = new Request(route.upstream, {
    method,
    headers,
    body,
    signal: request.signal,
    // The key must never follow a redirect to another host.
    redirect: "manual",
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);

  const logged = {
    capability: route.id,
    ...caller,
    host: route.upstream.host,
    path: route.upstream.pathname,
    method,
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
  };
  let response: Response;
  try {
    response = await fetchUpstream(upstreamRequest);
  } catch (error) {
    // The message only: the failed request carries the key in a header.
    // A key sent as a query parameter is in the URL, which a message may
    // quote, so for those providers the error's name alone.
    logEvent(
      "integration.proxy.upstream_failed",
      {
        ...logged,
        ...(integration.auth.kind === "query"
          ? { error: error instanceof Error ? error.name : "unknown" }
          : {
              message: error instanceof Error ? error.message : String(error),
            }),
      },
      "error",
    );
    return refusal(
      502,
      "integration_upstream_failed",
      `${integration.label} could not be reached.`,
    );
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  // The provider answered, and charges from here: the call is counted now,
  // before the body goes out. Its cost, read off the body where the
  // provider's entry names the field, is added after.
  const call = { capability: route.id, status: response.status };
  onCall?.(call);
  const logCall = (cost: number | null) => {
    logEvent("integration.proxy.call", {
      ...logged,
      status: response.status,
      ...(cost === null ? {} : { cost }),
    });
    if (cost !== null) onCost?.({ ...call, cost });
  };
  if (integration.auth.kind === "query") {
    // The key travelled in the URL, which a provider's Location (built
    // from the request URL on a trailing-slash or canonical-host redirect)
    // would hand back to the app: no redirect is relayed, and no header
    // that names a URL.
    for (const name of ["location", "content-location", "refresh"]) {
      responseHeaders.delete(name);
    }
    if (response.status >= 300 && response.status < 400) {
      logCall(null);
      await response.body?.cancel().catch(() => undefined);
      return refusal(
        502,
        "integration_upstream_redirected",
        `${integration.label} answered with a redirect, which the gateway neither follows nor relays for a provider whose key travels in the URL.`,
      );
    }
    // A provider that builds URLs for the app (Mapbox's TileJSON `tiles`, a
    // style's sources) writes the key into the body: a text answer is read
    // whole, bounded, and every copy of the value, raw or URL-encoded, is
    // replaced before it goes out; one past the bound is refused rather than
    // sent unscrubbed. Binary answers (tiles, images) pass through as streams.
    if (response.body && isTextAnswer(responseHeaders)) {
      const scrubbed = await scrubbedText(
        response.body,
        Object.values(auth.query),
      );
      if (scrubbed === null) {
        logCall(null);
        return refusal(
          502,
          "integration_upstream_failed",
          `${integration.label} answered with more text than the gateway reads for a provider whose key travels in the URL (${QUERY_TEXT_MAX_BYTES} bytes).`,
        );
      }
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      response = new Response(scrubbed, {
        status: response.status,
        statusText: response.statusText,
      });
    }
  }
  const costField = integration.cost?.responseField;
  if (!response.body || !costField) {
    logCall(null);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }
  return new Response(tapCost(response.body, costField, logCall), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/** The most text the gateway reads to scrub a query-key provider's answer. */
const QUERY_TEXT_MAX_BYTES = 4 * 1024 * 1024;

/** Whether an answer is text the key could be written into (JSON, XML, HTML, scripts, forms). */
function isTextAnswer(headers: Headers): boolean {
  const type = (headers.get("content-type") ?? "").toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("x-www-form-urlencoded")
  );
}

/**
 * `body` read whole (at most {@link QUERY_TEXT_MAX_BYTES}, else null with
 * the rest cancelled) with every copy of each of `values`, raw or
 * URL-encoded, replaced by `[redacted]`.
 */
async function scrubbedText(
  body: ReadableStream<Uint8Array>,
  values: readonly string[],
): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > QUERY_TEXT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  let text = new TextDecoder().decode(joined);
  for (const value of values) {
    if (!value) continue;
    for (const copy of new Set([value, encodeURIComponent(value)])) {
      text = text.split(copy).join("[redacted]");
    }
  }
  return text;
}

/**
 * Pass `body` through unchanged and report once the top-level `"<field>"`
 * found in its first few KB (DataForSEO's envelope starts with `cost`), or
 * null: when the head is in, or else when the reading ends. A body the
 * app dropped on the other side of the service binding is never heard
 * (response-tap.ts): the call was counted when the provider answered, and
 * only its cost goes unrecorded.
 */
function tapCost(
  body: ReadableStream<Uint8Array>,
  field: string,
  onDone: (cost: number | null) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  // The field name passed the spec's rule: letters, digits and underscores.
  const pattern = new RegExp(
    `"${field}"\\s*:\\s*(\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`,
  );
  let head = "";
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    const match = pattern.exec(head);
    onDone(match ? Number(match[1]) : null);
  };
  return watchBody(body, {
    chunk(chunk) {
      if (reported || head.length >= COST_HEAD_BYTES) return;
      head += decoder.decode(chunk, { stream: true });
      if (head.length >= COST_HEAD_BYTES) report();
    },
    end() {
      report();
    },
  });
}

/** The capability a status request (`GET /api/integrations/<id>`) names. */
function integrationStatusPath(
  pathname: string,
  lookup: CapabilityLookup,
): { id: string; capability: Capability } | null {
  const id = /^\/api\/integrations\/([a-z][a-z0-9-]*)\/?$/.exec(pathname)?.[1];
  const capability = id === undefined ? undefined : lookup.get(id);
  return id !== undefined && capability ? { id, capability } : null;
}

/**
 * The upstream URL of a held-token call: `/api/integrations/<id>/<host>/<path>`
 * where the host is one of the provider's `api` hosts (never a token
 * endpoint's, which the app-driven branch serves). Null otherwise.
 */
function heldTokenUpstream(
  url: URL,
  id: string,
  capability: OAuthClientCapability,
): URL | null {
  const prefix = `${INTEGRATION_PROXY_PREFIX}/${id}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  if (!host || !(capability.api as readonly string[]).includes(host)) {
    return null;
  }
  const tokenHosts = capability.token.map((endpoint) => endpoint.host);
  if (tokenHosts.includes(host)) return null;
  const path = slash < 0 ? "/" : rest.slice(slash);
  try {
    return new URL(`https://${host}${path}${url.search}`);
  } catch {
    return null;
  }
}

/**
 * The caller's connection for a status request: found by whom the
 * request is for, with whether it covers the sets the entry declares.
 */
async function heldConnectionStatus(
  oauth: OAuthProxyDeps,
  id: string,
  capability: OAuthClientCapability,
  entry: CapabilityRequest | undefined,
): Promise<HeldConnectionStatus | null> {
  if (!entry) return null;
  const who = await oauth.identify();
  if (!who) return null;
  const account = who.user ? "user" : "organization";
  const connection = await oauth.connections.find({
    organizationId: who.organizationId,
    providerId: id,
    account,
    userId: who.user?.id ?? null,
  });
  if (!connection) return null;
  const policy = capability.scopePolicy;
  const declared =
    (policy && declaredScopeSets(policy, { scopes: entry["scopes"] })) ?? [];
  const covers = declared.every((name) => connection.scopeSets.includes(name));
  const reconnect = connection.status === "expired" || !covers;
  return {
    account,
    label: connection.label,
    scopeSets: connection.scopeSets,
    ready: !reconnect,
    ...(reconnect ? { reconnect: true } : {}),
  };
}

/** The OAuth client a call (`/api/integrations/<id>/...`) names, if it names one. */
function oauthClientCallId(
  pathname: string,
  lookup: CapabilityLookup,
): { id: string; capability: OAuthClientCapability } | null {
  const id = /^\/api\/integrations\/([a-z][a-z0-9-]*)\//.exec(pathname)?.[1];
  const capability = id === undefined ? undefined : lookup.get(id);
  return id !== undefined && capability?.mode === "oauth_client"
    ? { id, capability }
    : null;
}
