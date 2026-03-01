import { createFileRoute } from "@tanstack/react-router";
import { createSessionToken } from "@/serverFunctions/session-token";
import { getGatewayErrorCode } from "@/server/errors";
import { SENSITIVE_JSON_HEADERS, jsonResponse } from "./_request-origin";
import { ZodError } from "zod";

function toErrorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return jsonResponse({ code: "INVALID_INPUT" }, 400, SENSITIVE_JSON_HEADERS);
  }

  const code = getGatewayErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return jsonResponse({ code }, 401, SENSITIVE_JSON_HEADERS);
  }
  if (code === "ORIGIN_NOT_ALLOWED") {
    return jsonResponse({ code }, 403, SENSITIVE_JSON_HEADERS);
  }
  if (code === "REQUEST_EXPIRED" || code === "ACCESS_DENIED") {
    return jsonResponse({ code }, 400, SENSITIVE_JSON_HEADERS);
  }
  return jsonResponse({ code: "INTERNAL_ERROR" }, 500, SENSITIVE_JSON_HEADERS);
}

export const Route = createFileRoute("/api/session-token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse(
            { code: "INVALID_INPUT" },
            400,
            SENSITIVE_JSON_HEADERS,
          );
        }

        try {
          const response = await createSessionToken({ data: body });
          return jsonResponse(response, 200, SENSITIVE_JSON_HEADERS);
        } catch (error) {
          return toErrorResponse(error);
        }
      },
    },
  },
});
