import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllWorkouts,
  createWorkouts,
  updateWorkout,
  deleteWorkout,
  type CreateWorkoutInput,
  type UpdateWorkoutInput,
} from "@/serverFunctions/workouts";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
import type { Workout } from "@/db/schema";

export const workoutsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<Workout, string>({
      queryKey: ["workouts"],
      queryFn: async () => {
        const result = await getAllWorkouts();
        return result.workouts;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        // Handle batch inserts
        const workoutsData: CreateWorkoutInput[] = transaction.mutations.map(
          (mutation) => ({
            id: mutation.modified.id,
            programId: mutation.modified.programId,
            name: mutation.modified.name,
            description: mutation.modified.description ?? undefined,
            sortOrder: mutation.modified.sortOrder,
          }),
        );
        await createWorkouts({ data: workoutsData });
      },
      onUpdate: async ({ transaction }) => {
        const { modified } = transaction.mutations[0];
        // Extract only the fields the server expects for update
        const input: UpdateWorkoutInput = {
          id: modified.id,
          name: modified.name,
          description: modified.description ?? undefined,
          sortOrder: modified.sortOrder,
        };
        await updateWorkout({ data: input });
      },
      onDelete: async ({ transaction }) => {
        const { original } = transaction.mutations[0];
        await deleteWorkout({ data: { id: original.id } });
      },
    }),
  ),
);
