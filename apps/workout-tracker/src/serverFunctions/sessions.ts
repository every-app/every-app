import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  exerciseLibrary,
  programs,
  workoutExercises,
  workoutSessions,
  workoutSetLogs,
  workouts,
} from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  calculateLinearProgressionUpdates,
  calculateSmartProgressionUpdates,
  getExercisesToProgress,
  type SetLogData,
  type WeightUpdate,
  type WorkoutExerciseData,
} from "@/client/lib/progression";
import {
  completeSessionSchema,
  createSessionSchema,
  skipToWorkoutSchema,
  updateSessionSchema,
} from "@/types/schemas/sessions";

type ProgressionContext = {
  exercisesToProgress: string[];
  incrementMap: Map<string, number>;
  allWorkoutExercises: WorkoutExerciseData[];
};

async function getProgressionContext(
  userId: string,
  sessionId: string,
  programId: string,
): Promise<ProgressionContext | null> {
  const setLogs = await db.query.workoutSetLogs.findMany({
    where: eq(workoutSetLogs.sessionId, sessionId),
  });
  if (setLogs.length === 0) return null;

  const validLogs: SetLogData[] = setLogs
    .filter((log) => log.exerciseId !== null)
    .map((log) => ({
      exerciseId: log.exerciseId!,
      targetReps: log.targetReps,
      actualReps: log.actualReps,
      weight: log.weight,
    }));
  const exercisesToProgress = getExercisesToProgress(validLogs);
  if (exercisesToProgress.length === 0) return null;

  const libraryItems = await db.query.exerciseLibrary.findMany({
    where: and(
      inArray(exerciseLibrary.id, exercisesToProgress),
      eq(exerciseLibrary.userId, userId),
    ),
  });
  const incrementMap = new Map(
    libraryItems.map((item) => [item.id, item.progressionIncrement]),
  );

  const allWorkoutExercises = await db
    .select({
      id: workoutExercises.id,
      exerciseId: workoutExercises.exerciseId,
      targetReps: workoutExercises.targetReps,
      weight: workoutExercises.weight,
      workoutId: workoutExercises.workoutId,
    })
    .from(workoutExercises)
    .innerJoin(workouts, eq(workoutExercises.workoutId, workouts.id))
    .innerJoin(programs, eq(workouts.programId, programs.id))
    .where(
      and(
        eq(workouts.programId, programId),
        eq(programs.userId, userId),
        inArray(workoutExercises.exerciseId, exercisesToProgress),
      ),
    );

  return { exercisesToProgress, incrementMap, allWorkoutExercises };
}

async function applyWeightUpdates(updates: WeightUpdate[]) {
  if (updates.length === 0) return;

  const now = new Date().toISOString();
  const statements = updates.map((update) =>
    db
      .update(workoutExercises)
      .set({ weight: update.newWeight, updatedAt: now })
      .where(
        and(
          eq(workoutExercises.id, update.id),
          eq(workoutExercises.workoutId, update.workoutId),
        ),
      ),
  );
  const [first, ...rest] = statements;
  await db.batch([first, ...rest]);
}

async function applyProgression(
  userId: string,
  sessionId: string,
  programId: string,
  workoutId: string,
) {
  const program = await db.query.programs.findFirst({
    where: and(eq(programs.id, programId), eq(programs.userId, userId)),
  });
  if (!program) return;

  const context = await getProgressionContext(userId, sessionId, programId);
  if (!context) return;

  const updates =
    program.progressionMode === "linear"
      ? calculateLinearProgressionUpdates(
          context.allWorkoutExercises,
          context.exercisesToProgress,
          context.incrementMap,
        )
      : calculateSmartProgressionUpdates(
          context.allWorkoutExercises,
          context.exercisesToProgress,
          workoutId,
          context.incrementMap,
        );
  await applyWeightUpdates(updates);
}

export const getAllSessions = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const sessions = await db.query.workoutSessions.findMany({
      where: eq(workoutSessions.userId, context.userId),
      orderBy: [desc(workoutSessions.startedAt)],
      with: {
        workoutSetLogs: {
          orderBy: (setLogs, { asc }) => [asc(setLogs.sortOrder)],
        },
      },
    });

    return { sessions };
  });

export const createSession = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => createSessionSchema.parse(data))
  .handler(async ({ data, context }) => {
    if (data.status === "in_progress") {
      const activeSession = await db.query.workoutSessions.findFirst({
        where: and(
          eq(workoutSessions.workoutId, data.workoutId),
          eq(workoutSessions.status, "in_progress"),
        ),
      });
      if (activeSession) {
        throw new Error(
          "This workout already has an active session. Complete or abandon it first.",
        );
      }
    }

    const program = await db.query.programs.findFirst({
      where: and(
        eq(programs.id, data.programId),
        eq(programs.userId, context.userId),
      ),
    });
    if (!program) throw new Error("Program not found or not authorized");

    await db.insert(workoutSessions).values({
      id: data.id,
      userId: context.userId,
      programId: data.programId,
      workoutId: data.workoutId,
      programNameSnapshot: data.programNameSnapshot,
      workoutNameSnapshot: data.workoutNameSnapshot,
      status: data.status,
      startedAt: new Date().toISOString(),
    });

    return { success: true };
  });

export const updateSession = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => updateSessionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.id, data.id),
        eq(workoutSessions.userId, context.userId),
      ),
    });
    if (!existing) throw new Error("Session not found or not authorized");

    const { id, ...updates } = data;
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
  });

export const completeWorkoutSession = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => completeSessionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const session = await db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.id, data.sessionId),
        eq(workoutSessions.userId, context.userId),
      ),
    });
    if (!session) throw new Error("Session not found or not authorized");

    const program = await db.query.programs.findFirst({
      where: and(
        eq(programs.id, data.programId),
        eq(programs.userId, context.userId),
      ),
    });
    if (!program) throw new Error("Program not found or not authorized");

    const now = new Date().toISOString();
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

    if (session.workoutId) {
      await applyProgression(
        context.userId,
        data.sessionId,
        data.programId,
        session.workoutId,
      );
    }

    return { success: true };
  });

export const deleteSession = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.id, data.id),
        eq(workoutSessions.userId, context.userId),
      ),
    });
    if (!existing) throw new Error("Session not found or not authorized");

    await db
      .delete(workoutSessions)
      .where(
        and(
          eq(workoutSessions.id, data.id),
          eq(workoutSessions.userId, context.userId),
        ),
      );

    return { success: true };
  });

export const skipToWorkout = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => skipToWorkoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    const program = await db.query.programs.findFirst({
      where: and(
        eq(programs.id, data.programId),
        eq(programs.userId, context.userId),
      ),
    });
    if (!program) throw new Error("Program not found or not authorized");

    if (data.sessionIdToAbandon) {
      const session = await db.query.workoutSessions.findFirst({
        where: and(
          eq(workoutSessions.id, data.sessionIdToAbandon),
          eq(workoutSessions.userId, context.userId),
        ),
      });
      if (!session) throw new Error("Session not found or not authorized");
    }

    const now = new Date().toISOString();
    const programUpdate = db
      .update(programs)
      .set({ currentWorkoutIndex: data.targetWorkoutIndex, updatedAt: now })
      .where(
        and(
          eq(programs.id, data.programId),
          eq(programs.userId, context.userId),
        ),
      );

    if (data.sessionIdToAbandon) {
      await db.batch([
        db
          .update(workoutSessions)
          .set({ status: "abandoned", completedAt: now })
          .where(
            and(
              eq(workoutSessions.id, data.sessionIdToAbandon),
              eq(workoutSessions.userId, context.userId),
            ),
          ),
        programUpdate,
      ]);
    } else {
      await programUpdate;
    }

    return { success: true };
  });
