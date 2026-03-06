import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import {
  jsonResponse,
  internalCloudflareAuthMiddleware,
} from "@/server/internal-cloudflare-auth";

const organizationQuerySchema = z.object({
  organizationId: z.string().trim().min(1, "organizationId is required"),
});

export const Route = createFileRoute("/api/internal/apps/users")({
  server: {
    middleware: [internalCloudflareAuthMiddleware],
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const parsed = organizationQuerySchema.safeParse({
          organizationId: url.searchParams.get("organizationId"),
        });

        if (!parsed.success) {
          return jsonResponse(
            {
              error: parsed.error.issues[0]?.message || "Invalid request",
            },
            400,
          );
        }

        const users =
          await OrganizationMembersRepository.listMembersForOrganization(
            parsed.data.organizationId,
          );
        return jsonResponse({
          users: users.map((user) => ({
            id: user.id,
            name: user.name,
            email: user.email,
          })),
        });
      },
    },
  },
});
