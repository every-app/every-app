import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import {
  createCustomProgram,
  createProgram,
  createProgramFromTemplate,
  deleteProgram,
  getAllPrograms,
  updateProgram,
} from "@/serverFunctions/programs";
import type { ProgramTemplate } from "@/data/program-templates";
import type {
  CreateCustomProgramInput,
  CreateProgramFromTemplateInput,
  CreateProgramInput,
  UpdateProgramInput,
} from "@/types/schemas/programs";

const programsKey = ["programs"] as const;

export function usePrograms() {
  return useQuery({
    queryKey: programsKey,
    queryFn: async () => (await getAllPrograms()).programs,
  });
}

export function useProgramMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: programsKey });
  const invalidateProgramTree = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: programsKey }),
      queryClient.invalidateQueries({ queryKey: ["workouts"] }),
      queryClient.invalidateQueries({ queryKey: ["workoutExercises"] }),
    ]);

  return {
    create: useMutation({
      mutationFn: (data: CreateProgramInput) => createProgram({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateProgramInput) => updateProgram({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: { id: string }) => deleteProgram({ data }),
      onSuccess: () =>
        Promise.all([
          invalidateProgramTree(),
          queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        ]),
    }),
    createFromTemplate: useMutation({
      mutationFn: (data: CreateProgramFromTemplateInput) =>
        createProgramFromTemplate({ data }),
      onSuccess: () =>
        Promise.all([
          invalidateProgramTree(),
          queryClient.invalidateQueries({ queryKey: ["exerciseLibrary"] }),
        ]),
    }),
    createCustom: useMutation({
      mutationFn: (data: CreateCustomProgramInput) =>
        createCustomProgram({ data }),
      onSuccess: invalidateProgramTree,
    }),
  };
}

export function createCustomProgramInput(): CreateCustomProgramInput {
  return {
    programId: nanoid(),
    workoutId: nanoid(),
  };
}

export function createProgramFromTemplateInput(
  template: ProgramTemplate,
  isActive: boolean,
): CreateProgramFromTemplateInput {
  const exerciseLibraryIds = new Map<string, string>();
  for (const workout of template.workouts) {
    for (const exercise of workout.exercises) {
      if (!exerciseLibraryIds.has(exercise.name)) {
        exerciseLibraryIds.set(exercise.name, nanoid());
      }
    }
  }

  return {
    program: {
      id: nanoid(),
      name: template.name,
      description: template.description,
      difficulty: template.difficulty,
      templateId: template.id,
      isActive,
    },
    exerciseLibraryItems: Array.from(exerciseLibraryIds, ([name, id]) => ({
      id,
      name,
    })),
    workouts: template.workouts.map((workout) => ({
      id: nanoid(),
      name: workout.name,
      description: workout.description,
      exercises: workout.exercises.map((exercise) => ({
        id: nanoid(),
        exerciseLibraryId: exerciseLibraryIds.get(exercise.name)!,
        name: exercise.name,
        sets: exercise.sets,
        targetReps: exercise.targetReps,
        weight: exercise.weight,
      })),
    })),
  };
}
