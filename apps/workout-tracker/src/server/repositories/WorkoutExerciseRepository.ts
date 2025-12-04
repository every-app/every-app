import { db } from "@/db";
import { workoutExercises, workouts, programs } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Types for repository operations
type CreateWorkoutExercise = {
  id: string;
  workoutId: string;
  exerciseId: string;
  sets: number;
  targetReps: number;
  weight: number | null;
  sortOrder: number;
};

type UpdateWorkoutExercise = {
  id: string;
  sets?: number;
  targetReps?: number;
  weight?: number | null;
  sortOrder?: number;
};

/**
 * Find all workout exercises for a user (via workouts -> programs).
 */
async function findAllByUserId(userId: string) {
  const result = await db
    .select({ workoutExercise: workoutExercises })
    .from(workoutExercises)
    .innerJoin(workouts, eq(workoutExercises.workoutId, workouts.id))
    .innerJoin(programs, eq(workouts.programId, programs.id))
    .where(eq(programs.userId, userId));

  return result.map((r) => r.workoutExercise);
}

/**
 * Find workout exercises by IDs with their workout and program for ownership verification.
 */
async function findByIdsWithOwnership(ids: string[]) {
  if (ids.length === 0) return [];

  return db.query.workoutExercises.findMany({
    where: inArray(workoutExercises.id, ids),
    with: {
      workout: {
        with: { program: true },
      },
    },
  });
}

/**
 * Create multiple workout exercises in a batch.
 */
async function createBatch(items: CreateWorkoutExercise[]) {
  if (items.length === 0) return;

  const now = new Date().toISOString();

  const insertStatements = items.map((item) =>
    db.insert(workoutExercises).values({
      id: item.id,
      workoutId: item.workoutId,
      exerciseId: item.exerciseId,
      sets: item.sets,
      targetReps: item.targetReps,
      weight: item.weight,
      sortOrder: item.sortOrder,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const [first, ...rest] = insertStatements;
  await db.batch([first, ...rest]);
}

/**
 * Update multiple workout exercises in a batch.
 * Requires a map of exerciseId -> workoutId for defense-in-depth WHERE clause.
 */
async function updateBatch(
  items: UpdateWorkoutExercise[],
  authorizedExerciseWorkoutMap: Map<string, string>,
) {
  if (items.length === 0) return;

  const now = new Date().toISOString();

  const updateStatements = items.map((item) => {
    const { id, ...updates } = item;
    const verifiedWorkoutId = authorizedExerciseWorkoutMap.get(id);
    if (!verifiedWorkoutId) {
      throw new Error("Exercise not found in authorization map");
    }
    return db
      .update(workoutExercises)
      .set({ ...updates, updatedAt: now })
      .where(
        and(
          eq(workoutExercises.id, id),
          eq(workoutExercises.workoutId, verifiedWorkoutId),
        ),
      );
  });

  const [first, ...rest] = updateStatements;
  await db.batch([first, ...rest]);
}

/**
 * Delete multiple workout exercises by IDs.
 * Defense-in-depth: includes workoutIds in WHERE clause to ensure only authorized exercises are deleted.
 */
async function deleteBatch(ids: string[], authorizedWorkoutIds: Set<string>) {
  if (ids.length === 0) return;

  await db
    .delete(workoutExercises)
    .where(
      and(
        inArray(workoutExercises.id, ids),
        inArray(workoutExercises.workoutId, Array.from(authorizedWorkoutIds)),
      ),
    );
}

export const WorkoutExerciseRepository = {
  findAllByUserId,
  findByIdsWithOwnership,
  createBatch,
  updateBatch,
  deleteBatch,
} as const;
