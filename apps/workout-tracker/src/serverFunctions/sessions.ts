import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db";
import { workoutSessions, programs } from "@/db/schema";
import { and, eq, desc } from "drizzle-orm";
import {
  ensureUserMiddleware,
  type AuthenticatedContext,
} from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";

// Get all workout sessions for user
export const getAllSessions = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: AuthenticatedContext }) => {
    const sessions = await db.query.workoutSessions.findMany({
      where: eq(workoutSessions.userId, context.userId),
      orderBy: [desc(workoutSessions.startedAt)],
      with: {
        workoutSetLogs: {
          orderBy: (workoutSetLogs, { asc }) => [asc(workoutSetLogs.sortOrder)],
        },
      },
    });

    return { sessions };
  });

// Create session
const createSessionSchema = z.object({
  id: z.string(),
  programId: z.string(),
  workoutId: z.string(),
  programNameSnapshot: z.string(),
  workoutNameSnapshot: z.string(),
  status: z
    .enum(["in_progress", "completed", "abandoned"])
    .default("in_progress"),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const createSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createSessionSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateSessionInput;
      context: AuthenticatedContext;
    }) => {
      // Check for existing in-progress session for this workout
      if (data.status === "in_progress") {
        const existingSession = await db.query.workoutSessions.findFirst({
          where: and(
            eq(workoutSessions.workoutId, data.workoutId),
            eq(workoutSessions.status, "in_progress"),
          ),
        });

        if (existingSession) {
          throw new Error(
            "This workout already has an active session. Complete or abandon it first.",
          );
        }
      }

      // Verify program ownership
      const program = await db.query.programs.findFirst({
        where: and(
          eq(programs.id, data.programId),
          eq(programs.userId, context.userId),
        ),
      });

      if (!program) {
        throw new Error("Program not found or not authorized");
      }

      const now = new Date().toISOString();
      await db.insert(workoutSessions).values({
        id: data.id,
        userId: context.userId,
        programId: data.programId,
        workoutId: data.workoutId,
        programNameSnapshot: data.programNameSnapshot,
        workoutNameSnapshot: data.workoutNameSnapshot,
        status: data.status,
        startedAt: now,
      });

      return { success: true };
    },
  );

// Update session
const updateSessionSchema = z.object({
  id: z.string(),
  status: z.enum(["in_progress", "completed", "abandoned"]).optional(),
  completedAt: z.string().optional(),
});

export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

export const updateSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateSessionSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: UpdateSessionInput;
      context: AuthenticatedContext;
    }) => {
      const session = await db.query.workoutSessions.findFirst({
        where: and(
          eq(workoutSessions.id, data.id),
          eq(workoutSessions.userId, context.userId),
        ),
      });

      if (!session) {
        throw new Error("Session not found or not authorized");
      }

      const { id, ...updates } = data;
      // Defense-in-depth: include userId in WHERE clause
      await db
        .update(workoutSessions)
        .set(updates)
        .where(
          and(
            eq(workoutSessions.id, id),
            eq(workoutSessions.userId, context.userId),
          ),
        );

      return { success: true };
    },
  );

// Complete workout session (atomically updates session and advances program)
const completeWorkoutSessionSchema = z.object({
  sessionId: z.string(),
  programId: z.string(),
  nextWorkoutIndex: z.number(),
});

type CompleteWorkoutSessionInput = z.infer<typeof completeWorkoutSessionSchema>;

export const completeWorkoutSession = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => completeWorkoutSessionSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: CompleteWorkoutSessionInput;
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

      // Verify program ownership
      const program = await db.query.programs.findFirst({
        where: and(
          eq(programs.id, data.programId),
          eq(programs.userId, context.userId),
        ),
      });

      if (!program) {
        throw new Error("Program not found or not authorized");
      }

      const now = new Date().toISOString();

      // Atomically update both session and program
      await db.batch([
        db
          .update(workoutSessions)
          .set({ status: "completed", completedAt: now })
          .where(
            and(
              eq(workoutSessions.id, data.sessionId),
              eq(workoutSessions.userId, context.userId),
            ),
          ),
        db
          .update(programs)
          .set({ currentWorkoutIndex: data.nextWorkoutIndex, updatedAt: now })
          .where(
            and(
              eq(programs.id, data.programId),
              eq(programs.userId, context.userId),
            ),
          ),
      ]);

      return { success: true };
    },
  );

// Delete session
export const deleteSession = createServerFn({ method: "POST" })
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
      const session = await db.query.workoutSessions.findFirst({
        where: and(
          eq(workoutSessions.id, data.id),
          eq(workoutSessions.userId, context.userId),
        ),
      });

      if (!session) {
        throw new Error("Session not found or not authorized");
      }

      // Defense-in-depth: include userId in WHERE clause
      await db
        .delete(workoutSessions)
        .where(
          and(
            eq(workoutSessions.id, data.id),
            eq(workoutSessions.userId, context.userId),
          ),
        );
      return { success: true };
    },
  );
