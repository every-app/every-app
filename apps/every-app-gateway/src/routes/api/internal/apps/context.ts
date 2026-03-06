import { createFileRoute } from "@tanstack/react-router";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  jsonResponse,
  internalCloudflareAuthMiddleware,
} from "@/server/internal-cloudflare-auth";

export const Route = createFileRoute("/api/internal/apps/context")({
  server: {
    middleware: [internalCloudflareAuthMiddleware],
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const organizationId = url.searchParams.get("organizationId")?.trim();
        const appId = url.searchParams.get("appId")?.trim();

        if (!organizationId || !appId) {
          return jsonResponse(
            { error: "organizationId and appId are required" },
            400,
          );
        }

        const existingApp = await AppRepository.findByAppId(
          appId,
          organizationId,
        );

        return jsonResponse({
          existingApp: Boolean(existingApp),
          app: existingApp
            ? {
                id: existingApp.id,
                appId: existingApp.appId,
                isDefault: existingApp.isDefault,
              }
            : null,
        });
      },
    },
  },
});
