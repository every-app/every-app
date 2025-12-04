import { ProgramRepository } from "../repositories/ProgramRepository";
import type {
  CreateProgramInput,
  UpdateProgramInput,
  CreateProgramFromTemplateInput,
} from "@/types/schemas/programs";

/**
 * Get all programs for a user with nested workouts and exercises.
 */
async function getAll(userId: string) {
  const programs = await ProgramRepository.findAllByUserId(userId);
  return { programs };
}

/**
 * Create a program.
 */
async function create(userId: string, data: CreateProgramInput) {
  await ProgramRepository.create({
    id: data.id,
    userId,
    name: data.name,
    description: data.description,
    difficulty: data.difficulty,
    templateId: data.templateId,
    isActive: data.isActive,
    currentWorkoutIndex: data.currentWorkoutIndex,
  });

  return { success: true };
}

/**
 * Update a program.
 * Handles deactivate-all-then-activate logic when setting isActive to true.
 */
async function update(userId: string, data: UpdateProgramInput) {
  // Verify ownership
  const program = await ProgramRepository.findByIdAndUserId(data.id, userId);
  if (!program) {
    throw new Error("Program not found");
  }

  const { id, ...updates } = data;

  // If setting active, deactivate all other programs first
  if (updates.isActive === true) {
    await ProgramRepository.deactivateAllForUser(userId);
  }

  await ProgramRepository.update(id, userId, updates);
  return { success: true };
}

/**
 * Delete a program.
 */
async function deleteProgram(userId: string, id: string) {
  // Verify ownership
  const program = await ProgramRepository.findByIdAndUserId(id, userId);
  if (!program) {
    throw new Error("Program not found");
  }

  await ProgramRepository.delete(id, userId);
  return { success: true };
}

/**
 * Create a program from a template.
 * Atomically creates program, exercise library items, workouts, and workout exercises.
 */
async function createFromTemplate(
  userId: string,
  data: CreateProgramFromTemplateInput,
) {
  // Transform input data to repository format
  const repoData = {
    program: {
      id: data.program.id,
      userId,
      name: data.program.name,
      description: data.program.description,
      difficulty: data.program.difficulty,
      templateId: data.program.templateId,
    },
    exerciseLibraryItems: data.exerciseLibraryItems.map((item) => ({
      id: item.id,
      userId,
      name: item.name,
    })),
    workouts: data.workouts.map((workout, index) => ({
      id: workout.id,
      programId: data.program.id,
      name: workout.name,
      description: workout.description,
      sortOrder: index,
    })),
    workoutExercises: data.workouts.flatMap((workout) =>
      workout.exercises.map((exercise, index) => ({
        id: exercise.id,
        workoutId: workout.id,
        exerciseId: exercise.exerciseLibraryId,
        sets: exercise.sets,
        targetReps: exercise.targetReps,
        weight: exercise.weight,
        sortOrder: index,
      })),
    ),
  };

  await ProgramRepository.createFromTemplateAtomic(repoData);
  return { success: true };
}

export const ProgramService = {
  getAll,
  create,
  update,
  delete: deleteProgram,
  createFromTemplate,
} as const;
