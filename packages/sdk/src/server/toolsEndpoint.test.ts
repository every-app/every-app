import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { z } from "zod";
import {
  IDENTITY_HEADER,
  SYSTEM_HEADER,
  TOOLS_CALL_PATH,
  TOOLS_LIST_PATH,
  mintIdentityJwt,
  mintPublicMarkerJwt,
  mintSystemJwt,
  type IdentityChannel,
  type ToolsListResponseV1,
} from "../internal";
import { everyApp } from "./everyApp";
import { ToolError, defineTools, type ToolContext } from "./tools";

const ISSUER = "https://home.example.com";
// TODO(integration): PR 2 types ctx as the runtime ExecutionContext.
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(keys.privateKey);
  publicKeyPem = await exportSPKI(keys.publicKey);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const seen: { contexts: ToolContext[] } = { contexts: [] };

const tools = defineTools(
  {
    list_todos: {
      description: "List todos.",
      risk: "read",
      input: z.object({}).strict(),
      handler: (_input, context) => {
        seen.contexts.push(context);
        return { todos: [], user: context.user.id };
      },
    },
    create_todo: {
      description: "Create a todo.",
      risk: "write",
      input: z.object({ title: z.string().trim().min(1) }).strict(),
      handler: ({ title }) => `created ${title}`,
    },
    delete_todo: {
      description: "Delete a todo.",
      risk: "destructive",
      input: z.object({ id: z.string() }).strict(),
      handler: () => "deleted",
    },
    find_todo: {
      description: "Find one todo.",
      risk: "read",
      input: z.object({ id: z.string() }).strict(),
      output: z.object({ id: z.string() }),
      handler: ({ id }) => {
        if (id === "missing") throw new ToolError("No todo with that id");
        if (id === "boom") throw new Error("db password=hunter2 exploded");
        if (id === "bad-output") return { id: 7 };
        return { id };
      },
    },
  },
  { instructions: "Never guess ids." },
);

function appWith(options: Parameters<typeof everyApp>[2]) {
  return everyApp(
    async () => Response.json({ handler: true }),
    { id: "todo" },
    options,
  );
}

let app: ReturnType<typeof appWith>;
beforeAll(() => {
  app = appWith({ publicKeys: [publicKeyPem], issuer: ISSUER, tools });
});

// The Worker's name, as everyAppWorker() deploys it: the token audience.
const WORKER = "every-todo";
const fetchApp = (request: Request, target = app) =>
  target.fetch(request, { EVERYAPP_AUDIENCE: WORKER }, ctx);

const subject = {
  sub: "user_1",
  email: "a@b.com",
  orgId: "org_1",
  orgRole: "member",
};

function identity(
  overrides: {
    channel?: IdentityChannel;
    scopes?: string[];
    toolCall?: { id: string; name: string } | null;
    audience?: string;
  } = {},
): Promise<string> {
  return mintIdentityJwt(privateKeyPem, {
    subject,
    audience: overrides.audience ?? WORKER,
    issuer: ISSUER,
    channel: overrides.channel ?? "mcp",
    actor: { sub: "pat:tok_1" },
    scopes: overrides.scopes ?? ["mcp:read", "mcp:write"],
    toolCall:
      overrides.toolCall === null
        ? undefined
        : (overrides.toolCall ?? { id: "call_1", name: "list_todos" }),
  });
}

function systemToken(audience = WORKER): Promise<string> {
  return mintSystemJwt(privateKeyPem, {
    audience,
    issuer: ISSUER,
    purpose: "tools.list",
  });
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://todo.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function call(
  name: string,
  args: Record<string, unknown>,
  token?: string,
  callId = "call_1",
) {
  const response = await fetchApp(
    post(
      TOOLS_CALL_PATH,
      { v: 1, name, arguments: args, callId },
      {
        [IDENTITY_HEADER]:
          token ?? (await identity({ toolCall: { id: callId, name } })),
      },
    ),
  );
  return { status: response.status, body: (await response.json()) as any };
}

describe("POST /__everyapp/tools/list", () => {
  it("returns the catalog to the gateway's system token", async () => {
    const response = await fetchApp(
      post(TOOLS_LIST_PATH, { v: 1 }, { [SYSTEM_HEADER]: await systemToken() }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ToolsListResponseV1;
    expect(body).toMatchObject({
      v: 1,
      sdk: "0.3.0",
      instructions: "Never guess ids.",
    });
    expect(body.hash).toMatch(/^sha256:/);
    expect(body.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["create_todo", "write"],
      ["delete_todo", "destructive"],
      ["find_todo", "read"],
      ["list_todos", "read"],
    ]);
  });

  it("refuses a missing token, another app's token and a user identity", async () => {
    const userIdentity = await identity();
    const cases: Record<string, string>[] = [
      {},
      // Same app id, another Worker (another organization's copy).
      { [SYSTEM_HEADER]: await systemToken("every-other-todo") },
      { [SYSTEM_HEADER]: userIdentity },
      { [IDENTITY_HEADER]: userIdentity },
    ];
    for (const headers of cases) {
      const response = await fetchApp(post(TOOLS_LIST_PATH, { v: 1 }, headers));
      expect(response.status, JSON.stringify(Object.keys(headers))).toBe(401);
      expect(await response.json()).toMatchObject({
        v: 1,
        error: { code: "unauthenticated" },
      });
    }
  });

  it("refuses other contract versions and methods", async () => {
    const versioned = await fetchApp(
      post(TOOLS_LIST_PATH, { v: 2 }, { [SYSTEM_HEADER]: await systemToken() }),
    );
    expect(versioned.status).toBe(400);

    const get = await fetchApp(
      new Request(`https://todo.example.com${TOOLS_LIST_PATH}`),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("lists and runs the other tools when one can't be described", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const mixed = defineTools({
      bad: {
        description: "Takes a bare string.",
        risk: "read",
        input: z.string() as never,
        handler: () => "x",
      },
      find_todo: {
        description: "Find a todo by title or id.",
        risk: "read",
        input: z.discriminatedUnion("by", [
          z.object({ by: z.literal("title"), title: z.string() }),
          z.object({ by: z.literal("id"), id: z.string() }),
        ]),
        handler: (input) =>
          input.by === "id" ? `todo ${input.id}` : `todo "${input.title}"`,
      },
      list_todos: {
        description: "List todos.",
        risk: "read",
        input: z.object({}).strict(),
        handler: () => "[]",
      },
    });
    const mixedApp = appWith({
      publicKeys: [publicKeyPem],
      issuer: ISSUER,
      tools: mixed,
    });

    const list = await fetchApp(
      post(TOOLS_LIST_PATH, { v: 1 }, { [SYSTEM_HEADER]: await systemToken() }),
      mixedApp,
    );
    expect(list.status).toBe(200);
    const catalog = (await list.json()) as ToolsListResponseV1;
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "find_todo",
      "list_todos",
    ]);
    expect(catalog.warnings).toEqual([
      'bad: skipped, input must describe an object (JSON Schema type "object")',
    ]);
    expect(consoleWarn).toHaveBeenCalledOnce();

    for (const [name, args, text] of [
      ["list_todos", {}, "[]"],
      ["find_todo", { by: "id", id: "t1" }, "todo t1"],
      ["find_todo", { by: "title", title: "milk" }, 'todo "milk"'],
    ] as const) {
      const response = await fetchApp(
        post(
          TOOLS_CALL_PATH,
          { v: 1, name, arguments: args, callId: "call_1" },
          {
            [IDENTITY_HEADER]: await identity({
              toolCall: { id: "call_1", name },
            }),
          },
        ),
        mixedApp,
      );
      expect(response.status, text).toBe(200);
      expect(await response.json()).toEqual({
        v: 1,
        catalogHash: catalog.hash,
        result: { content: [{ type: "text", text }] },
      });
    }
  });

  it("runs a tool even when the catalog can't be built", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(
      new Error("no digest"),
    );
    const fresh = defineTools({
      list_todos: {
        description: "List todos.",
        risk: "read",
        input: z.object({}).strict(),
        handler: () => "[]",
      },
    });
    const response = await fetchApp(
      post(
        TOOLS_CALL_PATH,
        { v: 1, name: "list_todos", arguments: {}, callId: "call_1" },
        { [IDENTITY_HEADER]: await identity() },
      ),
      appWith({ publicKeys: [publicKeyPem], issuer: ISSUER, tools: fresh }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      v: 1,
      // An empty hash makes the gateway re-sync, which reports the problem.
      catalogHash: "",
      result: { content: [{ type: "text", text: "[]" }] },
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it("answers with an empty catalog for an app without tools", async () => {
    const response = await fetchApp(
      post(TOOLS_LIST_PATH, { v: 1 }, { [SYSTEM_HEADER]: await systemToken() }),
      appWith({ publicKeys: [publicKeyPem], issuer: ISSUER }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ v: 1, tools: [] });
  });
});

describe("POST /__everyapp/tools/call", () => {
  it("runs the tool for the verified caller and reports the catalog hash", async () => {
    seen.contexts = [];
    const { status, body } = await call("list_todos", {});

    expect(status).toBe(200);
    expect(body).toEqual({
      v: 1,
      catalogHash: expect.stringMatching(/^sha256:/),
      result: {
        content: [{ type: "text", text: '{"todos":[],"user":"user_1"}' }],
      },
    });
    expect(seen.contexts[0]).toMatchObject({
      callId: "call_1",
      user: {
        id: "user_1",
        channel: "mcp",
        toolCall: { id: "call_1", name: "list_todos" },
      },
    });
  });

  it("validates arguments with the tool's schema", async () => {
    const created = await call("create_todo", { title: "  milk  " });
    expect(created.body.result.content[0].text).toBe("created milk");

    const invalid = await call("create_todo", { title: "", extra: 1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("invalid_arguments");
    expect(invalid.body.error.message).toContain("Invalid arguments");
    expect(invalid.body.error.issues.length).toBeGreaterThan(0);
  });

  it("requires the scope the tool's risk needs, never accepting *", async () => {
    const readOnly = await identity({
      scopes: ["mcp:read"],
      toolCall: { id: "call_1", name: "create_todo" },
    });
    const wildcard = await identity({
      scopes: ["*"],
      toolCall: { id: "call_1", name: "create_todo" },
    });
    for (const token of [readOnly, wildcard]) {
      const { status, body } = await call("create_todo", { title: "x" }, token);
      expect(status).toBe(403);
      expect(body.error.message).toContain("mcp:write");
    }

    const destructive = await call("delete_todo", { id: "1" });
    expect(destructive.status).toBe(403);
    expect(destructive.body.error.message).toContain("mcp:destructive");
  });

  it("only accepts an identity minted for this exact call", async () => {
    const cases: [string, Promise<string>][] = [
      ["web channel", identity({ channel: "web" })],
      ["no tc claim", identity({ toolCall: null })],
      [
        "other tool",
        identity({ toolCall: { id: "call_1", name: "create_todo" } }),
      ],
      [
        "other call id",
        identity({ toolCall: { id: "call_2", name: "list_todos" } }),
      ],
    ];
    for (const [label, token] of cases) {
      const { status, body } = await call("list_todos", {}, await token);
      expect(status, label).toBe(403);
      expect(body.error.code, label).toBe("forbidden");
    }
  });

  it("refuses system tokens, public markers and other apps' identities", async () => {
    const marker = await mintPublicMarkerJwt(privateKeyPem, {
      audience: WORKER,
      issuer: ISSUER,
    });
    for (const token of [
      await systemToken(),
      marker,
      await identity({ audience: "every-other-todo" }),
    ]) {
      const { status } = await call("list_todos", {}, token);
      expect(status).toBe(401);
    }
    const viaSystemHeader = await fetchApp(
      post(
        TOOLS_CALL_PATH,
        { v: 1, name: "list_todos", arguments: {}, callId: "call_1" },
        { [SYSTEM_HEADER]: await systemToken() },
      ),
    );
    expect(viaSystemHeader.status).toBe(401);
  });

  it("answers unknown tools and malformed requests", async () => {
    const unknown = await call("nope", {});
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("unknown_tool");

    const malformed = await fetchApp(
      post(
        TOOLS_CALL_PATH,
        { v: 1, name: "list_todos", arguments: [], callId: "call_1" },
        { [IDENTITY_HEADER]: await identity() },
      ),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("passes ToolError messages through and masks everything else", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const token = (callId: string) =>
      identity({ toolCall: { id: callId, name: "find_todo" } });

    const missing = await call(
      "find_todo",
      { id: "missing" },
      await token("c1"),
      "c1",
    );
    expect(missing.body.result).toEqual({
      content: [{ type: "text", text: "No todo with that id" }],
      isError: true,
    });

    const boom = await call(
      "find_todo",
      { id: "boom" },
      await token("c2"),
      "c2",
    );
    expect(boom.status).toBe(200);
    expect(boom.body.result).toEqual({
      content: [{ type: "text", text: "Internal error in todo (ref c2)" }],
      isError: true,
    });
    expect(JSON.stringify(boom.body)).not.toContain("hunter2");
    expect(consoleError).toHaveBeenCalledWith(
      '[everyapp] tool "find_todo" failed (ref c2):',
      expect.any(Error),
    );

    const badOutput = await call(
      "find_todo",
      { id: "bad-output" },
      await token("c3"),
      "c3",
    );
    expect(badOutput.body.result.isError).toBe(true);
  });

  it("returns structured content for tools with an output schema", async () => {
    const found = await call(
      "find_todo",
      { id: "t1" },
      await identity({ toolCall: { id: "c4", name: "find_todo" } }),
      "c4",
    );
    expect(found.body.result).toEqual({
      content: [{ type: "text", text: '{"id":"t1"}' }],
      structuredContent: { id: "t1" },
    });
  });

  it("answers unknown_tool for apps without tools", async () => {
    const response = await fetchApp(
      post(
        TOOLS_CALL_PATH,
        { v: 1, name: "list_todos", arguments: {}, callId: "call_1" },
        { [IDENTITY_HEADER]: await identity() },
      ),
      appWith({ publicKeys: [publicKeyPem], issuer: ISSUER }),
    );
    expect(response.status).toBe(404);
  });
});

describe("everyApp routing around the tools contract", () => {
  it("leaves every other path to the app's handler", async () => {
    const response = await fetchApp(
      new Request("https://todo.example.com/__everyapp/toolsx", {
        headers: { [IDENTITY_HEADER]: await identity({ channel: "web" }) },
      }),
    );
    expect(await response.json()).toEqual({ handler: true });
  });

  it("reports a missing key set as a configuration error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await fetchApp(
      post(TOOLS_LIST_PATH, { v: 1 }, { [SYSTEM_HEADER]: await systemToken() }),
      appWith({ issuer: ISSUER, tools }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "misconfigured" },
    });
    expect(consoleError).toHaveBeenCalled();
  });
});
