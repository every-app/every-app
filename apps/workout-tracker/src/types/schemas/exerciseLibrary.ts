import { z } from "zod";

// === Create Exercise Library Item ===
const createExerciseLibrarySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
});

export type CreateExerciseLibraryInput = z.infer<
  typeof createExerciseLibrarySchema
>;

// === Batch Create Exercise Library Items ===
export const batchCreateExerciseLibrarySchema = z.array(
  createExerciseLibrarySchema,
);

// === Update Exercise Library Item ===
const updateExerciseLibrarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  notes: z.string().nullable().optional(),
});

export type UpdateExerciseLibraryInput = z.infer<
  typeof updateExerciseLibrarySchema
>;

// === Batch Update Exercise Library Items ===
export const batchUpdateExerciseLibrarySchema = z.array(
  updateExerciseLibrarySchema,
);

// === Delete Exercise Library Item ===
const deleteExerciseLibrarySchema = z.object({ id: z.string() });

export type DeleteExerciseLibraryInput = z.infer<
  typeof deleteExerciseLibrarySchema
>;

// === Batch Delete Exercise Library Items ===
export const batchDeleteExerciseLibrarySchema = z.array(
  deleteExerciseLibrarySchema,
);
