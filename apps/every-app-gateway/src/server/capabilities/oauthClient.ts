/**
 * The `oauth_client` capability (docs/capabilities.md "OAuth clients"): the
 * operator holds a social network's OAuth client as gateway secrets, and the
 * gateway completes apps' calls to that network's token endpoints with it.
 * Nothing else on the network's hosts is proxied: the app builds the
 * authorize URL from the public client id, keeps the user tokens and calls
 * the network's API with them itself. The client secret never reaches an
 * app, and token responses pass through unlogged.
 *
 *   GET|POST /api/integrations/<id>/<token host><token path>   the provider's answer
 *   GET      /api/integrations/<id>                            { capability, requested, configured, ready, clientId?, origin? }
 */
import {
  CAPABILITIES,
  OAUTH_TOKEN_BODY_LIMIT,
  describeTokenEndpoints,
  injectClientCredentials,
  oauthClientCredentials,
  oauthClientOrigin,
  oauthClientSecretSetCommand,
  parseIntegrationProxyPath,
  tokenGrantType,
  type CapabilitySettings,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import { forwardableHeaders } from "./forward";
import { capabilityRefusal } from "./refusal";

/** Whether the app may use the client: its manifest lists it for writing. */
function requested(entry: CapabilityRequest | undefined): boolean {
  return entry?.access === "write";
}

/**
 * `GET /api/integrations/<id>`: whether a token call would go through, and
 * the public client id for the authorize URL (with the origin of a provider
 * whose instance the operator chose). Only an app that lists the client
 * learns whether the gateway holds it, or its id.
 */
export function oauthClientStatus({
  id,
  entry,
  env,
}: {
  id: OAuthClientCapabilityId;
  entry: CapabilityRequest | undefined;
  env: CapabilitySettings;
}): Response {
  const capability: OAuthClientCapability = CAPABILITIES[id];
  const isRequested = requested(entry);
  const client = isRequested ? oauthClientCredentials(capability, env) : null;
  const origin = client ? oauthClientOrigin(capability, env) : null;
  return Response.json({
    capability: id,
    requested: isRequested,
    configured: Boolean(client),
    ready: Boolean(client),
    ...(client ? { clientId: client.clientId } : {}),
    ...(origin ? { origin } : {}),
  });
}

/**
 * An app's call to one of an OAuth client's token endpoints, checked in
 * this order, each a refusal with its code: the endpoint, the app's grant,
 * whom the call is for (never an agent), the gateway's client, the body.
 */
export async function handleOAuthClientCall({
  request,
  id,
  entry,
  env,
  admit,
  fetchUpstream,
  onCall,
}: {
  request: Request;
  id: OAuthClientCapabilityId;
  /** The calling app's manifest entry for `id`, if it lists one. */
  entry: CapabilityRequest | undefined;
  env: CapabilitySettings;
  admit: () => Promise<IntegrationCallAdmission>;
  fetchUpstream: (request: Request) => Promise<Response>;
  /** Told of each call the provider answered (integration-proxy.ts). */
  onCall?: (report: {
    capability: OAuthClientCapabilityId;
    status: number;
  }) => void;
}): Promise<Response> {
  const capability: OAuthClientCapability = CAPABILITIES[id];
  const notConfigured = () =>
    capabilityRefusal(
      503,
      "integration_not_configured",
      `${capability.label} isn't set up on this gateway. Its operator registers an OAuth client (docs/capabilities.md, "OAuth clients") and gives it to the gateway with: ${oauthClientSecretSetCommand(capability)}`,
    );
  // An instance setting that isn't an https origin: no call can go through.
  if (capability.hostSetting && !oauthClientOrigin(capability, env)) {
    return notConfigured();
  }

  // 1. Token endpoints only, each with its methods.
  const url = new URL(request.url);
  const route = parseIntegrationProxyPath(url.pathname, url.search, env);
  const method = request.method.toUpperCase();
  if (
    route?.kind !== "oauth_client" ||
    !(route.endpoint.methods as readonly string[]).includes(method)
  ) {
    return capabilityRefusal(
      403,
      "integration_path_not_allowed",
      `Through the gateway, ${capability.label} answers its token endpoints only: ${describeTokenEndpoints(capability)}. Call its API with the user's token directly.`,
    );
  }

  // 2. The deployed manifest listing the client for writing is the grant.
  if (!requested(entry)) {
    return capabilityRefusal(
      403,
      "capability_not_requested",
      `This app doesn't list ${capability.label} in its capabilities. Add capabilities: { ${JSON.stringify(id)}: { access: "write" } } to everyapp.config.ts and deploy again.`,
    );
  }

  // 3. Whom the tokens are for (throws the entrypoint's caller_* refusals).
  // Agents can't complete an OAuth flow, and must not mint tokens.
  const { caller, user } = await admit();
  if (user?.channel === "mcp") {
    return capabilityRefusal(
      403,
      "integration_agent_not_allowed",
      `An agent can't connect or refresh ${capability.label} accounts: the person does it in the app.`,
    );
  }

  // 4. The gateway's client.
  const client = oauthClientCredentials(capability, env);
  if (!client) return notConfigured();

  // 5. The body, the client put on it, and the call.
  const body = method === "GET" ? null : await readCapped(request);
  if (body === undefined) {
    return capabilityRefusal(
      413,
      "integration_body_too_large",
      `A token request's body is at most ${OAUTH_TOKEN_BODY_LIMIT / 1024} KiB.`,
    );
  }
  const injected = injectClientCredentials(
    {
      url: route.upstream,
      headers: forwardableHeaders(request.headers),
      body,
    },
    route.endpoint,
    client,
  );
  if (!injected.ok) {
    return capabilityRefusal(400, "integration_body_invalid", injected.problem);
  }
  const upstreamRequest = new Request(injected.url, {
    method,
    headers: injected.headers,
    body: injected.body,
    signal: request.signal,
    // The client must never follow a redirect to another host.
    redirect: "manual",
  });

  // Never the body, the query string or the answer: they carry the client,
  // codes and tokens.
  const logged = {
    capability: id,
    ...caller,
    host: route.upstream.host,
    path: route.upstream.pathname,
    method,
    grantType: tokenGrantType(injected),
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
  };
  let response: Response;
  try {
    response = await fetchUpstream(upstreamRequest);
  } catch (error) {
    // Its name only: a message may quote the URL, and the query rule puts
    // the client secret there.
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
  logEvent("integration.proxy.call", { ...logged, status: response.status });
  onCall?.({ capability: id, status: response.status });

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The request body as text, or undefined once it passes the cap: counted as
 * it streams, so a body that lies about (or omits) its length still stops.
 */
async function readCapped(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > OAUTH_TOKEN_BODY_LIMIT) {
    return undefined;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OAUTH_TOKEN_BODY_LIMIT) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
