import { createServerFn } from "@tanstack/react-start";
import {
  organizationAdminMiddleware,
  organizationOwnerMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AppTokenService } from "@/server/services/AppTokenService";
import {
  createAppTokenSchema,
  revokeAppTokenSchema,
} from "@/schemas/app-token";

/**
 * List all app tokens for admin visibility.
 * Organization-admin and owner only.
 */
export const listAppTokens = createServerFn()
  .middleware([organizationAdminMiddleware])
  .handler(async ({ context }) => {
    return AppTokenService.list(context.org.orgId);
  });

/**
 * Create a new deploy token.
 * Organization-owner only.
 */
export const createAppToken = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) => createAppTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppTokenService.issueDeployToken({
      organizationId: context.org.orgId,
      createdBy: context.user.id,
      expiresAt: data.expiresAt ?? null,
    });
  });

/**
 * Revoke an existing app token.
 * Organization-owner only.
 */
export const revokeAppToken = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) => revokeAppTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppTokenService.revoke(data.tokenId, context.org.orgId);
  });
