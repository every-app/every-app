// The app's tools for AI clients (Claude, Cursor, ...). The Gateway serves
// them at /mcp and calls each with the signed-in user; the app never speaks
// MCP itself. `risk` is honest: a destructive tool stays hidden from AI
// clients until the Gateway has approvals.
import { ToolError, defineTools } from "@every-app/sdk/server";
import { z } from "zod";
import { emitIfCompleted } from "@/server/events";
import * as todos from "@/server/todos";

export const tools = defineTools(
  {
    list_todos: {
      description: "List the user's todos, completed ones included.",
      risk: "read",
      input: z.object({}).strict(),
      handler: (_input, { user }) => todos.listTodos(user.id),
    },
    create_todo: {
      description: "Add a todo. The server assigns its id.",
      risk: "write",
      idempotent: false,
      input: todos.createTodoInput,
      handler: (input, { user }) => todos.createTodo(user.id, input),
    },
    update_todo: {
      description:
        "Change a todo's title or completed state. Only the fields given change.",
      risk: "write",
      idempotent: true,
      input: todos.updateTodoInput,
      handler: async (input, { user, env, ctx }) => {
        const todo = await todos.updateTodo(user.id, input);
        emitIfCompleted(
          { env, waitUntil: (promise) => ctx.waitUntil(promise) },
          input,
          todo,
        );
        return todo ?? raise("No todo with that id");
      },
    },
    delete_todo: {
      description: "Delete one todo for good.",
      risk: "destructive",
      input: todos.deleteTodoInput,
      handler: async (input, { user }) =>
        (await todos.deleteTodo(user.id, input)) ??
        raise("No todo with that id"),
    },
  },
  {
    instructions:
      "Never guess todo ids: call list_todos first when an id isn't already known.",
  },
);

/** A message the model may read; any other error reaches it as "Internal error". */
function raise(message: string): never {
  throw new ToolError(message);
}
