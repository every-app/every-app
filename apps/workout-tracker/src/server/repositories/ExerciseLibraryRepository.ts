import { db } from "@/db";
import { exerciseLibrary } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Types for repository operations
type CreateExerciseLibraryItem = {
  id: string;
  userId: string;
  name: string;
  notes: string | null;
};

type UpdateExerciseLibraryItem = {
  id: string;
  name?: string;
  notes?: string | null;
};

/**
 * Find all exercise library items for a user.
 */
async function findAllByUserId(userId: string) {
  return db.query.exerciseLibrary.findMany({
    where: eq(exerciseLibrary.userId, userId),
  });
}

/**
 * Find exercise library items by IDs for a specific user.
 * Used for ownership verification before batch operations.
 */
async function findByIdsAndUserId(ids: string[], userId: string) {
  if (ids.length === 0) return [];

  return db.query.exerciseLibrary.findMany({
    where: and(
      inArray(exerciseLibrary.id, ids),
      eq(exerciseLibrary.userId, userId),
    ),
  });
}

/**
 * Create multiple exercise library items in a batch.
 */
async function createBatch(items: CreateExerciseLibraryItem[]) {
  if (items.length === 0) return;

  const now = new Date().toISOString();

  const insertStatements = items.map((item) =>
    db.insert(exerciseLibrary).values({
      id: item.id,
      userId: item.userId,
      name: item.name,
      notes: item.notes,
      createdAt: now,
      updatedAt: now,
    }),
  );

  const [first, ...rest] = insertStatements;
  await db.batch([first, ...rest]);
}

/**
 * Update multiple exercise library items in a batch.
 */
async function updateBatch(items: UpdateExerciseLibraryItem[], userId: string) {
  if (items.length === 0) return;

  const now = new Date().toISOString();

  const updateStatements = items.map((item) => {
    const { id, ...updates } = item;
    return db
      .update(exerciseLibrary)
      .set({ ...updates, updatedAt: now })
      .where(
        and(eq(exerciseLibrary.id, id), eq(exerciseLibrary.userId, userId)),
      );
  });

  const [first, ...rest] = updateStatements;
  await db.batch([first, ...rest]);
}

/**
 * Delete multiple exercise library items by IDs.
 * Note: Will fail if any exercise is referenced by workout_exercises (FK RESTRICT).
 */
async function deleteBatch(ids: string[], userId: string) {
  if (ids.length === 0) return;

  await db
    .delete(exerciseLibrary)
    .where(
      and(inArray(exerciseLibrary.id, ids), eq(exerciseLibrary.userId, userId)),
    );
}

export const ExerciseLibraryRepository = {
  findAllByUserId,
  findByIdsAndUserId,
  createBatch,
  updateBatch,
  deleteBatch,
} as const;
