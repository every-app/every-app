import { createFileRoute } from "@tanstack/react-router";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import {
  jsonResponse,
  internalCloudflareAuthMiddleware,
} from "@/server/internal-cloudflare-auth";

export const Route = createFileRoute("/api/internal/apps/organizations" as any)(
  {
    server: {
      middleware: [internalCloudflareAuthMiddleware],
      handlers: {
        GET: async () => {
          const rows = await db
            .select({
              id: organizations.id,
              name: organizations.name,
              slug: organizations.slug,
            })
            .from(organizations)
            .orderBy(asc(organizations.createdAt));

          return jsonResponse({ organizations: rows });
        },
      },
    },
  },
);
