/**
 * Capability calls from apps, phase 0 of docs/capabilities.md: API-key
 * providers whose key the gateway holds. The AppGateway entrypoint has
 * already proven which app is calling; this checks the app's registry row
 * lists the capability, puts the gateway's key on the request and forwards
 * it, so the app never sees the key.
 */
import {
  CAPABILITIES,
  GATEWAY_ERROR_HEADER,
  IDENTITY_HEADER,
  PUBLIC_HEADER,
  isAccountWidePath,
  isCapabilityId,
  parseIntegrationProxyPath,
  type CapabilityId,
  type CapabilitySecret,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";

export type IntegrationProxyEnv = Partial<Record<CapabilitySecret, string>>;

const STRIPPED_HEADERS = [
  // The gateway's key decides the account, never the app.
  "authorization",
  "x-api-key",
  "cookie",
  IDENTITY_HEADER,
  PUBLIC_HEADER,
  "x-user-id",
  "x-user-email",
  "x-user-sub",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];
// Every gateway trust header: none of them is the provider's business.
const STRIPPED_HEADER_PREFIX = "x-everyapp-";

/** Bytes of a response read for its top-level `cost` (DataForSEO puts it first). */
const COST_HEAD_BYTES = 2048;

/** Whom a call that will reach the provider is for, once admitted. */
interface IntegrationCallAdmission {
  /** Who is calling, for the log line. */
  caller: { organizationId: string; appId: string; orgSource: string };
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
}

export async function handleIntegrationProxyRequest({
  request,
  capabilities,
  env,
  admit,
  fetchUpstream = fetch,
}: HandleIntegrationProxyRequestOptions): Promise<Response> {
  const url = new URL(request.url);
  const status = integrationStatusPath(url.pathname);
  if (status) {
    // Whether calls would go through, without calling the provider: apps
    // show "ask the operator to set it up" instead of failing mid-task.
    // Only an app that lists the capability learns whether a key is held.
    const requested = Boolean(capabilities?.[status]);
    const configured =
      requested && Boolean(env[CAPABILITIES[status].secret]?.trim());
    return Response.json({
      capability: status,
      requested,
      configured,
      ready: requested && configured,
    });
  }
  const route = parseIntegrationProxyPath(url.pathname, url.search);
  if (!route) {
    return refusal(
      400,
      "invalid_integration_route",
      "Integration calls go to /api/integrations/<provider>/<provider host>/<path>, for a host the provider uses.",
    );
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
      `${integration.label} isn't set up on this gateway. Its operator sets ${integration.secret} with: everyapp secret set ${integration.secret} --for gateway`,
    );
  }
  const { caller, user } = await admit();

  const headers = new Headers(request.headers);
  for (const header of STRIPPED_HEADERS) headers.delete(header);
  for (const header of [...headers.keys()]) {
    if (header.startsWith(STRIPPED_HEADER_PREFIX)) headers.delete(header);
  }
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

const STATUS_LABELS: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** The AppGateway error shape: `{ error, code, message }`, code also in a header. */
function refusal(status: number, code: string, message: string): Response {
  return Response.json(
    { error: STATUS_LABELS[status] ?? "Error", code, message },
    { status, headers: { [GATEWAY_ERROR_HEADER]: code } },
  );
}
