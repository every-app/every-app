import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllPrograms,
  createProgram,
  updateProgram,
  deleteProgram,
  type CreateProgramInput,
  type UpdateProgramInput,
} from "@/serverFunctions/programs";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
import type { Program } from "@/db/schema";

export const programsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<Program, string>({
      queryKey: ["programs"],
      queryFn: async () => {
        const result = await getAllPrograms();
        // Flatten programs by removing nested workouts (collection stores flat data)
        return result.programs.map(({ workouts, ...program }) => program);
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { modified: newProgram } = mutation;
          const input: CreateProgramInput = {
            id: newProgram.id,
            name: newProgram.name,
            description: newProgram.description,
            difficulty: newProgram.difficulty,
            templateId: newProgram.templateId ?? undefined,
            isActive: newProgram.isActive,
            currentWorkoutIndex: newProgram.currentWorkoutIndex,
          };
          await createProgram({ data: input });
        }
      },
      onUpdate: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { modified } = mutation;
          const input: UpdateProgramInput = {
            id: modified.id,
            name: modified.name,
            description: modified.description,
            isActive: modified.isActive,
            currentWorkoutIndex: modified.currentWorkoutIndex,
          };
          await updateProgram({ data: input });
        }
      },
      onDelete: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { original } = mutation;
          await deleteProgram({ data: { id: original.id } });
        }
      },
    }),
  ),
);
