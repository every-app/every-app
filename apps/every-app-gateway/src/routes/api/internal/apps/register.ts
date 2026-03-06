import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { AppAccessService } from "@/server/services/AppAccessService";
import {
  jsonResponse,
  internalCloudflareAuthMiddleware,
} from "@/server/internal-cloudflare-auth";

const registerAppSchema = z.object({
  organizationId: z.string().trim().min(1, "organizationId is required"),
  appId: z
    .string()
    .trim()
    .min(1, "appId is required")
    .max(128, "appId is too long")
    .regex(
      /^[a-z0-9-]+$/,
      "appId must contain only lowercase letters, numbers, and hyphens",
    ),
  appUrl: z.string().url("appUrl must be a valid URL"),
  name: z.string().trim().min(1, "name is required").max(120),
  description: z.string().trim().min(1, "description is required").max(500),
  devUrl: z.string().url().optional(),
  isDefault: z.boolean(),
  accessMode: z.enum(["all", "select", "none"]),
  selectedUserIds: z.array(z.string()).optional(),
});

const registerLookupSchema = z.object({
  organizationId: z.string().trim().min(1, "organizationId is required"),
  appId: z
    .string()
    .trim()
    .min(1, "appId is required")
    .max(128, "appId is too long")
    .regex(
      /^[a-z0-9-]+$/,
      "appId must contain only lowercase letters, numbers, and hyphens",
    ),
});

function resolveAccessUserIds(
  mode: "all" | "select" | "none",
  selectedUserIds: string[] | undefined,
  allUserIds: string[],
): string[] {
  if (mode === "all") {
    return allUserIds;
  }

  if (mode === "select") {
    if (!selectedUserIds) {
      return [];
    }

    const allowedUserIds = new Set(allUserIds);
    return selectedUserIds.filter((id) => allowedUserIds.has(id));
  }

  return [];
}

export const Route = createFileRoute("/api/internal/apps/register")({
  server: {
    middleware: [internalCloudflareAuthMiddleware],
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const parsed = registerLookupSchema.safeParse({
          organizationId: url.searchParams.get("organizationId"),
          appId: url.searchParams.get("appId"),
        });

        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          return jsonResponse(
            {
              error: firstIssue?.message || "Invalid request payload",
            },
            400,
          );
        }

        const existingApp = await AppRepository.findByAppId(
          parsed.data.appId,
          parsed.data.organizationId,
        );
        return jsonResponse({
          existingApp: Boolean(existingApp),
          defaultAccess: Boolean(existingApp?.isDefault),
        });
      },
      POST: async ({ request }) => {
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

        const payload = parsed.data;

        const [allUsers, existingApp] = await Promise.all([
          OrganizationMembersRepository.listMembersForOrganization(
            payload.organizationId,
          ),
          AppRepository.findByAppId(payload.appId, payload.organizationId),
        ]);

        const ownerUserIds = allUsers
          .filter((user) => user.role === "owner")
          .map((user) => user.id);

        const appId = existingApp?.id ?? crypto.randomUUID();

        if (existingApp) {
          await AppRepository.update(existingApp.id, {
            organizationId: payload.organizationId,
            name: payload.name,
            description: payload.description,
            appUrl: payload.appUrl,
            devUrl: payload.devUrl ?? existingApp.devUrl ?? null,
            isDefault: payload.isDefault,
          });
        } else {
          await AppRepository.create({
            id: appId,
            organizationId: payload.organizationId,
            appId: payload.appId,
            name: payload.name,
            description: payload.description,
            appUrl: payload.appUrl,
            devUrl: payload.devUrl ?? null,
            isDefault: payload.isDefault,
          });
        }

        const accessUserIds = resolveAccessUserIds(
          payload.accessMode,
          payload.selectedUserIds,
          allUsers.map((user) => user.id),
        );
        const accessUserIdsWithOwners = Array.from(
          new Set(ownerUserIds.concat(accessUserIds)),
        );

        if (
          payload.accessMode !== "none" ||
          (!existingApp && ownerUserIds.length > 0)
        ) {
          await AppAccessService.updateAccessForApp(
            appId,
            payload.organizationId,
            accessUserIdsWithOwners,
            null,
          );
        }

        return jsonResponse({
          appId,
          appSlug: payload.appId,
          existingApp: Boolean(existingApp),
          defaultAccess: payload.isDefault,
          grantedUserCount: accessUserIdsWithOwners.length,
        });
      },
    },
  },
});
