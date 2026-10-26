import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTools, everyApp, ToolError } from "../server/index.js";
import {
  TEST_USER,
  callTool,
  listTools,
  testContext,
  testEnv,
  testRequest,
} from "./index.js";

const tools = defineTools({
  whoami: {
    description: "Who is calling.",
    risk: "read",
    input: z.object({}).strict(),
    handler: (_input, { user }) => ({ id: user.id, orgId: user.orgId }),
  },
  remove: {
    description: "Remove something.",
    risk: "destructive",
    input: z.object({ id: z.string() }).strict(),
    handler: ({ id }) => {
      throw new ToolError(`No thing ${id}`);
    },
  },
});

const worker = everyApp(
  (_request, _env, _ctx, user) => Response.json({ id: user?.id }),
  { tools },
);

describe("testRequest", () => {
  it("signs in the default person, whom everyApp() verifies", async () => {
    const response = await worker.fetch(
      await testRequest("https://app.test/"),
      testEnv(),
      testContext(),
    );
    expect(await response.json()).toEqual({ id: TEST_USER.id });
  });

  it("signs in the person given, for the app given", async () => {
    const response = await worker.fetch(
      await testRequest("https://app.test/", {
        user: { id: "ana" },
        appId: "notes",
      }),
      testEnv({ appId: "notes" }),
      testContext(),
    );
    expect(await response.json()).toEqual({ id: "ana" });
  });

  it("signs in nobody with user: null", async () => {
    const response = await worker.fetch(
      await testRequest("https://app.test/", { user: null }),
      testEnv(),
      testContext(),
    );
    expect(response.status).toBe(401);
  });
});

describe("testEnv", () => {
  it("adds the app's own bindings", () => {
    const env = testEnv({ appId: "notes", DB: "db" });
    expect(env).toMatchObject({ EVERYAPP_APP_ID: "notes", DB: "db" });
    expect(env).not.toHaveProperty("appId");
  });
});

describe("callTool", () => {
  it("calls a tool through the worker as the person given", async () => {
    const response = await callTool(
      worker,
      "whoami",
      {},
      {
        user: { id: "bo", orgId: "org_b" },
      },
    );
    expect(response).toMatchObject({
      result: { content: [{ text: '{"id":"bo","orgId":"org_b"}' }] },
    });
  });

  it("calls a tool set alone, and reports what the model reads", async () => {
    const response = await callTool(tools, "remove", { id: "7" });
    expect(response).toMatchObject({
      result: { isError: true, content: [{ text: "No thing 7" }] },
    });
  });

  it("refuses a call the scopes don't cover", async () => {
    const response = await callTool(
      tools,
      "remove",
      { id: "7" },
      {
        scopes: ["mcp:read"],
      },
    );
    expect(response).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("listTools", () => {
  it("reads the catalog as the Gateway does", async () => {
    const catalog = await listTools(worker);
    expect(catalog.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["remove", "destructive"],
      ["whoami", "read"],
    ]);
  });
});
