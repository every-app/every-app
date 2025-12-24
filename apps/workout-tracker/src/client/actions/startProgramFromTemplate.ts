import { createOptimisticAction } from "@tanstack/react-db";
import { nanoid } from "nanoid";
import {
  programsCollection,
  workoutsCollection,
  exercisesCollection,
  exerciseLibraryCollection,
} from "@/client/tanstack-db";
import { createProgramFromTemplate } from "@/serverFunctions/programs";
import type {
  ProgramTemplate,
  WorkoutTemplate,
  ExerciseTemplate,
} from "@/data/program-templates";

type StartProgramFromTemplateParams = {
  template: ProgramTemplate;
  programId: string;
  // Pre-generated IDs for workouts and exercises
  workoutIds: string[];
  exerciseLibraryIds: Map<string, string>; // name -> id
  workoutExerciseIds: string[][]; // [workoutIndex][exerciseIndex]
  isActive?: boolean;
};

/**
 * Action to create a program from a template.
 * Atomically creates the program, workouts, exercise library items, and workout exercises.
 */
export const startProgramFromTemplate =
  createOptimisticAction<StartProgramFromTemplateParams>({
    onMutate: ({
      template,
      programId,
      workoutIds,
      exerciseLibraryIds,
      workoutExerciseIds,
      isActive,
    }) => {
      const now = new Date().toISOString();

      // Optimistically insert exercise library items
      exerciseLibraryIds.forEach((id, name) => {
        exerciseLibraryCollection.insert({
          id,
          userId: "",
          name,
          notes: null,
          createdAt: now,
          updatedAt: now,
        });
      });

      // If setting as active, deactivate all other programs first
      if (isActive) {
        for (const [, p] of programsCollection.state) {
          if (p.isActive) {
            programsCollection.update(p.id, (draft) => {
              draft.isActive = false;
            });
          }
        }
      }

      // Optimistically insert the program
      programsCollection.insert({
        id: programId,
        userId: "",
        name: template.name,
        description: template.description,
        difficulty: template.difficulty,
        templateId: template.id,
        currentWorkoutIndex: 0,
        isActive: isActive ?? false,
        createdAt: now,
        updatedAt: now,
      });

      // Optimistically insert workouts
      template.workouts.forEach(
        (workoutTemplate: WorkoutTemplate, workoutIndex: number) => {
          workoutsCollection.insert({
            id: workoutIds[workoutIndex],
            programId,
            name: workoutTemplate.name,
            description: workoutTemplate.description ?? null,
            sortOrder: workoutIndex,
            createdAt: now,
            updatedAt: now,
          });

          // Optimistically insert workout exercises
          workoutTemplate.exercises.forEach(
            (exerciseTemplate: ExerciseTemplate, exerciseIndex: number) => {
              exercisesCollection.insert({
                id: workoutExerciseIds[workoutIndex][exerciseIndex],
                workoutId: workoutIds[workoutIndex],
                exerciseId: exerciseLibraryIds.get(exerciseTemplate.name)!,
                sets: exerciseTemplate.sets,
                targetReps: exerciseTemplate.targetReps,
                weight: exerciseTemplate.weight ?? null,
                sortOrder: exerciseIndex,
                createdAt: now,
                updatedAt: now,
              });
            },
          );
        },
      );
    },
    mutationFn: async ({
      template,
      programId,
      workoutIds,
      exerciseLibraryIds,
      workoutExerciseIds,
      isActive,
    }) => {
      // Build the data for the server function
      const exerciseLibraryItems = Array.from(exerciseLibraryIds.entries()).map(
        ([name, id]) => ({ id, name }),
      );

      const workouts = template.workouts.map(
        (workoutTemplate: WorkoutTemplate, workoutIndex: number) => ({
          id: workoutIds[workoutIndex],
          name: workoutTemplate.name,
          description: workoutTemplate.description,
          exercises: workoutTemplate.exercises.map(
            (exerciseTemplate: ExerciseTemplate, exerciseIndex: number) => ({
              id: workoutExerciseIds[workoutIndex][exerciseIndex],
              exerciseLibraryId: exerciseLibraryIds.get(exerciseTemplate.name)!,
              name: exerciseTemplate.name,
              sets: exerciseTemplate.sets,
              targetReps: exerciseTemplate.targetReps,
              weight: exerciseTemplate.weight,
            }),
          ),
        }),
      );

      await createProgramFromTemplate({
        data: {
          program: {
            id: programId,
            name: template.name,
            description: template.description,
            difficulty: template.difficulty,
            templateId: template.id,
            isActive: isActive ?? false,
          },
          exerciseLibraryItems,
          workouts,
        },
      });

      // Refetch to sync optimistic state with server
      await Promise.all([
        programsCollection.utils.refetch(),
        workoutsCollection.utils.refetch(),
        exercisesCollection.utils.refetch(),
        exerciseLibraryCollection.utils.refetch(),
      ]);
    },
  });

/**
 * Helper to create the params with pre-generated IDs
 */
export function createStartProgramParams(
  template: ProgramTemplate,
): StartProgramFromTemplateParams {
  const programId = nanoid();
  const workoutIds = template.workouts.map(() => nanoid());

  // Create unique exercise library IDs for each unique exercise name
  const exerciseLibraryIds = new Map<string, string>();
  for (const workout of template.workouts) {
    for (const exercise of workout.exercises) {
      if (!exerciseLibraryIds.has(exercise.name)) {
        exerciseLibraryIds.set(exercise.name, nanoid());
      }
    }
  }

  // Create workout exercise IDs
  const workoutExerciseIds = template.workouts.map((workout: WorkoutTemplate) =>
    workout.exercises.map(() => nanoid()),
  );

  return {
    template,
    programId,
    workoutIds,
    exerciseLibraryIds,
    workoutExerciseIds,
  };
}
