import { db } from "@/db";
import {
  workoutExercises,
  workoutSetLogs,
  exerciseLibrary,
  workouts,
  programs,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Import pure calculation functions
import {
  getExercisesToProgress,
  calculateLinearProgressionUpdates,
  calculateSmartProgressionUpdates,
  type SetLogData,
  type WorkoutExerciseData,
  type WeightUpdate,
} from "@/client/lib/progression";

// ============================================================================
// Shared Data Fetching
// ============================================================================

type ProgressionContext = {
  exercisesToProgress: string[];
  incrementMap: Map<string, number>;
  allWorkoutExercises: WorkoutExerciseData[];
};

/**
 * Fetches all data needed for progression calculations.
 * Shared by both linear and smart progression functions.
 *
 * @param userId - The authenticated user's ID (for defense-in-depth authorization)
 * @param sessionId - The workout session ID
 * @param programId - The program ID
 * @returns Progression context or null if no exercises should progress
 */
async function getProgressionContext(
  userId: string,
  sessionId: string,
  programId: string,
): Promise<ProgressionContext | null> {
  // 1. Get all set logs for this session (session ownership already verified by caller)
  const setLogs = await db.query.workoutSetLogs.findMany({
    where: eq(workoutSetLogs.sessionId, sessionId),
  });

  if (setLogs.length === 0) return null;

  // 2. Filter to logs with valid exerciseId
  const validLogs: SetLogData[] = setLogs
    .filter((log) => log.exerciseId !== null)
    .map((log) => ({
      exerciseId: log.exerciseId!,
      targetReps: log.targetReps,
      actualReps: log.actualReps,
      weight: log.weight,
    }));

  // 3. Find exercises that hit all target reps
  const exercisesToProgress = getExercisesToProgress(validLogs);

  if (exercisesToProgress.length === 0) return null;

  // 4. Get progression increments for these exercises (defense-in-depth: filter by userId)
  const exerciseLibraryItems = await db.query.exerciseLibrary.findMany({
    where: and(
      inArray(exerciseLibrary.id, exercisesToProgress),
      eq(exerciseLibrary.userId, userId),
    ),
  });

  const incrementMap = new Map<string, number>();
  for (const item of exerciseLibraryItems) {
    incrementMap.set(item.id, item.progressionIncrement);
  }

  // 5. Get ALL workoutExercises for these exercises within this program
  // Defense-in-depth: join through programs to verify userId ownership
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

  return {
    exercisesToProgress,
    incrementMap,
    allWorkoutExercises,
  };
}

/**
 * Applies weight updates to workout exercises in the database.
 */
async function applyWeightUpdates(updates: WeightUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  const now = new Date().toISOString();
  const updateStatements = updates.map((u) =>
    db
      .update(workoutExercises)
      .set({ weight: u.newWeight, updatedAt: now })
      .where(
        and(
          eq(workoutExercises.id, u.id),
          eq(workoutExercises.workoutId, u.workoutId),
        ),
      ),
  );

  const [first, ...rest] = updateStatements;
  await db.batch([first, ...rest]);
}

// ============================================================================
// Progression Functions
// ============================================================================

/**
 * Apply linear progression to exercises after a completed workout.
 *
 * For each exercise where all sets hit target reps:
 * - Increment the weight by the exercise's progressionIncrement
 * - Apply the SAME weight to ALL workoutExercises with this exerciseId
 */
async function applyLinearProgression(
  userId: string,
  sessionId: string,
  programId: string,
): Promise<void> {
  const context = await getProgressionContext(userId, sessionId, programId);
  if (!context) return;

  const updates = calculateLinearProgressionUpdates(
    context.allWorkoutExercises,
    context.exercisesToProgress,
    context.incrementMap,
  );

  await applyWeightUpdates(updates);
}

/**
 * Apply smart progression to exercises after a completed workout.
 *
 * For each exercise where all sets hit target reps:
 * - Apply fixed increment to the completed exercise
 * - Calculate e1RM ratio (new/old)
 * - Apply ratio to other workoutExercises with same exerciseId, rounded to nearest 5 lbs
 */
async function applySmartProgression(
  userId: string,
  sessionId: string,
  programId: string,
  completedWorkoutId: string,
): Promise<void> {
  const context = await getProgressionContext(userId, sessionId, programId);
  if (!context) return;

  const updates = calculateSmartProgressionUpdates(
    context.allWorkoutExercises,
    context.exercisesToProgress,
    completedWorkoutId,
    context.incrementMap,
  );

  await applyWeightUpdates(updates);
}

/**
 * Apply progression after a workout is completed.
 * Determines the progression mode from the program and applies the appropriate logic.
 *
 * @param userId - The authenticated user's ID (for defense-in-depth authorization)
 * @param sessionId - The workout session ID
 * @param programId - The program ID
 * @param workoutId - The completed workout ID
 */
async function applyProgression(
  userId: string,
  sessionId: string,
  programId: string,
  workoutId: string,
): Promise<void> {
  // Get the program to determine progression mode (defense-in-depth: filter by userId)
  const program = await db.query.programs.findFirst({
    where: and(eq(programs.id, programId), eq(programs.userId, userId)),
  });

  if (!program) return;

  const progressionMode = program.progressionMode;

  if (progressionMode === "linear") {
    await applyLinearProgression(userId, sessionId, programId);
  } else if (progressionMode === "smart") {
    await applySmartProgression(userId, sessionId, programId, workoutId);
  }
}

export const ProgressionService = {
  applyProgression,
  applyLinearProgression,
  applySmartProgression,
} as const;
