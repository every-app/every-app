import { z } from "zod";

// === Create Set Log ===
export const createSetLogSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  exerciseId: z.string().nullable().optional(),
  exerciseNameSnapshot: z.string(),
  setNumber: z.number(),
  targetReps: z.number(),
  actualReps: z.number(),
  weight: z.number().nullable().optional(),
  sortOrder: z.number(),
});

export type CreateSetLogInput = z.infer<typeof createSetLogSchema>;

// === Update Set Log ===
export const updateSetLogSchema = z.object({
  id: z.string(),
  actualReps: z.number(),
});

export type UpdateSetLogInput = z.infer<typeof updateSetLogSchema>;
