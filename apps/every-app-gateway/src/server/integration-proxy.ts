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
  CAPABILITIES,
  isAccountWidePath,
  isCapabilityId,
  parseIntegrationProxyPath,
  type CapabilityId,
  type CapabilitySecret,
  type EveryAppUser,
  type OAuthClientCapabilityId,
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
import {
  handleOAuthClientCall,
  oauthClientStatus,
} from "./capabilities/oauthClient";
import { capabilityRefusal as refusal } from "./capabilities/refusal";
import { platformPolicy } from "./platform-policy";

export type IntegrationProxyEnv = Partial<Record<CapabilitySecret, string>> & {
  GATEWAY_DEPLOYMENT_MODE?: string;
};

/** Bytes of a response read for its top-level `cost` (DataForSEO puts it first). */
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
}

export async function handleIntegrationProxyRequest({
  request,
  capabilities,
  env,
  admit,
  fetchUpstream = fetch,
  mail = loadGatewayMail,
  listMembers,
}: HandleIntegrationProxyRequestOptions): Promise<Response> {
  const url = new URL(request.url);
  const hosted = platformPolicy(env).hosted;
  const status = integrationStatusPath(url.pathname);
  if (status) {
    // Whether calls would go through, without calling the provider: apps
    // show "ask the operator to set it up" instead of failing mid-task.
    // Only an app that lists the capability learns whether a key is held.
    const capability = CAPABILITIES[status];
    if (capability.mode === "service") {
      const entry = capabilities?.[status];
      return status === "email"
        ? emailCapabilityStatus({ entry, hosted, mail })
        : membersCapabilityStatus(entry);
    }
    if (capability.mode === "oauth_client") {
      return oauthClientStatus({
        id: status as OAuthClientCapabilityId,
        entry: capabilities?.[status],
        env,
      });
    }
    const requested = Boolean(capabilities?.[status]);
    const configured = requested && Boolean(env[capability.secret]?.trim());
    return Response.json({
      capability: status,
      requested,
      configured,
      ready: requested && configured,
    });
  }
  const oauthClient = oauthClientCallId(url.pathname);
  if (oauthClient) {
    return handleOAuthClientCall({
      request,
      id: oauthClient,
      entry: capabilities?.[oauthClient],
      env,
      admit,
      fetchUpstream,
    });
  }
  const route = parseIntegrationProxyPath(url.pathname, url.search);
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
      ? handleEmailSend({ request, entry, hosted, admit, mail })
      : handleMembersList({ request, entry, admit, listMembers });
  }

  const integration = CAPABILITIES[route.id];
  // Approval is of the app: the deployed manifest listing the capability is
  // the grant, for calls with a person behind them and background work alike.
  if (!capabilities?.[route.id]) {
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
  // Phase 0 providers only read, so an agent's read-only connection holds
  // through an app by default. Providers that write will check `mcp:write`.
  const method = request.method.toUpperCase();
  if (!(integration.readMethods as readonly string[]).includes(method)) {
    return refusal(
      405,
      "integration_method_not_allowed",
      `${integration.label} calls may use ${integration.readMethods.join(" or ")}.`,
    );
  }

  const key = env[integration.secret]?.trim();
  if (!key) {
    return refusal(
      503,
      "integration_not_configured",
      `${integration.label} isn't set up on this gateway. Its operator sets ${integration.secret} with: everyapp secret set ${integration.secret}`,
    );
  }
  const { caller, user } = await admit();

  const headers = forwardableHeaders(request.headers);
  headers.set("authorization", integration.authorization(key));
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
    // The message only: the failed request carries the key.
    logEvent(
      "integration.proxy.upstream_failed",
      {
        ...logged,
        message: error instanceof Error ? error.message : String(error),
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
  const logCall = (cost: number | null) =>
    logEvent("integration.proxy.call", {
      ...logged,
      status: response.status,
      ...(cost === null ? {} : { cost }),
    });
  if (!response.body) {
    logCall(null);
    return new Response(null, {
      status: response.status,
      headers: responseHeaders,
    });
  }
  return new Response(tapCost(response.body, logCall), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Pass `body` through unchanged and report the top-level `"cost"` found in
 * its first few KB (DataForSEO's envelope starts with it), or null.
 */
function tapCost(
  body: ReadableStream<Uint8Array>,
  onDone: (cost: number | null) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let head = "";
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    const match = /"cost"\s*:\s*(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(head);
    onDone(match ? Number(match[1]) : null);
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!reported && head.length < COST_HEAD_BYTES) {
          head += decoder.decode(chunk, { stream: true });
          if (head.length >= COST_HEAD_BYTES) report();
        }
        controller.enqueue(chunk);
      },
      flush() {
        report();
      },
    }),
  );
}

/** The capability a status request (`GET /api/integrations/<id>`) names. */
function integrationStatusPath(pathname: string): CapabilityId | null {
  const id = /^\/api\/integrations\/([a-z][a-z0-9-]*)\/?$/.exec(pathname)?.[1];
  return isCapabilityId(id) ? id : null;
}

/** The OAuth client a call (`/api/integrations/<id>/...`) names, if it names one. */
function oauthClientCallId(pathname: string): OAuthClientCapabilityId | null {
  const id = /^\/api\/integrations\/([a-z][a-z0-9-]*)\//.exec(pathname)?.[1];
  return isCapabilityId(id) && CAPABILITIES[id].mode === "oauth_client"
    ? (id as OAuthClientCapabilityId)
    : null;
}
