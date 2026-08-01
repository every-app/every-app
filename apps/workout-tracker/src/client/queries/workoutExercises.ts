import { useQuery } from "@tanstack/react-query";
import { getAllWorkoutExercises } from "@/serverFunctions/workoutExercises";

const workoutExercisesKey = ["workoutExercises"] as const;

export function useWorkoutExercises() {
  return useQuery({
    queryKey: workoutExercisesKey,
    queryFn: async () => (await getAllWorkoutExercises()).workoutExercises,
  });
}
