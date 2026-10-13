import { createFileRoute } from "@tanstack/react-router";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import { deployErrorResponse } from "@/server/deploy-api";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";

/**
 * Delete the app, leaving a tombstone, and answer with its Worker, hostname
 * and resources for `everyapp app delete` to unbind and, on request, purge.
 */
export const Route = createFileRoute("/api/deploy/apps/$appId/delete")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const { organizationId } = context as DeployTokenContext;
        try {
          return jsonResponse(
            await AppRegistrationService.delete({
              organizationId,
              appSlug: params.appId,
            }),
          );
        } catch (error) {
          return deployErrorResponse(error);
        }
      },
    },
  },
});
