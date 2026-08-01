import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import {
  deployTokenAuthMiddleware,
  jsonResponse,
  type DeployTokenContext,
} from "@/server/deploy-token-auth";

export const Route = createFileRoute("/api/deploy/whoami")({
  server: {
    middleware: [deployTokenAuthMiddleware],
    handlers: {
      GET: async ({ context }) => {
        const { organizationId, scopes } = context as DeployTokenContext;
        const rows = await db
          .select({
            name: organizations.name,
          })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1);

        return jsonResponse({
          organizationId,
          organizationName: rows[0]?.name ?? organizationId,
          scopes,
          capabilities: {
            appGateway: true,
          },
        });
      },
    },
  },
});
