import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/middleware/auth";
import { UserAppService } from "@/server/services/UserAppService";
import {
  createUserAppSchema,
  updateUserAppSchema,
  deleteUserAppSchema,
} from "@/schemas/user-app";

export const getUserApps = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return UserAppService.getAll(context.user.id);
  });

export const createUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => createUserAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return UserAppService.create(context.user.id, app);
  });

export const updateUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => updateUserAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return UserAppService.update(context.user.id, app);
  });

export const deleteUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => deleteUserAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return UserAppService.delete(context.user.id, app.id);
  });
