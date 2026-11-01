import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getPublicErrorCode } from "@/server/errors";
import { SetupError, SetupService } from "@/server/services/SetupService";
import {
  gatewayOrigin,
  jsonResponse,
  SENSITIVE_JSON_HEADERS,
} from "@/routes/api/_request-origin";

const claimSchema = z.object({
  token: z.string().min(1).max(256),
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().email("Invalid email address").max(254),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

function respond(payload: unknown, status = 200): Response {
  return jsonResponse(payload, status, SENSITIVE_JSON_HEADERS);
}

/**
 * Claim a fresh gateway with its one-time setup link. A plain JSON route,
 * not a server function: the password travels only in this POST body, and
 * the request must come from the gateway's own /setup page.
 */
export const Route = createFileRoute("/api/setup/claim")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          return respond({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
        }
        if (request.headers.get("origin") !== gatewayOrigin(request)) {
          return respond({ error: "ORIGIN_NOT_ALLOWED" }, 403);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return respond({ error: "INVALID_INPUT" }, 400);
        }
        const parsed = claimSchema.safeParse(body);
        if (!parsed.success) {
          return respond(
            {
              error: "INVALID_INPUT",
              message: parsed.error.issues[0]?.message ?? "Invalid input",
            },
            400,
          );
        }

        try {
          const result = await SetupService.claimOwner(parsed.data);
          return respond({ ok: true, organizationId: result.organizationId });
        } catch (error) {
          if (error instanceof SetupError) {
            return respond(
              { error: error.code, message: error.message },
              error.status,
            );
          }
          if (getPublicErrorCode(error) === "USER_ALREADY_EXISTS") {
            return respond({ error: "USER_ALREADY_EXISTS" }, 409);
          }
          throw error;
        }
      },
    },
  },
});
