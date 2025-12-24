import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/client";
import { ProgramService } from "@/server/services/ProgramService";
import {
  createProgramSchema,
  updateProgramSchema,
  createProgramFromTemplateSchema,
  createCustomProgramSchema,
} from "@/types/schemas/programs";

// List all user programs with their workouts and exercises
export const getAllPrograms = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return ProgramService.getAll(context.userId);
  });

// Create a new program
export const createProgram = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createProgramSchema.parse(data))
  .handler(async ({ data, context }) => {
    return ProgramService.create(context.userId, data);
  });

// Update program
export const updateProgram = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateProgramSchema.parse(data))
  .handler(async ({ data, context }) => {
    return ProgramService.update(context.userId, data);
  });

// Delete program
export const deleteProgram = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    return ProgramService.delete(context.userId, data.id);
  });

// Create program from template (atomically creates program, workouts, exercises)
export const createProgramFromTemplate = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    createProgramFromTemplateSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return ProgramService.createFromTemplate(context.userId, data);
  });

// Create custom program with initial workout
export const createCustomProgram = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createCustomProgramSchema.parse(data))
  .handler(async ({ data, context }) => {
    return ProgramService.createCustomProgram(context.userId, data);
  });
