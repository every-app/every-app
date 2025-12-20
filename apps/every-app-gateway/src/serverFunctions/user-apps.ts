import { createServerFn } from "@tanstack/react-start";
import z from "zod";
import { authMiddleware } from "@/middleware/auth";
import { UserAppService } from "@/server/services/UserAppService";

export const getUserApps = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return UserAppService.getAll(context.user.id);
  });

const createUserAppSchema = z.object({
  appId: z.string().min(1, "App ID is required"),
  name: z.string().min(1, "Name is required").max(255, "Name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Invalid URL format"),
});

export const createUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => createUserAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return UserAppService.create(context.user.id, app);
  });

const updateUserAppSchema = z.object({
  id: z.string().uuid("Invalid app ID"),
  name: z.string().min(1, "Name is required").max(255, "Name too long"),
  description: z
    .string()
    .min(1, "Description is required")
    .max(1000, "Description too long"),
  appUrl: z.string().url("Invalid URL format"),
});

export const updateUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => updateUserAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return UserAppService.update(context.user.id, app);
  });

const deleteUserAppSchema = z.object({
  id: z.string().uuid("Invalid app ID"),
});

export const deleteUserApp = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((app: unknown) => deleteUserAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return UserAppService.delete(context.user.id, app.id);
  });
