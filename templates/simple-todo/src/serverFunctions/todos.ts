import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/tanstack";
import { TodoService } from "@/server/services/TodoService";
import {
  createTodoSchema,
  updateTodoSchema,
  deleteTodoSchema,
} from "@/types/schemas/todos";

export const getAllTodos = createServerFn()
  // TODO Global middlewares don't seem to work right now in tanstack-start. We should move to this once this is resolved.
  // https://github.com/TanStack/router/issues/3869
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return TodoService.getAll(context.userId);
  });

export const createTodo = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    return TodoService.create(context.userId, data);
  });

export const updateTodo = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    return TodoService.update(context.userId, data);
  });

export const deleteTodo = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => deleteTodoSchema.parse(data))
  .handler(async ({ data, context }) => {
    return TodoService.delete(context.userId, data);
  });
