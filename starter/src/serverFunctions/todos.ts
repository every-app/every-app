import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import * as todos from "@/server/todos";

// Each server function runs behind ensureUserMiddleware: `context.user` is
// the person the Gateway signed in, and every query takes their id.
export const getTodos = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(({ context }) => todos.listTodos(context.user.id));

export const createTodo = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .validator((data: unknown) => todos.createTodoInput.parse(data))
  .handler(({ data, context }) => todos.createTodo(context.user.id, data));

export const updateTodo = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .validator((data: unknown) => todos.updateTodoInput.parse(data))
  .handler(({ data, context }) => todos.updateTodo(context.user.id, data));

export const deleteTodo = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .validator((data: unknown) => todos.deleteTodoInput.parse(data))
  .handler(({ data, context }) => todos.deleteTodo(context.user.id, data));
