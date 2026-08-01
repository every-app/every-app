import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { todos } from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  createTodoSchema,
  updateTodoSchema,
  deleteTodoSchema,
} from "@/types/schemas/todos";

export const getAllTodos = createServerFn()
  // TODO Global middlewares don't seem to work right now in tanstack-start. We should move to this once this is resolved.
  // https://github.com/TanStack/router/issues/3869
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const userTodos = await db.query.todos.findMany({
      where: eq(todos.userId, context.userId),
      columns: {
        id: true,
        title: true,
        completed: true,
      },
    });

    return { todos: userTodos };
  });

export const createTodo = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => createTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    await db.insert(todos).values({
      id: data.id,
      userId: context.userId,
      title: data.title,
    });

    return { success: true };
  });

export const updateTodo = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => updateTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existingTodo = await db.query.todos.findFirst({
      where: and(eq(todos.id, data.id), eq(todos.userId, context.userId)),
    });

    if (!existingTodo) {
      throw new Error("Todo not found");
    }

    if (
      existingTodo.completed &&
      data.title !== undefined &&
      data.title !== existingTodo.title
    ) {
      throw new Error(
        "Cannot edit the title of a completed todo. Unmark it as completed first.",
      );
    }

    await db
      .update(todos)
      .set({
        title: data.title ?? existingTodo.title,
        completed: data.completed ?? existingTodo.completed,
      })
      .where(and(eq(todos.id, data.id), eq(todos.userId, context.userId)));

    return { success: true };
  });

export const deleteTodo = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => deleteTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existingTodo = await db.query.todos.findFirst({
      where: and(eq(todos.id, data.id), eq(todos.userId, context.userId)),
    });

    if (!existingTodo) {
      throw new Error("Todo not found");
    }

    await db
      .delete(todos)
      .where(and(eq(todos.id, data.id), eq(todos.userId, context.userId)));

    return { success: true };
  });
