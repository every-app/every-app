import { createMcpHandler } from "@every-app/sdk/server";
import { z } from "zod";
import { TodoService } from "@/server/todoService";

const emptyInputSchema = z.object({}).strict();
const createInputSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(255),
  })
  .strict();
const updateInputSchema = z
  .object({
    id: z.string().uuid("Invalid todo ID"),
    title: z.string().trim().min(1, "Title is required").max(255).optional(),
    completed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => input.title !== undefined || input.completed !== undefined,
    "Provide a title or completed value",
  );
const deleteInputSchema = z
  .object({ id: z.string().uuid("Invalid todo ID") })
  .strict();

function parseInput<T>(
  inputSchema: z.ZodType<T>,
  args: Record<string, unknown>,
): T {
  const result = inputSchema.safeParse(args);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
  throw new Error(`Invalid input: ${detail}`);
}

export const todoMcpHandler = createMcpHandler<Env>({
  name: "every-app-todos",
  version: "1.0.0",
  instructions:
    "Manage the authenticated user's todo list. Never guess todo IDs; call list_todos first when an ID is not already known.",
  tools: {
    list_todos: {
      description:
        "List all todos belonging to the authenticated user, including completed todos.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (args, context) => {
        parseInput(emptyInputSchema, args);
        return { todos: await TodoService.list(context.user.id) };
      },
    },
    create_todo: {
      description:
        "Create a new active todo for the authenticated user. The server generates its ID.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description: "The task to remember.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const input = parseInput(createInputSchema, args);
        const todo = await TodoService.create(context.user, {
          id: crypto.randomUUID(),
          title: input.title,
        });
        return { todo };
      },
    },
    update_todo: {
      description:
        "Change a todo's title or completion state. Only supplied fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            description: "The todo ID returned by list_todos or create_todo.",
          },
          title: { type: "string", minLength: 1, maxLength: 255 },
          completed: { type: "boolean" },
        },
        required: ["id"],
        anyOf: [{ required: ["title"] }, { required: ["completed"] }],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const input = parseInput(updateInputSchema, args);
        const todo = await TodoService.update(context.user.id, input);
        return { todo };
      },
    },
    delete_todo: {
      description:
        "Permanently delete one todo belonging to the authenticated user.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            format: "uuid",
            description: "The todo ID returned by list_todos or create_todo.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (args, context) => {
        const input = parseInput(deleteInputSchema, args);
        const deleted = await TodoService.delete(context.user.id, input);
        return { deleted };
      },
    },
  },
});
