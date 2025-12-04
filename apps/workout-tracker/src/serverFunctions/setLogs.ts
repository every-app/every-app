import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db";
import { workoutSetLogs, workoutSessions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  ensureUserMiddleware,
  type AuthenticatedContext,
} from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";

// Get all set logs for user's sessions
export const getAllSetLogs = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: AuthenticatedContext }) => {
    const result = await db
      .select({ log: workoutSetLogs })
      .from(workoutSetLogs)
      .innerJoin(
        workoutSessions,
        eq(workoutSetLogs.sessionId, workoutSessions.id),
      )
      .where(eq(workoutSessions.userId, context.userId));

    return { setLogs: result.map((r) => r.log) };
  });

// Create set log
const createSetLogSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  exerciseId: z.string().nullable().optional(),
  exerciseNameSnapshot: z.string(),
  setNumber: z.number(),
  targetReps: z.number(),
  actualReps: z.number(),
  weight: z.number().nullable().optional(),
  sortOrder: z.number(),
});

export type CreateSetLogInput = z.infer<typeof createSetLogSchema>;

export const createSetLog = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createSetLogSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateSetLogInput;
      context: AuthenticatedContext;
    }) => {
      // Verify session ownership
      const session = await db.query.workoutSessions.findFirst({
        where: and(
          eq(workoutSessions.id, data.sessionId),
          eq(workoutSessions.userId, context.userId),
        ),
      });

      if (!session) {
        throw new Error("Session not found or not authorized");
      }

      await db.insert(workoutSetLogs).values({
        id: data.id,
        sessionId: data.sessionId,
        exerciseId: data.exerciseId ?? null,
        exerciseNameSnapshot: data.exerciseNameSnapshot,
        setNumber: data.setNumber,
        targetReps: data.targetReps,
        actualReps: data.actualReps,
        weight: data.weight ?? null,
        sortOrder: data.sortOrder,
      });

      return { success: true };
    },
  );

// Update set log (for updating reps during workout)
const updateSetLogSchema = z.object({
  id: z.string(),
  actualReps: z.number(),
});

export type UpdateSetLogInput = z.infer<typeof updateSetLogSchema>;

export const updateSetLog = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateSetLogSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: UpdateSetLogInput;
      context: AuthenticatedContext;
    }) => {
      // Verify ownership via session
      const log = await db.query.workoutSetLogs.findFirst({
        where: eq(workoutSetLogs.id, data.id),
        with: { session: true },
      });

      if (!log || log.session.userId !== context.userId) {
        throw new Error("Set log not found or not authorized");
      }

      // Defense-in-depth: include session ownership check in WHERE clause via subquery
      await db
        .update(workoutSetLogs)
        .set({
          actualReps: data.actualReps,
        })
        .where(
          and(
            eq(workoutSetLogs.id, data.id),
            eq(workoutSetLogs.sessionId, log.session.id),
          ),
        );

      return { success: true };
    },
  );

// Delete set log
export const deleteSetLog = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: { id: string };
      context: AuthenticatedContext;
    }) => {
      // Verify ownership via session
      const log = await db.query.workoutSetLogs.findFirst({
        where: eq(workoutSetLogs.id, data.id),
        with: { session: true },
      });

      if (!log || log.session.userId !== context.userId) {
        throw new Error("Set log not found or not authorized");
      }

      await db.delete(workoutSetLogs).where(eq(workoutSetLogs.id, data.id));
      return { success: true };
    },
  );
