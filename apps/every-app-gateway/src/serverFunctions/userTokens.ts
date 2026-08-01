import { createServerFn } from "@tanstack/react-start";
import { organizationMemberMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { UserPatService } from "@/server/services/UserPatService";
import {
  createUserTokenSchema,
  revokeUserTokenSchema,
} from "@/schemas/user-token";

export const listUserTokens = createServerFn()
  .middleware([organizationMemberMiddleware])
  .handler(async ({ context }) => {
    return UserPatService.listForUser(context.user.id, context.org.orgId);
  });

export const createUserToken = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .inputValidator((data: unknown) => createUserTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return UserPatService.create({
      userId: context.user.id,
      organizationId: context.org.orgId,
      appRowId: data.appId ?? null,
      name: data.name,
      scopes: data.scopes,
      expiresAt: data.expiresAt ?? null,
    });
  });

export const revokeUserToken = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .inputValidator((data: unknown) => revokeUserTokenSchema.parse(data))
  .handler(async ({ data, context }) => {
    return UserPatService.revoke(data.tokenId, context.user.id);
  });
