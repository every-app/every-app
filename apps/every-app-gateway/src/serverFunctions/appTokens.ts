import { createServerFn } from "@tanstack/react-start";
import { organizationOwnerMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AppTokenService } from "@/server/services/AppTokenService";
import {
  createAppTokenSchema,
  revokeAppTokenSchema,
} from "@/schemas/app-token";

/**
 * List all app tokens for owner management.
 * Organization-owner only.
 */
export const listAppTokens = createServerFn()
  .middleware([organizationOwnerMiddleware])
  .handler(async ({ context }) => {
    return AppTokenService.list(context.activeOrganizationId);
  });

/**
 * Create a new app token.
 * Organization-owner only.
 */
export const createAppToken = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) => createAppTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppTokenService.create(
      {
        appId: data.appId,
        scopes: data.scopes,
        expiresAt: data.expiresAt ?? null,
      },
      context.activeOrganizationId,
      context.user.id,
    );
  });

/**
 * Revoke an existing app token.
 * Organization-owner only.
 */
export const revokeAppToken = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) => revokeAppTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppTokenService.revoke(data.tokenId, context.activeOrganizationId);
  });
