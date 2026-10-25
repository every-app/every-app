import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env, waitUntil } from "cloudflare:workers";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { emitIfCompleted } from "@/server/events";
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
  .handler(async ({ data, context }) => {
    const todo = await todos.updateTodo(context.user.id, data);
    emitIfCompleted({ env, request: getRequest(), waitUntil }, data, todo);
    return todo;
  });

export const deleteTodo = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .validator((data: unknown) => todos.deleteTodoInput.parse(data))
  .handler(({ data, context }) => todos.deleteTodo(context.user.id, data));
