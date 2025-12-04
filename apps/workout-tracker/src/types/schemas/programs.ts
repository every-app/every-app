import { z } from "zod";

// === Create Program ===
export const createProgramSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  templateId: z.string().optional(),
  isActive: z.boolean().default(false),
  currentWorkoutIndex: z.number().default(0),
});

export type CreateProgramInput = z.infer<typeof createProgramSchema>;

// === Update Program ===
export const updateProgramSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  currentWorkoutIndex: z.number().optional(),
});

export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;

// === Create Program From Template ===
const exerciseTemplateSchema = z.object({
  id: z.string(),
  exerciseLibraryId: z.string(),
  name: z.string(),
  sets: z.number(),
  targetReps: z.number(),
  weight: z.number().optional(),
});

const workoutTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  exercises: z.array(exerciseTemplateSchema),
});

export const createProgramFromTemplateSchema = z.object({
  program: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]),
    templateId: z.string().optional(),
  }),
  exerciseLibraryItems: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  workouts: z.array(workoutTemplateSchema),
});

export type CreateProgramFromTemplateInput = z.infer<
  typeof createProgramFromTemplateSchema
>;
