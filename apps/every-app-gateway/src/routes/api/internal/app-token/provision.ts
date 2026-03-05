import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppTokenService } from "@/server/services/AppTokenService";
import {
  jsonResponse,
  internalCloudflareAuthMiddleware,
} from "@/server/internal-cloudflare-auth";

const DEFAULT_TOKEN_SCOPES = ["provider:openai"];

const provisionAppTokenSchema = z.object({
  appSlug: z
    .string()
    .trim()
    .min(1, "appSlug is required")
    .max(128, "appSlug is too long")
    .regex(
      /^[a-z0-9-]+$/,
      "appSlug must contain only lowercase letters, numbers, and hyphens",
    ),
  scopes: z.array(z.string().min(1)).max(20).optional(),
});

export const Route = createFileRoute("/api/internal/app-token/provision")({
  server: {
    middleware: [internalCloudflareAuthMiddleware],
    handlers: {
      POST: async ({ request }) => {
        let rawBody: unknown;
        try {
          rawBody = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON payload" }, 400);
        }

        const parsed = provisionAppTokenSchema.safeParse(rawBody);
        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          return jsonResponse(
            {
              error: firstIssue?.message || "Invalid request payload",
            },
            400,
          );
        }

        const app = await AppRepository.findByAppId(parsed.data.appSlug);
        if (!app) {
          return jsonResponse(
            {
              error: `App not found: ${parsed.data.appSlug}`,
            },
            404,
          );
        }

        try {
          // TODO: Replace this with a dedicated local-dev token issuance flow
          // that does not rely on Cloudflare API token auth.
          const token = await AppTokenService.create(
            {
              appId: app.id,
              scopes: parsed.data.scopes ?? DEFAULT_TOKEN_SCOPES,
              expiresAt: null,
            },
            null,
          );

          return jsonResponse({
            token: token.token,
            tokenPrefix: token.tokenPrefix,
            appId: token.appId,
            appSlug: token.appSlug,
            scopes: token.scopes,
          });
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to create token",
            },
            400,
          );
        }
      },
    },
  },
});
