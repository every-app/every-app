import { createServerFn } from "@tanstack/react-start";
import { ownerMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AppTokenService } from "@/server/services/AppTokenService";
import {
  createAppTokenSchema,
  revokeAppTokenSchema,
} from "@/schemas/app-token";

/**
 * List all app tokens for admin management.
 * Owner-only.
 */
export const listAppTokens = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .handler(async () => {
    return AppTokenService.list();
  });

/**
 * Create a new app token.
 * Owner-only.
 */
export const createAppToken = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((data: unknown) => createAppTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppTokenService.create(
      {
        appId: data.appId,
        scopes: data.scopes,
        expiresAt: data.expiresAt ?? null,
      },
      context.user.id,
    );
  });

/**
 * Revoke an existing app token.
 * Owner-only.
 */
export const revokeAppToken = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((data: unknown) => revokeAppTokenSchema.parse(data))
  .handler(async ({ data }) => {
    return AppTokenService.revoke(data.tokenId);
  });
