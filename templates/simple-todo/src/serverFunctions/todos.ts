import { createServerFn } from "@tanstack/react-start";
import z from "zod";
import { db, schema } from "@/db";
import { todos } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/client";

export const getAllTodos = createServerFn()
  // TODO Global middlewares don't seem to work right now in tanstack-start. We should move to this once this is resolved.
  // https://github.com/TanStack/router/issues/3869
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: any) => {
    if (!context?.userId) {
      throw new Error("Unauthorized: No user ID in context");
    }

    // Get all todos and separate active from completed
    const allTodos = await db
      .select({
        id: schema.todos.id,
        title: schema.todos.title,
        completed: schema.todos.completed,
      })
      .from(schema.todos)
      .where(eq(todos.userId, context.userId));

    return { todos: allTodos };
  });

const createTodoSchema = z.object({
  id: z.string().length(36), // expect uuid
  title: z.string().min(1, "Title is required").max(255, "Title too long"),
});

export const createTodo = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((todo: unknown) => createTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }: any) => {
    if (!context?.userId) {
      throw new Error("Unauthorized: No user ID in context");
    }

    await db.insert(todos).values([
      {
        title: todo.title,
        userId: context.userId,
        id: todo.id,
      },
    ]);
  });

const updateTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
  title: z
    .string()
    .min(1, "Title is required")
    .max(255, "Title too long")
    .optional(),
  completed: z.boolean().optional(),
});

export const updateTodo = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((todo: unknown) => updateTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }: any) => {
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
    };

    await db.update(todos).set(updateData).where(eq(todos.id, todo.id));
  });

const deleteTodoSchema = z.object({
  id: z.string().uuid("Invalid todo ID"),
});

export const deleteTodo = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((todo: unknown) => deleteTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }: any) => {
    const existingTodo = await db.query.todos.findFirst({
      where: and(eq(todos.id, todo.id), eq(todos.userId, context.userId)),
    });

    if (!existingTodo) {
      throw new Error("Todo not found");
    }

    await db.delete(todos).where(eq(todos.id, todo.id));
  });
