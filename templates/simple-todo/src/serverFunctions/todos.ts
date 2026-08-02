import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { TodoService } from "@/server/todoService";
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
    return { todos: await TodoService.list(context.userId) };
  });

export const createTodo = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => createTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    await TodoService.create(context.user, data);

    return { success: true };
  });

export const updateTodo = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => updateTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    await TodoService.update(context.userId, data);

    return { success: true };
  });

export const deleteTodo = createServerFn()
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => deleteTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    await TodoService.delete(context.userId, data);

    return { success: true };
  });
