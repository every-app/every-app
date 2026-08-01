import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { workoutSetLogs, workoutSessions } from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { upsertSetLogSchema } from "@/types/schemas/setLogs";

export const getAllSetLogs = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const result = await db
      .select({ log: workoutSetLogs })
      .from(workoutSetLogs)
      .innerJoin(
        workoutSessions,
        eq(workoutSetLogs.sessionId, workoutSessions.id),
      )
      .where(eq(workoutSessions.userId, context.userId));

    return { setLogs: result.map(({ log }) => log) };
  });

export const upsertSetLog = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => upsertSetLogSchema.parse(data))
  .handler(async ({ data, context }) => {
    const session = await db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.id, data.sessionId),
        eq(workoutSessions.userId, context.userId),
      ),
    });
    if (!session) throw new Error("Session not found or not authorized");

    const existing = await db.query.workoutSetLogs.findFirst({
      where: eq(workoutSetLogs.id, data.id),
      with: { session: true },
    });
    if (
      existing &&
      (existing.session.userId !== context.userId ||
        existing.sessionId !== data.sessionId)
    ) {
      throw new Error("Set log not authorized for this session");
    }

    await db
      .insert(workoutSetLogs)
      .values({
        id: data.id,
        sessionId: data.sessionId,
        exerciseId: data.exerciseId ?? null,
        exerciseNameSnapshot: data.exerciseNameSnapshot,
        setNumber: data.setNumber,
        targetReps: data.targetReps,
        actualReps: data.actualReps,
        weight: data.weight ?? null,
        sortOrder: data.sortOrder,
      })
      .onConflictDoUpdate({
        target: workoutSetLogs.id,
        set: { actualReps: data.actualReps },
      });

    return { success: true };
  });

export const deleteSetLog = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.workoutSetLogs.findFirst({
      where: eq(workoutSetLogs.id, data.id),
      with: { session: true },
    });
    if (!existing || existing.session.userId !== context.userId) {
      throw new Error("Set log not found or not authorized");
    }

    await db
      .delete(workoutSetLogs)
      .where(
        and(
          eq(workoutSetLogs.id, data.id),
          eq(workoutSetLogs.sessionId, existing.session.id),
        ),
      );

    return { success: true };
  });
