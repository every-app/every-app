import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { emitSyncEvent } from "@/middleware/emitSyncEvent";
import { TodoService } from "@/server/todoService";
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

    return { todos: await TodoService.list(context.userId) };
  });

export const createTodo = createServerFn()
  .middleware([ensureUserMiddleware, emitSyncEvent("createTodo")])
  .inputValidator((todo: unknown) => createTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }) => {
    if (!context?.userId) {
      throw new Error("Unauthorized: No user ID in context");
    }

    await TodoService.create(context.user, todo);

    return { success: true };
  });

export const updateTodo = createServerFn()
  .middleware([ensureUserMiddleware, emitSyncEvent("updateTodo")])
  .inputValidator((todo: unknown) => updateTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }) => {
    await TodoService.update(context.userId, todo);

    return { success: true };
  });

export const deleteTodo = createServerFn()
  .middleware([ensureUserMiddleware, emitSyncEvent("deleteTodo")])
  .inputValidator((todo: unknown) => deleteTodoSchema.parse(todo))
  .handler(async ({ data: todo, context }) => {
    await TodoService.delete(context.userId, todo);

    return { success: true };
  });
