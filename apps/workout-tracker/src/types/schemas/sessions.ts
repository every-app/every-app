import { z } from "zod";

// === Create Session ===
export const createSessionSchema = z.object({
  id: z.string(),
  programId: z.string(),
  workoutId: z.string(),
  programNameSnapshot: z.string(),
  workoutNameSnapshot: z.string(),
  status: z
    .enum(["in_progress", "completed", "abandoned"])
    .default("in_progress"),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

// === Update Session ===
export const updateSessionSchema = z.object({
  id: z.string(),
  status: z.enum(["in_progress", "completed", "abandoned"]).optional(),
  completedAt: z.string().optional(),
});

export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

// === Complete Workout Session ===
export const completeSessionSchema = z.object({
  sessionId: z.string(),
  programId: z.string(),
  nextWorkoutIndex: z.number(),
});

export type CompleteSessionInput = z.infer<typeof completeSessionSchema>;
