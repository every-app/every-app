import { createFileRoute } from "@tanstack/react-router";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import {
  AppRepository,
  DELETED_APP_STATUS,
} from "@/server/repositories/AppRepository";
import {
  BindingNotReadyError,
  logToolSync,
  syncAppTools,
} from "@/server/toolbus/catalog-sync";

/**
 * Snapshot a registered app's agent tools. `everyapp app deploy` calls it
 * after updating the gateway's service bindings, and retries on 503 while
 * the gateway version that has the app's binding rolls out.
 */
export const Route = createFileRoute("/api/deploy/apps/$appId/tools/sync")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      POST: async ({ params, context }) => {
        const { organizationId } = context as DeployTokenContext;
        const row = await AppRepository.findByAppSlug(
          params.appId,
          organizationId,
        );
        if (
          !row ||
          row.status === DELETED_APP_STATUS ||
          !row.hostname ||
          !row.workerName
        ) {
          return jsonResponse(
            {
              error: `App "${params.appId}" is not registered on this gateway.`,
              code: "APP_NOT_FOUND",
            },
            404,
          );
        }

        const app = {
          rowId: row.id,
          organizationId: row.organizationId,
          appSlug: row.appSlug,
          hostname: row.hostname,
          workerName: row.workerName,
          tier: row.tier,
        };
        try {
          const result = await syncAppTools(app);
          logToolSync(app, result, "deploy");
          return jsonResponse({ appId: row.appSlug, ...result });
        } catch (error) {
          if (error instanceof BindingNotReadyError) {
            return jsonResponse(
              {
                error:
                  "The gateway can't reach the app yet (its binding is still rolling out). Retry shortly.",
                code: "BINDING_NOT_READY",
              },
              503,
            );
          }
          throw error;
        }
      },
    },
  },
});
