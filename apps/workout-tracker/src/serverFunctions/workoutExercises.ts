import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { programs, workoutExercises, workouts } from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";

export const getAllWorkoutExercises = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const result = await db
      .select({ workoutExercise: workoutExercises })
      .from(workoutExercises)
      .innerJoin(workouts, eq(workoutExercises.workoutId, workouts.id))
      .innerJoin(programs, eq(workouts.programId, programs.id))
      .where(eq(programs.userId, context.userId));

    return {
      workoutExercises: result.map(({ workoutExercise }) => workoutExercise),
    };
  });
