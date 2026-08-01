import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createExerciseLibraryItems,
  deleteExerciseLibraryItems,
  getAllExerciseLibrary,
  updateExerciseLibraryItems,
} from "@/serverFunctions/exerciseLibrary";
import type {
  CreateExerciseLibraryInput,
  DeleteExerciseLibraryInput,
  UpdateExerciseLibraryInput,
} from "@/types/schemas/exerciseLibrary";

const exerciseLibraryKey = ["exerciseLibrary"] as const;

export function useExerciseLibrary() {
  return useQuery({
    queryKey: exerciseLibraryKey,
    queryFn: async () => (await getAllExerciseLibrary()).exercises,
  });
}

export function useExerciseLibraryMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: exerciseLibraryKey });

  return {
    create: useMutation({
      mutationFn: (data: CreateExerciseLibraryInput[]) =>
        createExerciseLibraryItems({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateExerciseLibraryInput[]) =>
        updateExerciseLibraryItems({ data }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (data: DeleteExerciseLibraryInput[]) =>
        deleteExerciseLibraryItems({ data }),
      onSuccess: () =>
        Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: ["setLogs"] }),
        ]),
    }),
  };
}
