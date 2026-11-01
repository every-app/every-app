import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { peekInvitation } from "@/server/invitation-token";
import {
  gatewayOrigin,
  jsonResponse,
  SENSITIVE_JSON_HEADERS,
} from "@/routes/api/_request-origin";

const lookupSchema = z.object({
  token: z.string().min(1).max(256),
});

function respond(payload: unknown, status = 200): Response {
  return jsonResponse(payload, status, SENSITIVE_JSON_HEADERS);
}

/**
 * What an invite link opens, before sign-in: the organization's name and
 * the invited address (masked), so the accept page can say who is invited
 * where and refuse a dead link before anyone makes an account. A plain JSON
 * route like the setup claim: same-origin, JSON only, and counted by the
 * credential rate limiter (auth-rate-limit.ts). The link's token is the only
 * thing it answers to; unknown, used, canceled and expired tokens get one
 * 404 between them.
 */
export const Route = createFileRoute("/api/invitations/lookup")({
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
        const parsed = lookupSchema.safeParse(body);
        if (!parsed.success) {
          return respond({ error: "INVALID_INPUT" }, 400);
        }

        const invitation = await peekInvitation(parsed.data.token);
        if (!invitation) {
          return respond({ error: "INVITATION_NOT_VALID" }, 404);
        }
        return respond(invitation);
      },
    },
  },
});
