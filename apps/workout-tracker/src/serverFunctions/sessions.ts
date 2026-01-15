import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/tanstack";
import { SessionService } from "@/server/services/SessionService";
import {
  createSessionSchema,
  updateSessionSchema,
  completeSessionSchema,
  skipToWorkoutSchema,
} from "@/types/schemas/sessions";

// Get all workout sessions for user
export const getAllSessions = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return SessionService.getAll(context.userId);
  });

// Create session
export const createSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createSessionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return SessionService.create(context.userId, data);
  });

// Update session
export const updateSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateSessionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return SessionService.update(context.userId, data);
  });

// Complete workout session (atomically updates session and advances program)
export const completeWorkoutSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => completeSessionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return SessionService.complete(context.userId, data);
  });

// Delete session
export const deleteSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    return SessionService.delete(context.userId, data.id);
  });

// Skip to a specific workout (optionally abandoning in-progress session)
export const skipToWorkout = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => skipToWorkoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    return SessionService.skipToWorkout(context.userId, data);
  });
