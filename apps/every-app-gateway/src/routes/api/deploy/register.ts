import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";
import {
  AppRegistrationError,
  AppRegistrationService,
} from "@/server/services/AppRegistrationService";

const registerAppSchema = z.object({
  appId: z.string().trim().min(1, "appId is required").max(128),
  name: z.string().trim().min(1, "name is required").max(120),
  description: z.string().trim().min(1, "description is required").max(500),
  workerName: z.string().trim().min(1, "workerName is required").max(128),
  manifest: z.unknown(),
});

function registrationErrorResponse(error: unknown): Response {
  if (error instanceof AppRegistrationError) {
    return jsonResponse(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      },
      error.status,
    );
  }

  throw error;
}

export const Route = createFileRoute("/api/deploy/register")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { organizationId } = context as DeployTokenContext;
        let rawBody: unknown;
        try {
          rawBody = await request.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON payload" }, 400);
        }

        const parsed = registerAppSchema.safeParse(rawBody);
        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          return jsonResponse(
            {
              error: firstIssue?.message || "Invalid request payload",
            },
            400,
          );
        }

        try {
          const result = await AppRegistrationService.register({
            organizationId,
            appSlug: parsed.data.appId,
            name: parsed.data.name,
            description: parsed.data.description,
            workerName: parsed.data.workerName,
            manifest: parsed.data.manifest,
          });
          return jsonResponse(result);
        } catch (error) {
          return registrationErrorResponse(error);
        }
      },
    },
  },
});
