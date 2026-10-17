/**
 * The todo agent tools through the SDK's internal tools contract, exactly as
 * the gateway calls them: a `chan: "mcp"` identity minted for one call, the
 * tool's schema, its risk scope, and the user-facing error rules.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { everyApp } from "@every-app/sdk/server";
import {
  IDENTITY_HEADER,
  SYSTEM_HEADER,
  TOOLS_CALL_PATH,
  TOOLS_LIST_PATH,
  mintIdentityJwt,
  mintSystemJwt,
} from "@every-app/sdk/internal";
import { TodoError } from "@/server/todoErrors";
import { TodoService } from "@/server/todoService";
import { tools } from "./tools";

vi.mock("@/server/todoService", () => ({
  TodoService: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const ISSUER = "https://home.example.com";
const TODO_ID = "00000000-0000-4000-8000-000000000001";
const mockedTodos = vi.mocked(TodoService);

let keys: { privateKeyPem: string; publicKeyPem: string };
let app: ReturnType<typeof everyApp<Env>>;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keys = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
  app = everyApp<Env>(
    async () => new Response("todo app"),
    { id: "todo" },
    { publicKeys: [keys.publicKeyPem], issuer: ISSUER, tools },
  );
});

beforeEach(() => {
  vi.resetAllMocks();
});

// The Worker's name, the audience everyAppWorker() deploys it with.
const WORKER = "every-acme-todo";

function testEnv(events: string[]): Env {
  return {
    EVERYAPP_AUDIENCE: WORKER,
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
  scopes = ["mcp:read", "mcp:write"],
) {
  const callId = crypto.randomUUID();
  const identity = await mintIdentityJwt(keys.privateKeyPem, {
    subject: {
      sub: "user_1",
      email: "user_1@example.com",
      orgId: "org_1",
      orgRole: "member",
    },
    audience: WORKER,
    issuer: ISSUER,
    channel: "mcp",
    actor: { sub: "pat:token_1" },
    scopes,
    toolCall: { id: callId, name },
  });
  const events: string[] = [];
  const background: Promise<unknown>[] = [];
  const response = await app.fetch(
    new Request(`https://todo.example.com${TOOLS_CALL_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [IDENTITY_HEADER]: identity,
      },
      body: JSON.stringify({ v: 1, name, arguments: args, callId }),
    }),
    testEnv(events),
    // TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
    {
      waitUntil: (promise: Promise<unknown>) => void background.push(promise),
    } as unknown as ExecutionContext,
  );
  const body = (await response.json()) as {
    result?: { content: Array<{ text: string }>; isError?: boolean };
    error?: { code: string; message: string };
  };
  await Promise.all(background);
  return { status: response.status, body, events, callId };
}

function toolResult(body: {
  result?: { content: Array<{ text: string }> };
}): unknown {
  return JSON.parse(body.result!.content[0]!.text);
}

describe("todo agent tools", () => {
  it("describes four tools, with delete marked destructive", async () => {
    const response = await app.fetch(
      new Request(`https://todo.example.com${TOOLS_LIST_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SYSTEM_HEADER]: await mintSystemJwt(keys.privateKeyPem, {
            audience: WORKER,
            issuer: ISSUER,
            purpose: "tools.list",
          }),
        },
        body: JSON.stringify({ v: 1 }),
      }),
      testEnv([]),
      // TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    const catalog = (await response.json()) as {
      instructions: string;
      tools: Array<{ name: string; risk: string }>;
    };
    expect(catalog.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["create_todo", "write"],
      ["delete_todo", "destructive"],
      ["list_todos", "read"],
      ["update_todo", "write"],
    ]);
    expect(catalog.instructions).toContain("Never guess todo IDs");
  });

  it("lists todos through the shared service for the verified user", async () => {
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

    const { body } = await callTool("list_todos", {});

    expect(mockedTodos.list).toHaveBeenCalledWith("user_1");
    expect(toolResult(body)).toEqual({
      todos: [{ id: TODO_ID, title: "Mine", completed: false }],
    });
  });

  it("creates, updates, and deletes through the shared service and notifies clients", async () => {
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
    const createdTodo = (toolResult(created.body) as { todo: { id: string } })
      .todo;
    expect(mockedTodos.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user_1", channel: "mcp" }),
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
    expect(toolResult(updated.body)).toEqual({
      todo: { id: TODO_ID, title: "Buy milk", completed: true },
    });

    // The handler itself still works; the gateway just never mints the
    // destructive scope for AI clients yet.
    const deleted = await callTool("delete_todo", { id: TODO_ID }, [
      "mcp:read",
      "mcp:write",
      "mcp:destructive",
    ]);
    expect(mockedTodos.delete).toHaveBeenCalledWith("user_1", { id: TODO_ID });
    expect(toolResult(deleted.body)).toEqual({
      deleted: { id: TODO_ID, title: "Buy milk", completed: true },
    });

    expect([...created.events, ...updated.events, ...deleted.events]).toEqual([
      "user_1:createTodo",
      "user_1:updateTodo",
      "user_1:deleteTodo",
    ]);
  });

  it("refuses to delete without the destructive scope", async () => {
    const { status, body } = await callTool("delete_todo", { id: TODO_ID });
    expect(status).toBe(403);
    expect(body.error?.message).toContain("mcp:destructive");
    expect(mockedTodos.delete).not.toHaveBeenCalled();
  });

  it("rejects invalid tool input before reaching the service", async () => {
    const noChanges = await callTool("update_todo", { id: TODO_ID });
    expect(noChanges.status).toBe(400);
    expect(noChanges.body.error).toMatchObject({
      code: "invalid_arguments",
      message: expect.stringContaining("Provide a title or completed value"),
    });

    const unknownField = await callTool("create_todo", {
      title: "Valid",
      userId: "user_2",
    });
    expect(unknownField.body.error?.message).toContain("Unrecognized key");
    expect(mockedTodos.update).not.toHaveBeenCalled();
    expect(mockedTodos.create).not.toHaveBeenCalled();
  });

  it("passes scoped not-found errors through without revealing another user", async () => {
    mockedTodos.update.mockRejectedValue(new TodoError("Todo not found"));

    const result = await callTool("update_todo", {
      id: TODO_ID,
      title: "Other",
    });

    expect(mockedTodos.update).toHaveBeenCalledWith("user_1", {
      id: TODO_ID,
      title: "Other",
    });
    expect(result.body.result).toEqual({
      content: [{ type: "text", text: "Todo not found" }],
      isError: true,
    });
  });

  it("masks unexpected failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockedTodos.list.mockRejectedValue(new Error("D1_ERROR: no such table"));

    const { body, callId } = await callTool("list_todos", {});

    expect(body.result).toEqual({
      content: [
        { type: "text", text: `Internal error in todo (ref ${callId})` },
      ],
      isError: true,
    });
    consoleError.mockRestore();
  });

  it("requires a tool-call identity from the gateway", async () => {
    const response = await app.fetch(
      new Request(`https://todo.example.com${TOOLS_CALL_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          v: 1,
          name: "list_todos",
          arguments: {},
          callId: "c1",
        }),
      }),
      testEnv([]),
      // TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(401);
    expect(mockedTodos.list).not.toHaveBeenCalled();
  });
});
