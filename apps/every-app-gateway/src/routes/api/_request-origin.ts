import { env } from "cloudflare:workers";

export const JSON_HEADERS = {
  "Content-Type": "application/json",
};

export const SENSITIVE_JSON_HEADERS = {
  ...JSON_HEADERS,
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

export function jsonResponse(
  payload: unknown,
  status = 200,
  headers: HeadersInit = JSON_HEADERS,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

/**
 * The origin a browser must send in `Origin` to reach one of the gateway's
 * plain JSON routes: the gateway's own, falling back to the request's when
 * GATEWAY_URL is unset (development).
 */
export function gatewayOrigin(request: Request): string {
  try {
    if (env.GATEWAY_URL) return new URL(env.GATEWAY_URL).origin;
  } catch {
    // Fall through to the request's own origin.
  }
  return new URL(request.url).origin;
}
