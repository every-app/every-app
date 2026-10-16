/**
 * The todo app's agent tools. The Every App gateway snapshots this catalog
 * once the app is deployed, and serves it to MCP clients at
 * `https://<todo-host>/mcp`; the app itself never speaks MCP.
 *
 * Every call arrives with the verified user (`channel: "mcp"`), and every
 * query is scoped to that user's id: a client never supplies one.
 * `delete_todo` is destructive, so AI clients can't see or call it until the
 * gateway supports approvals.
 */
import {
  ToolError,
  defineTools,
  type ToolContext,
} from "@every-app/sdk/server";
import { z } from "zod";
import { TodoError } from "@/server/todoErrors";
import { TodoService } from "@/server/todoService";

const SYNC_DO_EMIT_URL = "http://durable-object/emit";

type TodoMutation = "createTodo" | "updateTodo" | "deleteTodo";

const todoId = z
  .string()
  .uuid("Invalid todo ID")
  .describe("The todo ID returned by list_todos or create_todo.");
const todoTitle = z.string().trim().min(1, "Title is required").max(255);

/** TodoService errors are written for the user, so the model may see them. */
async function userFacing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TodoError) throw new ToolError(error.message);
    throw error;
  }
}

/** Tell the user's open browser tabs to refresh, after the response. */
function notifyClients(context: ToolContext, event: TodoMutation): void {
  context.ctx.waitUntil(
    notifyTodoMutation(context.env, context.user.id, event).catch((error) => {
      console.error("Failed to notify todo clients", {
        error,
        event,
        userId: context.user.id,
      });
    }),
  );
}

export const tools = defineTools(
  {
    list_todos: {
      title: "List todos",
      description:
        "List all todos belonging to the authenticated user, including completed todos.",
      risk: "read",
      input: z.object({}).strict(),
      handler: async (_input, { user }) => {
        const todos = await TodoService.list(user.id);
        return {
          todos: todos.map(({ id, title, completed }) => ({
            id,
            title,
            completed,
          })),
        };
      },
    },
    create_todo: {
      title: "Create todo",
      description:
        "Create a new active todo for the authenticated user. The server generates its ID.",
      risk: "write",
      idempotent: false,
      input: z
        .object({ title: todoTitle.describe("The task to remember.") })
        .strict(),
      handler: async ({ title }, context) => {
        const todo = await TodoService.create(context.user, {
          id: crypto.randomUUID(),
          title,
          sortKey: "n",
        });
        notifyClients(context, "createTodo");
        return { todo };
      },
    },
    update_todo: {
      title: "Update todo",
      description:
        "Change a todo's title or completion state. Only supplied fields are changed.",
      risk: "write",
      idempotent: true,
      input: z
        .object({
          id: todoId,
          title: todoTitle.optional(),
          completed: z.boolean().optional(),
        })
        .strict()
        .refine(
          (input) => input.title !== undefined || input.completed !== undefined,
          "Provide a title or completed value",
        ),
      handler: async (input, context) => {
        const todo = await userFacing(() =>
          TodoService.update(context.user.id, input),
        );
        notifyClients(context, "updateTodo");
        return { todo };
      },
    },
    delete_todo: {
      title: "Delete todo",
      description:
        "Permanently delete one todo belonging to the authenticated user.",
      risk: "destructive",
      input: z.object({ id: todoId }).strict(),
      handler: async (input, context) => {
        const deleted = await userFacing(() =>
          TodoService.delete(context.user.id, input),
        );
        notifyClients(context, "deleteTodo");
        return { deleted };
      },
    },
  },
  {
    instructions:
      "Manage the authenticated user's todo list. Never guess todo IDs; call list_todos first when an ID is not already known.",
  },
);

async function notifyTodoMutation(
  env: Cloudflare.Env,
  userId: string,
  event: TodoMutation,
): Promise<void> {
  const id = env.USER_SYNC.idFromName(userId);
  const response = await env.USER_SYNC.get(id).fetch(
    new Request(SYNC_DO_EMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
    }),
  );
  if (!response.ok) {
    throw new Error(`User sync returned ${response.status}`);
  }
}
