import { SessionRepository } from "../repositories/SessionRepository";
import { ProgramRepository } from "../repositories/ProgramRepository";
import type {
  CreateSessionInput,
  UpdateSessionInput,
  CompleteSessionInput,
  SkipToWorkoutInput,
} from "@/types/schemas/sessions";

/**
 * Get all sessions for a user with their set logs.
 */
async function getAll(userId: string) {
  const sessions = await SessionRepository.findAllByUserId(userId);
  return { sessions };
}

/**
 * Create a session.
 * Validates no duplicate in-progress session for the workout.
 * Verifies program ownership.
 */
async function create(userId: string, data: CreateSessionInput) {
  // Check for existing in-progress session for this workout
  if (data.status === "in_progress" || data.status === undefined) {
    const existingSession = await SessionRepository.findActiveByWorkoutId(
      data.workoutId,
    );

    if (existingSession) {
      throw new Error(
        "This workout already has an active session. Complete or abandon it first.",
      );
    }
  }

  // Verify program ownership
  const program = await ProgramRepository.findByIdAndUserId(
    data.programId,
    userId,
  );

  if (!program) {
    throw new Error("Program not found or not authorized");
  }

  await SessionRepository.create({
    id: data.id,
    userId,
    programId: data.programId,
    workoutId: data.workoutId,
    programNameSnapshot: data.programNameSnapshot,
    workoutNameSnapshot: data.workoutNameSnapshot,
    status: data.status,
  });

  return { success: true };
}

/**
 * Update a session.
 * Verifies ownership before updating.
 */
async function update(userId: string, data: UpdateSessionInput) {
  const session = await SessionRepository.findByIdAndUserId(data.id, userId);

  if (!session) {
    throw new Error("Session not found or not authorized");
  }

  const { id, ...updates } = data;
  await SessionRepository.update(id, userId, updates);
  return { success: true };
}

/**
 * Delete a session.
 * Verifies ownership before deleting.
 */
async function deleteSession(userId: string, id: string) {
  const session = await SessionRepository.findByIdAndUserId(id, userId);

  if (!session) {
    throw new Error("Session not found or not authorized");
  }

  await SessionRepository.delete(id, userId);
  return { success: true };
}

/**
 * Complete a workout session.
 * Atomically updates session status and advances program's workout index.
 */
async function complete(userId: string, data: CompleteSessionInput) {
  // Verify session ownership
  const session = await SessionRepository.findByIdAndUserId(
    data.sessionId,
    userId,
  );

  if (!session) {
    throw new Error("Session not found or not authorized");
  }

  // Verify program ownership
  const program = await ProgramRepository.findByIdAndUserId(
    data.programId,
    userId,
  );

  if (!program) {
    throw new Error("Program not found or not authorized");
  }

  await SessionRepository.completeWithProgramUpdate(
    data.sessionId,
    userId,
    data.programId,
    data.nextWorkoutIndex,
  );

  return { success: true };
}

/**
 * Skip to a specific workout in the program.
 * Optionally abandons an in-progress session if one exists.
 */
async function skipToWorkout(userId: string, data: SkipToWorkoutInput) {
  // Verify program ownership
  const program = await ProgramRepository.findByIdAndUserId(
    data.programId,
    userId,
  );

  if (!program) {
    throw new Error("Program not found or not authorized");
  }

  // If there's a session to abandon, verify ownership
  if (data.sessionIdToAbandon) {
    const session = await SessionRepository.findByIdAndUserId(
      data.sessionIdToAbandon,
      userId,
    );

    if (!session) {
      throw new Error("Session not found or not authorized");
    }
  }

  await SessionRepository.skipToWorkout(
    userId,
    data.programId,
    data.targetWorkoutIndex,
    data.sessionIdToAbandon,
  );

  return { success: true };
}

export const SessionService = {
  getAll,
  create,
  update,
  delete: deleteSession,
  complete,
  skipToWorkout,
} as const;
