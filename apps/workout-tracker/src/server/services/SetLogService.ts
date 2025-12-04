import { SetLogRepository } from "../repositories/SetLogRepository";
import { SessionRepository } from "../repositories/SessionRepository";
import type {
  CreateSetLogInput,
  UpdateSetLogInput,
} from "../../types/schemas/setLogs";

/**
 * Get all set logs for a user.
 */
async function getAll(userId: string) {
  const setLogs = await SetLogRepository.findAllByUserId(userId);
  return { setLogs };
}

/**
 * Create a set log.
 * Verifies session ownership before creating.
 */
async function create(userId: string, data: CreateSetLogInput) {
  // Verify session ownership
  const session = await SessionRepository.findByIdAndUserId(
    data.sessionId,
    userId,
  );

  if (!session) {
    throw new Error("Session not found or not authorized");
  }

  await SetLogRepository.create({
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
}

/**
 * Update a set log.
 * Verifies ownership via session before updating.
 */
async function update(userId: string, data: UpdateSetLogInput) {
  // Verify ownership via session
  const log = await SetLogRepository.findByIdWithSession(data.id);

  if (!log || log.session.userId !== userId) {
    throw new Error("Set log not found or not authorized");
  }

  await SetLogRepository.update(data.id, log.session.id, {
    actualReps: data.actualReps,
  });

  return { success: true };
}

/**
 * Delete a set log.
 * Verifies ownership via session before deleting.
 */
async function deleteSetLog(userId: string, id: string) {
  // Verify ownership via session
  const log = await SetLogRepository.findByIdWithSession(id);

  if (!log || log.session.userId !== userId) {
    throw new Error("Set log not found or not authorized");
  }

  await SetLogRepository.delete(id, log.session.id);
  return { success: true };
}

export const SetLogService = {
  getAll,
  create,
  update,
  delete: deleteSetLog,
} as const;
