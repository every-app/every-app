import { GATEWAY_ERROR_HEADER } from "@every-app/sdk/internal";

const STATUS_LABELS: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/**
 * The AppGateway error shape for capability calls: `{ error, code,
 * message }`, the code also in `x-everyapp-error` so the SDK's
 * `gatewayRefusal()` tells it from a provider's own error.
 */
export function capabilityRefusal(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: STATUS_LABELS[status] ?? "Error", code, message },
    { status, headers: { ...headers, [GATEWAY_ERROR_HEADER]: code } },
  );
}
