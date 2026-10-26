import { GATEWAY_ERROR_HEADER } from "@every-app/sdk/internal";
import type { SetupInfo } from "@/server/setup-info";

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

/**
 * `integration_not_configured` (503): the setup sentence as the message,
 * with the unset settings and the command beside it (server/setup-info.ts).
 */
export function notConfiguredRefusal(info: SetupInfo): Response {
  return Response.json(
    {
      error: STATUS_LABELS[503],
      code: "integration_not_configured",
      message: info.setup,
      ...info,
    },
    {
      status: 503,
      headers: { [GATEWAY_ERROR_HEADER]: "integration_not_configured" },
    },
  );
}
