import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { organizationMemberMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";

const revokeOauthGrantSchema = z.object({
  grantId: z.string().min(1),
});

type GrantMetadata = {
  clientName?: string;
  appName?: string;
  appSlug?: string;
};

function metadata(value: unknown): GrantMetadata {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    clientName:
      typeof record.clientName === "string" ? record.clientName : undefined,
    appName: typeof record.appName === "string" ? record.appName : undefined,
    appSlug: typeof record.appSlug === "string" ? record.appSlug : undefined,
  };
}

export const listMyOauthGrants = createServerFn()
  .middleware([organizationMemberMiddleware])
  .handler(async ({ context }) => {
    const grants = await env.OAUTH_PROVIDER.listUserGrants(context.user.id);
    return {
      grants: grants.items.map((grant) => {
        const meta = metadata(grant.metadata);
        return {
          id: grant.id,
          clientId: grant.clientId,
          clientName: meta.clientName ?? grant.clientId,
          appName: meta.appName ?? meta.appSlug ?? "Unknown app",
          appSlug: meta.appSlug ?? null,
          scopes: grant.scope,
          createdAt: new Date(grant.createdAt * 1000).toISOString(),
          expiresAt: grant.expiresAt
            ? new Date(grant.expiresAt * 1000).toISOString()
            : null,
        };
      }),
      cursor: grants.cursor,
    };
  });

export const revokeMyOauthGrant = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .inputValidator((data: unknown) => revokeOauthGrantSchema.parse(data))
  .handler(async ({ data, context }) => {
    await env.OAUTH_PROVIDER.revokeGrant(data.grantId, context.user.id);
    return { ok: true };
  });
