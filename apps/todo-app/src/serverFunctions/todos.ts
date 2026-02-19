import { createServerFn } from "@tanstack/react-start";
import z from "zod";
import { db, schema } from "@/db";
import { todos } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { emitSyncEvent } from "@/middleware/emitSyncEvent";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/tanstack";
import { DATE_KEY_REGEX, isValidDateKey } from "@/lib/date-key";

const dueDateSchema = z
  .string()
  .regex(DATE_KEY_REGEX, "Due date must be in YYYY-MM-DD format")
  .refine(isValidDateKey, "Due date must be a valid calendar date");

const createTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
  title: z.string().min(1, "Title is required").max(1024, "Title too long"),
  sortKey: z.string(),
  dueDate: dueDateSchema.nullable().optional(),
});

const updateTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
  title: z
    .string()
    .min(1, "Title is required")
    .max(1024, "Title too long")
    .optional(),
  completed: z.boolean().optional(),
  sortKey: z.string().optional(),
  dueDate: dueDateSchema.nullable().optional(),
});

const deleteTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
});

export const getAllTodos = createServerFn()
  // TODO Global middlewares don't seem to work right now in tanstack-start. We should move to this once this is resolved.
  // https://github.com/TanStack/router/issues/3869
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    if (!context?.userId) {
      throw new Error("Unauthorized: No user ID in context");
    }

    // Get all todos and separate active from completed
    const allTodos = await db
      .select({
        id: schema.todos.id,
        title: schema.todos.title,
        // TODO We only need the completedAt field
        completed: schema.todos.completed,
        completedAt: schema.todos.completedAt,
        sortKey: schema.todos.sortKey,
        dueDate: schema.todos.dueDate,
      })
      .from(schema.todos)
      .where(eq(todos.userId, context.userId));

    return { todos: allTodos };
  });

export const createTodo = createServerFn()
  .middleware([
    useSessionTokenClientMiddleware,
    ensureUserMiddleware,
    emitSyncEvent("createTodo"),
  ])
  .inputValidator((todo: unknown) => createTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }) => {
    if (!context?.userId) {
      throw new Error("Unauthorized: No user ID in context");
    }

    await db.insert(todos).values([
      {
        title: todo.title,
        userId: context.userId,
        id: todo.id,
        sortKey: todo.sortKey,
        dueDate: todo.dueDate ?? null,
      },
    ]);
  });

export const updateTodo = createServerFn()
  .middleware([
    useSessionTokenClientMiddleware,
    ensureUserMiddleware,
    emitSyncEvent("updateTodo"),
  ])
  .inputValidator((todo: unknown) => updateTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }) => {
    const existingTodo = await db.query.todos.findFirst({
      where: and(eq(todos.id, todo.id), eq(todos.userId, context.userId)),
    });

    if (!existingTodo) {
      throw new Error("Todo not found");
    }

    // Validate: Cannot edit title of completed todos
    if (
      existingTodo.completed &&
      todo.title !== undefined &&
      todo.title !== existingTodo.title
    ) {
      throw new Error(
        "Cannot edit the title of a completed todo. Unmark it as completed first.",
      );
    }

    // Prepare update data
    const updateData = {
      title: todo.title ?? existingTodo.title,
      completed: todo.completed ?? existingTodo.completed,
      sortKey: todo.sortKey ?? existingTodo.sortKey,
      completedAt: existingTodo.completedAt as string | null,
      dueDate: todo.dueDate !== undefined ? todo.dueDate : existingTodo.dueDate,
    };

    // Set completedAt timestamp when marking as completed
    if (todo.completed !== undefined) {
      if (todo.completed && !existingTodo.completed) {
        // Marking as completed
        updateData.completedAt = new Date().toISOString();
      } else if (!todo.completed && existingTodo.completed) {
        // Unmarking as completed
        updateData.completedAt = null;
      }
    }

    await db
      .update(todos)
      .set(updateData)
      .where(and(eq(todos.id, todo.id), eq(todos.userId, context.userId)));
  });

export const deleteTodo = createServerFn()
  .middleware([
    useSessionTokenClientMiddleware,
    ensureUserMiddleware,
    emitSyncEvent("deleteTodo"),
  ])
  .inputValidator((todo: unknown) => deleteTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }) => {
    const existingTodo = await db.query.todos.findFirst({
      where: and(eq(todos.id, todo.id), eq(todos.userId, context.userId)),
    });

    if (!existingTodo) {
      throw new Error("Todo not found");
    }

    await db
      .delete(todos)
      .where(and(eq(todos.id, todo.id), eq(todos.userId, context.userId)));
  });
