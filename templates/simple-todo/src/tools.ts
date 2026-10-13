/**
 * The starter's agent tools. The Every App gateway snapshots this catalog
 * when the app deploys and serves it to MCP clients (Claude, Cursor, …) at
 * `https://<app-host>/mcp`; the app itself never speaks MCP.
 *
 * Every call arrives with the verified user, and every query is scoped to
 * that user's id: a client never supplies one. `delete_todo` is destructive,
 * so AI clients can't see or call it until the gateway supports approvals.
 */
import { ToolError, defineTools } from "@every-app/sdk/server";
import { z } from "zod";
import { TodoError } from "@/server/todoErrors";
import { TodoService } from "@/server/todoService";

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

export const tools = defineTools(
  {
    list_todos: {
      title: "List todos",
      description:
        "List all todos belonging to the authenticated user, including completed todos.",
      risk: "read",
      input: z.object({}).strict(),
      handler: async (_input, { user }) => ({
        todos: await TodoService.list(user.id),
      }),
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
      handler: async ({ title }, { user }) => ({
        todo: await TodoService.create(user, {
          id: crypto.randomUUID(),
          title,
        }),
      }),
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
      handler: async (input, { user }) => ({
        todo: await userFacing(() => TodoService.update(user.id, input)),
      }),
    },
    delete_todo: {
      title: "Delete todo",
      description:
        "Permanently delete one todo belonging to the authenticated user.",
      risk: "destructive",
      input: z.object({ id: todoId }).strict(),
      handler: async (input, { user }) => ({
        deleted: await userFacing(() => TodoService.delete(user.id, input)),
      }),
    },
  },
  {
    instructions:
      "Manage the authenticated user's todo list. Never guess todo IDs; call list_todos first when an ID is not already known.",
  },
);
