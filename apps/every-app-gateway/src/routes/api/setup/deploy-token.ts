import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SetupService } from "@/server/services/SetupService";
import {
  jsonResponse,
  SENSITIVE_JSON_HEADERS,
} from "@/routes/api/_request-origin";

const retrievalSchema = z.object({
  cliSecret: z.string().min(1).max(256),
});

function respond(payload: unknown, status = 200): Response {
  return jsonResponse(payload, status, SENSITIVE_JSON_HEADERS);
}

/**
 * The deploying CLI's half of the setup link: it polls with the secret it
 * kept (never the link's own) while the owner claims the gateway, and gets
 * the owner's first deploy token once. The secret is the credential, so no
 * session, Origin or rate limit is involved: nobody guesses 256 bits.
 *
 *   202 { status: "pending" }  the link isn't claimed yet
 *   200 { token, organizationId, organizationName, ownerEmail }  once,
 *       with who claimed the link, for the CLI to show whose token it is
 *   404 INVALID_OR_EXPIRED_SETUP_LINK  anything else
 */
export const Route = createFileRoute("/api/setup/deploy-token")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          return respond({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return respond({ error: "INVALID_INPUT" }, 400);
        }
        const parsed = retrievalSchema.safeParse(body);
        if (!parsed.success) return respond({ error: "INVALID_INPUT" }, 400);

        const result = await SetupService.retrieveDeployToken(
          parsed.data.cliSecret,
        );
        if (result.status === "pending") {
          return respond({ status: "pending" }, 202);
        }
        if (result.status === "invalid") {
          return respond(
            {
              error: "This setup link is invalid, expired or already used.",
              code: "INVALID_OR_EXPIRED_SETUP_LINK",
            },
            404,
          );
        }
        return respond({
          token: result.token,
          organizationId: result.organizationId,
          organizationName: result.organizationName,
          ownerEmail: result.ownerEmail,
        });
      },
    },
  },
});
