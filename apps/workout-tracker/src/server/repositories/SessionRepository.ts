import { db } from "@/db";
import { workoutSessions, programs, type SessionStatus } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

// Types for repository operations
type CreateSession = {
  id: string;
  userId: string;
  programId: string;
  workoutId: string;
  programNameSnapshot: string;
  workoutNameSnapshot: string;
  status?: SessionStatus;
};

type UpdateSession = {
  status?: SessionStatus;
  completedAt?: string;
};

/**
 * Find all sessions for a user with their set logs.
 */
async function findAllByUserId(userId: string) {
  return db.query.workoutSessions.findMany({
    where: eq(workoutSessions.userId, userId),
    orderBy: [desc(workoutSessions.startedAt)],
    with: {
      workoutSetLogs: {
        orderBy: (workoutSetLogs, { asc }) => [asc(workoutSetLogs.sortOrder)],
      },
    },
  });
}

/**
 * Find a session by ID and user ID.
 */
async function findByIdAndUserId(id: string, userId: string) {
  return db.query.workoutSessions.findFirst({
    where: and(eq(workoutSessions.id, id), eq(workoutSessions.userId, userId)),
  });
}

/**
 * Find an active (in_progress) session for a specific workout.
 * Used to enforce single active session constraint.
 */
async function findActiveByWorkoutId(workoutId: string) {
  return db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.workoutId, workoutId),
      eq(workoutSessions.status, "in_progress"),
    ),
  });
}

/**
 * Create a session.
 */
async function create(data: CreateSession) {
  const now = new Date().toISOString();

  await db.insert(workoutSessions).values({
    id: data.id,
    userId: data.userId,
    programId: data.programId,
    workoutId: data.workoutId,
    programNameSnapshot: data.programNameSnapshot,
    workoutNameSnapshot: data.workoutNameSnapshot,
    status: data.status ?? "in_progress",
    startedAt: now,
  });
}

/**
 * Update a session.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function update(id: string, userId: string, data: UpdateSession) {
  await db
    .update(workoutSessions)
    .set(data)
    .where(and(eq(workoutSessions.id, id), eq(workoutSessions.userId, userId)));
}

/**
 * Delete a session.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function deleteById(id: string, userId: string) {
  await db
    .delete(workoutSessions)
    .where(and(eq(workoutSessions.id, id), eq(workoutSessions.userId, userId)));
}

/**
 * Complete a session and advance the program's workout index atomically.
 */
async function completeWithProgramUpdate(
  sessionId: string,
  userId: string,
  programId: string,
  nextWorkoutIndex: number,
) {
  const now = new Date().toISOString();

  await db.batch([
    db
      .update(workoutSessions)
      .set({ status: "completed", completedAt: now })
      .where(
        and(
          eq(workoutSessions.id, sessionId),
          eq(workoutSessions.userId, userId),
        ),
      ),
    db
      .update(programs)
      .set({ currentWorkoutIndex: nextWorkoutIndex, updatedAt: now })
      .where(and(eq(programs.id, programId), eq(programs.userId, userId))),
  ]);
}

/**
 * Skip to a specific workout, optionally abandoning an in-progress session.
 */
async function skipToWorkout(
  userId: string,
  programId: string,
  targetWorkoutIndex: number,
  sessionIdToAbandon?: string,
) {
  const now = new Date().toISOString();

  if (sessionIdToAbandon) {
    // Abandon the session and update the program index atomically
    await db.batch([
      db
        .update(workoutSessions)
        .set({ status: "abandoned", completedAt: now })
        .where(
          and(
            eq(workoutSessions.id, sessionIdToAbandon),
            eq(workoutSessions.userId, userId),
          ),
        ),
      db
        .update(programs)
        .set({ currentWorkoutIndex: targetWorkoutIndex, updatedAt: now })
        .where(and(eq(programs.id, programId), eq(programs.userId, userId))),
    ]);
  } else {
    // Just update the program index
    await db
      .update(programs)
      .set({ currentWorkoutIndex: targetWorkoutIndex, updatedAt: now })
      .where(and(eq(programs.id, programId), eq(programs.userId, userId)));
  }
}

export const SessionRepository = {
  findAllByUserId,
  findByIdAndUserId,
  findActiveByWorkoutId,
  create,
  update,
  delete: deleteById,
  completeWithProgramUpdate,
  skipToWorkout,
} as const;
