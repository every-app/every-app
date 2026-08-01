import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { exerciseLibrary } from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  batchCreateExerciseLibrarySchema,
  batchDeleteExerciseLibrarySchema,
  batchUpdateExerciseLibrarySchema,
} from "@/types/schemas/exerciseLibrary";

export const getAllExerciseLibrary = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const exercises = await db.query.exerciseLibrary.findMany({
      where: eq(exerciseLibrary.userId, context.userId),
    });

    return { exercises };
  });

export const createExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchCreateExerciseLibrarySchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    if (data.length === 0) return { success: true };

    const now = new Date().toISOString();
    const statements = data.map((item) =>
      db.insert(exerciseLibrary).values({
        id: item.id,
        userId: context.userId,
        name: item.name,
        notes: item.notes ?? null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const [first, ...rest] = statements;
    await db.batch([first, ...rest]);

    return { success: true };
  });

export const updateExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchUpdateExerciseLibrarySchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    if (data.length === 0) return { success: true };

    const ids = data.map((item) => item.id);
    const existing = await db.query.exerciseLibrary.findMany({
      where: and(
        inArray(exerciseLibrary.id, ids),
        eq(exerciseLibrary.userId, context.userId),
      ),
    });
    const authorizedIds = new Set(existing.map((item) => item.id));
    if (data.some((item) => !authorizedIds.has(item.id))) {
      throw new Error("Exercise not found or not authorized");
    }

    const now = new Date().toISOString();
    const statements = data.map(({ id, ...updates }) =>
      db
        .update(exerciseLibrary)
        .set({ ...updates, updatedAt: now })
        .where(
          and(
            eq(exerciseLibrary.id, id),
            eq(exerciseLibrary.userId, context.userId),
          ),
        ),
    );
    const [first, ...rest] = statements;
    await db.batch([first, ...rest]);

    return { success: true };
  });

export const deleteExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchDeleteExerciseLibrarySchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    if (data.length === 0) return { success: true };

    const ids = data.map((item) => item.id);
    const existing = await db.query.exerciseLibrary.findMany({
      where: and(
        inArray(exerciseLibrary.id, ids),
        eq(exerciseLibrary.userId, context.userId),
      ),
    });
    if (existing.length !== ids.length) {
      throw new Error("Exercise not found or not authorized");
    }

    await db
      .delete(exerciseLibrary)
      .where(
        and(
          inArray(exerciseLibrary.id, ids),
          eq(exerciseLibrary.userId, context.userId),
        ),
      );

    return { success: true };
  });
