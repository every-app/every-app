import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import { deployErrorResponse, probeAppBinding } from "@/server/deploy-api";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";

/**
 * Make the app live once this gateway version reaches its Worker over the
 * service binding. 409 `BINDING_NOT_READY` until it does; the CLI retries.
 */
export const Route = createFileRoute("/api/deploy/apps/$appId/activate")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const { organizationId } = context as DeployTokenContext;
        try {
          return jsonResponse(
            await AppRegistrationService.activate({
              organizationId,
              appSlug: params.appId,
              probe: (app) => probeAppBinding(env, app),
            }),
          );
        } catch (error) {
          return deployErrorResponse(error);
        }
      },
    },
  },
});
