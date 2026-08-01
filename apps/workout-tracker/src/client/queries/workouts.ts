import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWorkouts,
  deleteWorkout,
  deleteWorkoutWithExercises,
  getAllWorkouts,
  saveWorkoutEdits,
  updateWorkout,
} from "@/serverFunctions/workouts";
import type {
  CreateWorkoutInput,
  DeleteWorkoutWithExercisesInput,
  SaveWorkoutEditsInput,
  UpdateWorkoutInput,
} from "@/types/schemas/workouts";

const workoutsKey = ["workouts"] as const;

export function useWorkouts() {
  return useQuery({
    queryKey: workoutsKey,
    queryFn: async () => (await getAllWorkouts()).workouts,
  });
}

export function useWorkoutMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: workoutsKey });
  const invalidateWithExercises = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: workoutsKey }),
      queryClient.invalidateQueries({ queryKey: ["workoutExercises"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    ]);
  const invalidateWorkoutEdits = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: workoutsKey }),
      queryClient.invalidateQueries({ queryKey: ["workoutExercises"] }),
      queryClient.invalidateQueries({ queryKey: ["exerciseLibrary"] }),
      queryClient.invalidateQueries({ queryKey: ["programs"] }),
    ]);

  return {
    create: useMutation({
      mutationFn: (data: CreateWorkoutInput[]) => createWorkouts({ data }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (data: UpdateWorkoutInput) => updateWorkout({ data }),
      onSuccess: invalidate,
    }),
    saveEdits: useMutation({
      mutationFn: (data: SaveWorkoutEditsInput) => saveWorkoutEdits({ data }),
      onSuccess: invalidateWorkoutEdits,
    }),
    remove: useMutation({
      mutationFn: (data: { id: string }) => deleteWorkout({ data }),
      onSuccess: invalidateWithExercises,
    }),
    removeWithExercises: useMutation({
      mutationFn: (data: DeleteWorkoutWithExercisesInput) =>
        deleteWorkoutWithExercises({ data }),
      onSuccess: invalidateWithExercises,
    }),
  };
}
