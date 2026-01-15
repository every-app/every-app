import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/tanstack";
import { SetLogService } from "@/server/services/SetLogService";
import {
  createSetLogSchema,
  updateSetLogSchema,
} from "@/types/schemas/setLogs";

// Get all set logs for user's sessions
export const getAllSetLogs = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return SetLogService.getAll(context.userId);
  });

// Create set log
export const createSetLog = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createSetLogSchema.parse(data))
  .handler(async ({ data, context }) => {
    return SetLogService.create(context.userId, data);
  });

// Update set log (for updating reps during workout)
export const updateSetLog = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateSetLogSchema.parse(data))
  .handler(async ({ data, context }) => {
    return SetLogService.update(context.userId, data);
  });

// Delete set log
export const deleteSetLog = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    return SetLogService.delete(context.userId, data.id);
  });
