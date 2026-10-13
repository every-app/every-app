import { createFileRoute } from "@tanstack/react-router";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import { deployErrorResponse } from "@/server/deploy-api";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";

/** An app's deploy state, Worker, hostname and the names of its resources. */
export const Route = createFileRoute("/api/deploy/apps/$appId/info")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      GET: async ({ params, context }) => {
        const { organizationId } = context as DeployTokenContext;
        try {
          return jsonResponse(
            await AppRegistrationService.describe({
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
