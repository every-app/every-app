import { createServerFn } from "@tanstack/react-start";
import { db, schema } from "@/db";
import { todos } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { emitSyncEvent } from "@/middleware/emitSyncEvent";
import {
  createTodoSchema,
  deleteTodoSchema,
  updateTodoSchema,
} from "@/types/schemas/todos";

export const getAllTodos = createServerFn()
  // TODO Global middlewares don't seem to work right now in tanstack-start. We should move to this once this is resolved.
  // https://github.com/TanStack/router/issues/3869
  .middleware([ensureUserMiddleware])
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
  .middleware([ensureUserMiddleware, emitSyncEvent("createTodo")])
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

    return { success: true };
  });

export const updateTodo = createServerFn()
  .middleware([ensureUserMiddleware, emitSyncEvent("updateTodo")])
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

    // Only write the fields the caller actually sent, so a concurrent update
    // from another device (this app syncs live) can't clobber a field it left
    // untouched.
    const updateData: Partial<typeof todos.$inferInsert> = {};
    if (todo.title !== undefined) updateData.title = todo.title;
    if (todo.sortKey !== undefined) updateData.sortKey = todo.sortKey;
    if (todo.dueDate !== undefined) updateData.dueDate = todo.dueDate;
    if (todo.completed !== undefined) {
      updateData.completed = todo.completed;
      if (todo.completed && !existingTodo.completed) {
        updateData.completedAt = new Date().toISOString();
      } else if (!todo.completed && existingTodo.completed) {
        updateData.completedAt = null;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await db
        .update(todos)
        .set(updateData)
        .where(and(eq(todos.id, todo.id), eq(todos.userId, context.userId)));
    }

    return { success: true };
  });

export const deleteTodo = createServerFn()
  .middleware([ensureUserMiddleware, emitSyncEvent("deleteTodo")])
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

    return { success: true };
  });
