import { z } from "zod";

// === Upsert Set Log ===
export const upsertSetLogSchema = z.object({
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

export type UpsertSetLogInput = z.infer<typeof upsertSetLogSchema>;
