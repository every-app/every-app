import { db } from "@/db";
import { workouts, programs, workoutExercises } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Types for repository operations
type CreateWorkout = {
  id: string;
  programId: string;
  name: string;
  description?: string | null;
  sortOrder: number;
};

type UpdateWorkout = {
  name?: string;
  description?: string;
  sortOrder?: number;
};

/**
 * Find all workouts for a user (via programs).
 */
async function findAllByUserId(userId: string) {
  const result = await db
    .select({ workout: workouts })
    .from(workouts)
    .innerJoin(programs, eq(workouts.programId, programs.id))
    .where(eq(programs.userId, userId));

  return result.map((r) => r.workout);
}

/**
 * Find a workout by ID with its program for ownership verification.
 */
async function findByIdWithProgram(id: string) {
  return db.query.workouts.findFirst({
    where: eq(workouts.id, id),
    with: { program: true },
  });
}

/**
 * Find workouts by program IDs for ownership verification.
 */
async function findByProgramIds(programIds: string[]) {
  if (programIds.length === 0) return [];

  return db.query.workouts.findMany({
    where: inArray(workouts.programId, programIds),
    with: { program: true },
  });
}

/**
 * Create multiple workouts in a batch.
 */
async function createBatch(items: CreateWorkout[]) {
  if (items.length === 0) return;

  const now = new Date().toISOString();

  const insertStatements = items.map((item) =>
    db.insert(workouts).values({
      id: item.id,
      programId: item.programId,
      name: item.name,
      description: item.description ?? null,
      sortOrder: item.sortOrder,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const [first, ...rest] = insertStatements;
  await db.batch([first, ...rest]);
}

/**
 * Update a workout.
 * Defense-in-depth: includes programId in WHERE clause.
 */
async function update(id: string, programId: string, data: UpdateWorkout) {
  await db
    .update(workouts)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(workouts.id, id), eq(workouts.programId, programId)));
}

/**
 * Delete a workout.
 * Defense-in-depth: includes programId in WHERE clause.
 */
async function deleteById(id: string, programId: string) {
  await db
    .delete(workouts)
    .where(and(eq(workouts.id, id), eq(workouts.programId, programId)));
}

/**
 * Delete a workout with all its exercises atomically.
 * Defense-in-depth: includes programId in WHERE clause.
 */
async function deleteWithExercises(
  workoutId: string,
  programId: string,
  exerciseIds: string[],
) {
  const deleteWorkoutStmt = db
    .delete(workouts)
    .where(and(eq(workouts.id, workoutId), eq(workouts.programId, programId)));

  if (exerciseIds.length > 0) {
    const deleteExercisesStmt = db
      .delete(workoutExercises)
      .where(
        and(
          inArray(workoutExercises.id, exerciseIds),
          eq(workoutExercises.workoutId, workoutId),
        ),
      );

    await db.batch([deleteExercisesStmt, deleteWorkoutStmt]);
  } else {
    await deleteWorkoutStmt;
  }
}

export const WorkoutRepository = {
  findAllByUserId,
  findByIdWithProgram,
  findByProgramIds,
  createBatch,
  update,
  delete: deleteById,
  deleteWithExercises,
} as const;
