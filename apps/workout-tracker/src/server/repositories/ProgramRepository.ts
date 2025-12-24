import { db } from "@/db";
import {
  programs,
  exerciseLibrary,
  workouts,
  workoutExercises,
  type DifficultyLevel,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";

// Types for repository operations
type CreateProgram = {
  id: string;
  userId: string;
  name: string;
  description: string;
  difficulty: DifficultyLevel;
  templateId?: string | null;
  isActive?: boolean;
  currentWorkoutIndex?: number;
};

type UpdateProgram = {
  name?: string;
  description?: string;
  isActive?: boolean;
  currentWorkoutIndex?: number;
};

/**
 * Find all programs for a user with nested workouts and exercises.
 */
async function findAllByUserId(userId: string) {
  return db.query.programs.findMany({
    where: eq(programs.userId, userId),
    with: {
      workouts: {
        orderBy: (workouts, { asc }) => [asc(workouts.sortOrder)],
        with: {
          workoutExercises: {
            orderBy: (workoutExercises, { asc }) => [
              asc(workoutExercises.sortOrder),
            ],
            with: {
              exercise: true,
            },
          },
        },
      },
    },
  });
}

/**
 * Find a program by ID and user ID.
 */
async function findByIdAndUserId(id: string, userId: string) {
  return db.query.programs.findFirst({
    where: and(eq(programs.id, id), eq(programs.userId, userId)),
  });
}

/**
 * Create a program.
 */
async function create(data: CreateProgram) {
  const now = new Date().toISOString();

  await db.insert(programs).values({
    id: data.id,
    userId: data.userId,
    name: data.name,
    description: data.description,
    difficulty: data.difficulty,
    templateId: data.templateId ?? null,
    isActive: data.isActive ?? false,
    currentWorkoutIndex: data.currentWorkoutIndex ?? 0,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Update a program.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function update(id: string, userId: string, data: UpdateProgram) {
  await db
    .update(programs)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(programs.id, id), eq(programs.userId, userId)));
}

/**
 * Delete a program.
 * Defense-in-depth: includes userId in WHERE clause.
 */
async function deleteById(id: string, userId: string) {
  await db
    .delete(programs)
    .where(and(eq(programs.id, id), eq(programs.userId, userId)));
}

/**
 * Deactivate all programs for a user.
 * Used before activating a specific program to ensure only one is active.
 */
async function deactivateAllForUser(userId: string) {
  await db
    .update(programs)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(programs.userId, userId));
}

// Types for atomic template creation
type CreateProgramFromTemplateData = {
  program: {
    id: string;
    userId: string;
    name: string;
    description: string;
    difficulty: DifficultyLevel;
    templateId?: string | null;
    isActive?: boolean;
  };
  exerciseLibraryItems: Array<{
    id: string;
    userId: string;
    name: string;
  }>;
  workouts: Array<{
    id: string;
    programId: string;
    name: string;
    description?: string | null;
    sortOrder: number;
  }>;
  workoutExercises: Array<{
    id: string;
    workoutId: string;
    exerciseId: string;
    sets: number;
    targetReps: number;
    weight?: number | null;
    sortOrder: number;
  }>;
};

/**
 * Atomically create a program with all related entities (exercise library items, workouts, workout exercises).
 * Uses db.batch() to ensure all inserts happen in a single transaction.
 */
async function createFromTemplateAtomic(data: CreateProgramFromTemplateData) {
  const now = new Date().toISOString();

  // Create program insert statement
  const programStatement = db.insert(programs).values({
    id: data.program.id,
    userId: data.program.userId,
    name: data.program.name,
    description: data.program.description,
    difficulty: data.program.difficulty,
    templateId: data.program.templateId ?? null,
    currentWorkoutIndex: 0,
    isActive: data.program.isActive ?? false,
    createdAt: now,
    updatedAt: now,
  });

  // Create exercise library insert statements
  const exerciseLibraryStatements = data.exerciseLibraryItems.map((item) =>
    db.insert(exerciseLibrary).values({
      id: item.id,
      userId: item.userId,
      name: item.name,
      notes: null,
      createdAt: now,
      updatedAt: now,
    }),
  );

  // Create workout insert statements
  const workoutStatements = data.workouts.map((workout) =>
    db.insert(workouts).values({
      id: workout.id,
      programId: workout.programId,
      name: workout.name,
      description: workout.description ?? null,
      sortOrder: workout.sortOrder,
      createdAt: now,
      updatedAt: now,
    }),
  );

  // Create workout exercise insert statements
  const workoutExerciseStatements = data.workoutExercises.map((exercise) =>
    db.insert(workoutExercises).values({
      id: exercise.id,
      workoutId: exercise.workoutId,
      exerciseId: exercise.exerciseId,
      sets: exercise.sets,
      targetReps: exercise.targetReps,
      weight: exercise.weight ?? null,
      sortOrder: exercise.sortOrder,
      createdAt: now,
      updatedAt: now,
    }),
  );

  // Execute all statements in a single batch transaction
  // Program must be first, followed by exercise library (for FK constraint),
  // then workouts, then workout exercises
  await db.batch([
    programStatement,
    ...exerciseLibraryStatements,
    ...workoutStatements,
    ...workoutExerciseStatements,
  ]);
}

// Types for custom program creation
type CreateCustomProgramData = {
  program: {
    id: string;
    userId: string;
    name: string;
    description: string;
    difficulty: DifficultyLevel;
  };
  workout: {
    id: string;
    programId: string;
    name: string;
    sortOrder: number;
  };
};

/**
 * Atomically create a custom program with an initial workout.
 * Uses db.batch() to ensure both inserts happen in a single transaction.
 */
async function createCustomProgramAtomic(data: CreateCustomProgramData) {
  const now = new Date().toISOString();

  await db.batch([
    db.insert(programs).values({
      id: data.program.id,
      userId: data.program.userId,
      name: data.program.name,
      description: data.program.description,
      difficulty: data.program.difficulty,
      templateId: null,
      currentWorkoutIndex: 0,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(workouts).values({
      id: data.workout.id,
      programId: data.workout.programId,
      name: data.workout.name,
      description: null,
      sortOrder: data.workout.sortOrder,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
}

export const ProgramRepository = {
  findAllByUserId,
  findByIdAndUserId,
  create,
  update,
  delete: deleteById,
  deactivateAllForUser,
  createFromTemplateAtomic,
  createCustomProgramAtomic,
} as const;
