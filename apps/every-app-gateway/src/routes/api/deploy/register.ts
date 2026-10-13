import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import { deployErrorResponse, readJsonBody } from "@/server/deploy-api";
import { AppRegistrationService } from "@/server/services/AppRegistrationService";

const registerAppSchema = z.object({
  appId: z.string().trim().min(1, "appId is required").max(128),
  name: z.string().trim().min(1, "name is required").max(120),
  description: z.string().trim().min(1, "description is required").max(500),
  // Only CLIs from before gateway-assigned names send one.
  workerName: z.string().trim().min(1).max(128).optional(),
  manifest: z.unknown(),
  cliVersion: z.string().max(64).optional(),
  sdkVersion: z.string().max(64).optional(),
});

export const Route = createFileRoute("/api/deploy/register")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { organizationId, createdBy } = context as DeployTokenContext;
        const body = await readJsonBody(request, registerAppSchema);
        if (!body.ok) return body.response;

        try {
          const result = await AppRegistrationService.register({
            organizationId,
            appSlug: body.data.appId,
            name: body.data.name,
            description: body.data.description,
            workerName: body.data.workerName,
            manifest: body.data.manifest,
            deployerUserId: createdBy,
          });
          return jsonResponse(result);
        } catch (error) {
          return deployErrorResponse(error);
        }
      },
    },
  },
});
