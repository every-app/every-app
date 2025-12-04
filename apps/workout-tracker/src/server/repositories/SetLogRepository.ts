import { db } from "@/db";
import { workoutSetLogs, workoutSessions } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// Types for repository operations
type CreateSetLog = {
  id: string;
  sessionId: string;
  exerciseId: string | null;
  exerciseNameSnapshot: string;
  setNumber: number;
  targetReps: number;
  actualReps: number;
  weight: number | null;
  sortOrder: number;
};

type UpdateSetLog = {
  actualReps: number;
};

/**
 * Find all set logs for a user (via sessions).
 */
async function findAllByUserId(userId: string) {
  const result = await db
    .select({ log: workoutSetLogs })
    .from(workoutSetLogs)
    .innerJoin(
      workoutSessions,
      eq(workoutSetLogs.sessionId, workoutSessions.id),
    )
    .where(eq(workoutSessions.userId, userId));

  return result.map((r) => r.log);
}

/**
 * Find a set log by ID with its session for ownership verification.
 */
async function findByIdWithSession(id: string) {
  return db.query.workoutSetLogs.findFirst({
    where: eq(workoutSetLogs.id, id),
    with: { session: true },
  });
}

/**
 * Create a set log.
 */
async function create(data: CreateSetLog) {
  await db.insert(workoutSetLogs).values({
    id: data.id,
    sessionId: data.sessionId,
    exerciseId: data.exerciseId,
    exerciseNameSnapshot: data.exerciseNameSnapshot,
    setNumber: data.setNumber,
    targetReps: data.targetReps,
    actualReps: data.actualReps,
    weight: data.weight,
    sortOrder: data.sortOrder,
  });
}

/**
 * Update a set log.
 * Defense-in-depth: includes sessionId in WHERE clause.
 */
async function update(id: string, sessionId: string, data: UpdateSetLog) {
  await db
    .update(workoutSetLogs)
    .set(data)
    .where(
      and(eq(workoutSetLogs.id, id), eq(workoutSetLogs.sessionId, sessionId)),
    );
}

/**
 * Delete a set log.
 * Defense-in-depth: includes sessionId in WHERE clause.
 */
async function deleteById(id: string, sessionId: string) {
  await db
    .delete(workoutSetLogs)
    .where(
      and(eq(workoutSetLogs.id, id), eq(workoutSetLogs.sessionId, sessionId)),
    );
}

export const SetLogRepository = {
  findAllByUserId,
  findByIdWithSession,
  create,
  update,
  delete: deleteById,
} as const;
