import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import { deployErrorResponse, readJsonBody } from "@/server/deploy-api";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";

const deployedSchema = z.object({
  versionId: z.string().trim().min(1, "versionId is required").max(128),
  manifest: z.unknown(),
});

/**
 * The CLI uploaded a new version of the app's Worker: record it and the
 * manifest it was built from. A new app moves from `pending` to `binding`.
 */
export const Route = createFileRoute("/api/deploy/apps/$appId/deployed")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      POST: async ({ request, params, context }) => {
        const { organizationId } = context as DeployTokenContext;
        const body = await readJsonBody(request, deployedSchema);
        if (!body.ok) return body.response;
        try {
          return jsonResponse(
            await AppRegistrationService.markDeployed({
              organizationId,
              appSlug: params.appId,
              versionId: body.data.versionId,
              manifest: body.data.manifest,
            }),
          );
        } catch (error) {
          return deployErrorResponse(error);
        }
      },
    },
  },
});
