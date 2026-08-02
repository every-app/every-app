import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EveryAppUser } from "@every-app/sdk/server";
import { TodoService } from "@/server/todoService";
import { todoMcpHandler } from "./todoMcp";

vi.mock("@/server/todoService", () => ({
  TodoService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const TODO_ID = "00000000-0000-4000-8000-000000000001";
const mockedTodos = vi.mocked(TodoService);

function caller(id = "user_1"): EveryAppUser {
  return {
    id,
    email: `${id}@example.com`,
    orgId: "org_1",
    orgRole: "member",
    channel: "mcp",
    actor: { sub: "mcp:test-client" },
    scopes: ["*"],
    jti: "jti_1",
  };
}

function request(body: unknown): Request {
  return new Request("https://todos.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function testEnv(events: string[]): Env {
  return {
    USER_SYNC: {
      idFromName: (userId: string) => userId,
      get: (userId: string) => ({
        fetch: async (syncRequest: Request) => {
          const body = (await syncRequest.json()) as { event: string };
          events.push(`${userId}:${body.event}`);
          return new Response("OK");
        },
      }),
    },
  } as unknown as Env;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  user: EveryAppUser | null = caller(),
) {
  const events: string[] = [];
  const background: Promise<unknown>[] = [];
  const response = await todoMcpHandler(
    request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    testEnv(events),
    { waitUntil: (promise) => background.push(promise) },
    user,
  );
  const json = (await response.json()) as {
    result?: { content: Array<{ text: string }>; isError?: boolean };
    error?: string;
    message?: string;
  };
  await Promise.all(background);
  return { response, json, events };
}

function toolResult(json: {
  result?: { content: Array<{ text: string }> };
}): unknown {
  return JSON.parse(json.result!.content[0]!.text);
}

describe("todo MCP example", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists todos through the shared service for the authenticated user", async () => {
    mockedTodos.list.mockResolvedValue([
      {
        id: TODO_ID,
        title: "Mine",
        completed: false,
        completedAt: null,
        sortKey: "n",
        dueDate: null,
      },
    ]);

    const { json } = await callTool("list_todos", {});

    expect(mockedTodos.list).toHaveBeenCalledWith("user_1");
    expect(toolResult(json)).toEqual({
      todos: [{ id: TODO_ID, title: "Mine", completed: false }],
    });
  });

  it("creates, updates, and deletes through the shared service", async () => {
    mockedTodos.create.mockImplementation(async (_user, input) => ({
      id: input.id,
      title: input.title,
      completed: false,
    }));
    mockedTodos.update.mockResolvedValue({
      id: TODO_ID,
      title: "Buy milk",
      completed: true,
    });
    mockedTodos.delete.mockResolvedValue({
      id: TODO_ID,
      title: "Buy milk",
      completed: true,
    });

    const created = await callTool("create_todo", { title: "  Buy milk  " });
    const createdTodo = (toolResult(created.json) as { todo: { id: string } })
      .todo;
    expect(mockedTodos.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user_1" }),
      { id: createdTodo.id, title: "Buy milk", sortKey: "n" },
    );

    const updated = await callTool("update_todo", {
      id: TODO_ID,
      completed: true,
    });
    expect(mockedTodos.update).toHaveBeenCalledWith("user_1", {
      id: TODO_ID,
      completed: true,
    });
    expect(toolResult(updated.json)).toEqual({
      todo: { id: TODO_ID, title: "Buy milk", completed: true },
    });

    const deleted = await callTool("delete_todo", { id: TODO_ID });
    expect(mockedTodos.delete).toHaveBeenCalledWith("user_1", { id: TODO_ID });
    expect(toolResult(deleted.json)).toEqual({
      deleted: { id: TODO_ID, title: "Buy milk", completed: true },
    });

    expect([...created.events, ...updated.events, ...deleted.events]).toEqual([
      "user_1:createTodo",
      "user_1:updateTodo",
      "user_1:deleteTodo",
    ]);
  });

  it("rejects invalid tool input before reaching the service", async () => {
    const noChanges = await callTool("update_todo", { id: TODO_ID });
    expect(noChanges.json.result?.isError).toBe(true);
    expect(noChanges.json.result?.content[0]?.text).toContain(
      "Provide a title or completed value",
    );

    const unknownField = await callTool("create_todo", {
      title: "Valid",
      userId: "user_2",
    });
    expect(unknownField.json.result?.isError).toBe(true);
    expect(unknownField.json.result?.content[0]?.text).toContain(
      "Unrecognized key",
    );
    expect(mockedTodos.update).not.toHaveBeenCalled();
    expect(mockedTodos.create).not.toHaveBeenCalled();
  });

  it("passes scoped not-found errors through without revealing another user", async () => {
    mockedTodos.delete.mockRejectedValue(new Error("Todo not found"));

    const result = await callTool("delete_todo", { id: TODO_ID });

    expect(mockedTodos.delete).toHaveBeenCalledWith("user_1", { id: TODO_ID });
    expect(result.json.result?.isError).toBe(true);
    expect(result.json.result?.content[0]?.text).toBe("Todo not found");
  });

  it("requires an authenticated Every App user", async () => {
    const result = await callTool("list_todos", {}, null);
    expect(result.response.status).toBe(401);
    expect(result.json.error).toBe("unauthenticated");
    expect(result.json.message).toBe("MCP requests require a user");
    expect(mockedTodos.list).not.toHaveBeenCalled();
  });
});
