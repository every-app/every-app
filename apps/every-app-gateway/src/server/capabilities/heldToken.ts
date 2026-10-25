/**
 * An app's call to an OAuth provider's API with the token the Gateway
 * holds for the person (or the organization)
 * (docs/design/2026-10-oauth-providers.md section 7):
 *
 *   ANY /api/integrations/<id>/<api host>/<path>    x-everyapp-account: user|organization
 *
 * Checked in order, each a refusal with its code: the app lists the
 * provider; the method is one the grant allows; the provider has a live
 * client; whom the call is for (an agent's read-only connection never
 * writes); the account's connection exists and is not expired and holds
 * every set the app declares; the path is one a declared set unlocks;
 * then the token (refreshed first when due) goes on as the bearer, the
 * app's own credentials and cookies stripped, and the provider's answer
 * comes back without its cookies. The token, the refresh token and the
 * client never reach the app (`oauth.held-token-never-to-app`).
 */
import {
  ACCOUNT_HEADER,
  GATEWAY_ERROR_HEADER,
  declaredScopeSets,
  heldTokenCallAllowed,
  oauthReadMethods,
  oauthWriteMethods,
  MCP_WRITE_SCOPE,
  type CapabilityLookup,
  type CapabilitySettings,
  type ConnectionAccount,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import type { OAuthClientResolver } from "@/server/oauth/client";
import type { HeldTokenPort } from "@/server/oauth/heldTokens";
import { forwardableHeaders } from "./forward";
import { capabilityRefusal } from "./refusal";

/** The query keys an app's call never carries to the provider: a token of its own. */
const STRIPPED_QUERY = ["access_token", "token"];

interface HeldTokenCallOptions {
  request: Request;
  id: string;
  capability: OAuthClientCapability;
  /** The provider host and path the app named, already parsed from the route. */
  upstream: URL;
  entry: CapabilityRequest | undefined;
  env: CapabilitySettings;
  lookup: CapabilityLookup;
  admit: () => Promise<IntegrationCallAdmission>;
  fetchUpstream: (request: Request) => Promise<Response>;
  resolveClient: OAuthClientResolver;
  connections: HeldTokenPort;
  onCall?: (report: { capability: string; status: number }) => void;
}

/** Whether a header value names an account kind. */
function accountOf(value: string | null): ConnectionAccount | null | undefined {
  if (value === null || value === "") return undefined;
  const text = value.trim().toLowerCase();
  return text === "user" || text === "organization" ? text : null;
}

export async function handleHeldTokenCall({
  request,
  id,
  capability,
  upstream,
  entry,
  env,
  lookup,
  admit,
  fetchUpstream,
  resolveClient,
  connections,
  onCall,
}: HeldTokenCallOptions): Promise<Response> {
  const connectPath = `/connect/${encodeURIComponent(id)}`;
  const notConnected = (
    message: string,
    extra: { reconnect: boolean; missingSets?: string[] },
  ) =>
    Response.json(
      {
        error: "Conflict",
        code: "integration_not_connected",
        message,
        connectPath,
        ...extra,
      },
      {
        status: 409,
        headers: { [GATEWAY_ERROR_HEADER]: "integration_not_connected" },
      },
    );

  // 1. The deployed manifest listing the provider is the grant.
  if (!entry) {
    return capabilityRefusal(
      403,
      "capability_not_requested",
      `This app doesn't list ${capability.label} in its capabilities. Add it to everyapp.config.ts (capabilities.${id}) and deploy again.`,
    );
  }
  // 2. The method: reads on any grant, writes on a write grant for a
  // provider that offers it (a set's routes may still admit a read-shaped
  // POST below).
  const method = request.method.toUpperCase();
  const readMethods = oauthReadMethods(capability);
  const reads = readMethods.includes(method);
  const offersWrite = (capability.access as readonly string[]).includes(
    "write",
  );
  const writes =
    !reads &&
    offersWrite &&
    entry.access === "write" &&
    oauthWriteMethods(capability).includes(method);
  // 2b. With scope sets, the ones the entry declares are the grant; a
  // void grant is refused whole.
  const policy = capability.scopePolicy;
  const declared = policy
    ? declaredScopeSets(policy, { scopes: entry["scopes"] })
    : [];
  if (policy && Object.keys(policy.sets).length > 0 && !declared) {
    return capabilityRefusal(
      403,
      "integration_scopes_undeclared",
      `This app's entry for ${capability.label} must list the scope sets it uses (scopes: [...] in everyapp.config.ts; this gateway offers ${Object.keys(policy.sets).join(", ")}).`,
    );
  }
  const declaredSets = declared ?? [];
  // 3. A live client.
  const client = await resolveClient({
    id,
    capability,
    env: env as never,
    lookup,
  });
  if (!client) {
    return capabilityRefusal(
      503,
      "integration_not_configured",
      `${capability.label} has no client on this Gateway. An owner or admin adds one under Manage workspace → Providers.`,
    );
  }
  // 4. Whom the call is for.
  const { caller, user } = await admit();
  if (
    writes &&
    user?.channel === "mcp" &&
    !user.scopes.some((scope) => scope === MCP_WRITE_SCOPE || scope === "*")
  ) {
    return capabilityRefusal(
      403,
      "integration_read_only",
      `This agent connection is read-only, and ${method} on ${capability.label} writes. Reconnect the agent with write access.`,
    );
  }
  // 5. Whose connection: the header, else the person's, else the organization's.
  const asked = accountOf(request.headers.get(ACCOUNT_HEADER));
  if (asked === null) {
    return capabilityRefusal(
      400,
      "integration_body_invalid",
      `${ACCOUNT_HEADER} must be user or organization.`,
    );
  }
  const account: ConnectionAccount = asked ?? (user ? "user" : "organization");
  if (account === "user" && !user) {
    return notConnected(
      `No person is behind this call, so there is no ${capability.label} account to use; pass account: "organization" for background work.`,
      { reconnect: false },
    );
  }
  const connection = await connections.find({
    organizationId: caller.organizationId,
    providerId: id,
    account,
    userId: user?.id ?? null,
  });
  if (!connection) {
    return notConnected(
      account === "user"
        ? `${capability.label} isn't connected for this person yet. Send them to ${connectPath}.`
        : `${capability.label} isn't connected for this organization yet. An owner or admin connects it at ${connectPath}?account=organization.`,
      { reconnect: false, missingSets: declaredSets },
    );
  }
  if (connection.status === "expired") {
    return notConnected(
      `${capability.label} refused to refresh this connection; connect it again at ${connectPath}.`,
      { reconnect: true },
    );
  }
  // 6. What the connection unlocks for this call.
  const allowed = policy
    ? heldTokenCallAllowed({
        policy,
        declaredSets,
        connectionSets: connection.scopeSets,
        hosts: capability.api,
        method,
        upstream,
        readMethods,
        writes,
      })
    : reads || writes
      ? { ok: true as const, set: "" }
      : {
          ok: false as const,
          code: "integration_method_not_allowed" as const,
          message: `${capability.label} calls may use ${readMethods.join(" or ")} with access: "read"; ${method} needs access: "write" in the app's capabilities entry.`,
        };
  if (!allowed.ok) {
    if (allowed.code === "integration_not_connected") {
      return notConnected(
        `This ${capability.label} connection lacks ${allowed.missingSets.join(", ")}, which this app needs; connect it again at ${connectPath}.`,
        { reconnect: true, missingSets: allowed.missingSets },
      );
    }
    return capabilityRefusal(
      allowed.code === "integration_method_not_allowed" ? 405 : 403,
      allowed.code,
      allowed.message,
    );
  }
  // 7. The token, refreshed first when due.
  const token = await connections.accessToken({
    connection,
    providerId: id,
    capability,
    client,
    organizationId: caller.organizationId,
  });
  if (!token.ok) {
    if (token.reason === "unavailable") {
      return capabilityRefusal(
        502,
        "integration_upstream_failed",
        `${capability.label} could not refresh the connection's token; try again.`,
      );
    }
    if (token.reason === "expired") {
      await connections.expired({
        connection,
        providerId: id,
        capability,
        organizationId: caller.organizationId,
      });
    }
    return notConnected(
      `${capability.label}'s token for this connection can't be used any more; connect it again at ${connectPath}.`,
      { reconnect: true },
    );
  }

  const headers = forwardableHeaders(request.headers);
  headers.delete("x-http-method-override");
  headers.set("authorization", `Bearer ${token.accessToken}`);
  for (const name of STRIPPED_QUERY) upstream.searchParams.delete(name);
  const body = method === "GET" || method === "HEAD" ? null : request.body;
  const upstreamRequest = new Request(upstream, {
    method,
    headers,
    body,
    signal: request.signal,
    // The token must never follow a redirect to another host.
    redirect: "manual",
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
  const logged = {
    capability: id,
    ...caller,
    host: upstream.host,
    path: upstream.pathname,
    method,
    account,
    ...(allowed.set ? { scopeSet: allowed.set } : {}),
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
  };
  let response: Response;
  try {
    response = await fetchUpstream(upstreamRequest);
  } catch (error) {
    logEvent(
      "integration.proxy.upstream_failed",
      { ...logged, error: error instanceof Error ? error.name : "unknown" },
      "error",
    );
    return capabilityRefusal(
      502,
      "integration_upstream_failed",
      `${capability.label} could not be reached.`,
    );
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  onCall?.({ capability: id, status: response.status });
  logEvent("integration.proxy.call", { ...logged, status: response.status });
  await connections.touch(connection.id).catch(() => undefined);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
