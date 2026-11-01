import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EveryAppUser } from "../internal";
import { fromMcpTools, type McpToolLike } from "./fromMcpTools";
import {
  ToolError,
  defineTools,
  toToolResult,
  toolSetInternals,
  validateWithSchema,
  type ToolContext,
  type ToolDefinition,
} from "./tools";

const user = {
  id: "user_1",
  email: "ana@example.com",
  orgId: "org_1",
  orgRole: "member",
  channel: "mcp",
  actor: { sub: "oauth:conn_1" },
  scopes: ["mcp:read", "mcp:write"],
  jti: "j",
  toolCall: { id: "call_1", name: "whoami" },
} as unknown as EveryAppUser;

const context = {
  user,
  env: {},
  ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
  request: new Request("https://app.example.com/__everyapp/tools/call"),
  callId: "call_1",
} as unknown as ToolContext;

/** Validate the arguments and run the tool the way the tools endpoint does. */
async function run(definition: ToolDefinition, args: unknown) {
  const input = await validateWithSchema(definition.input, args);
  if (!input.ok) throw new Error(JSON.stringify(input.issues));
  return toToolResult(
    definition,
    await definition.handler(input.value, context),
  );
}

describe("fromMcpTools", () => {
  // The shapes OpenSEO's registry hands McpServer.registerTool.
  const searchSerpLocations: McpToolLike<{ email: string }> = {
    name: "search_serp_locations",
    title: "Search SERP locations",
    description: "Find location codes.",
    inputSchema: {
      query: z.string(),
      countryCode: z.string().length(2).optional(),
    },
    outputSchema: z.object({ locations: z.array(z.string()) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: { query: string }, extra) => ({
      content: [
        { type: "text", text: `Locations for ${args.query}` },
        { type: "text", text: `asked by ${extra.email}` },
        { type: "image", data: "…", mimeType: "image/png" },
      ],
      structuredContent: { locations: ["Catonsville"] },
    }),
  };

  it("describes tools from a raw shape, zod objects and annotations", async () => {
    const definitions = fromMcpTools([
      searchSerpLocations,
      {
        name: "delete_report",
        description: "Delete a report.",
        inputSchema: z.object({ reportId: z.string() }),
        annotations: { destructiveHint: true, idempotentHint: true },
        handler: () => ({ content: [] }),
      },
      {
        name: "save_report",
        inputSchema: {
          type: "object",
          properties: { html: { type: "string" } },
          required: ["html"],
        },
        handler: () => ({ content: [] }),
      },
      { name: "whoami", handler: () => ({ content: [] }) },
    ]);
    const { tools, warnings } = await toolSetInternals(
      defineTools(definitions),
    ).catalog();
    expect(warnings).toEqual([]);
    expect(tools).toEqual([
      {
        name: "delete_report",
        description: "Delete a report.",
        risk: "destructive",
        inputSchema: {
          type: "object",
          properties: { reportId: { type: "string" } },
          required: ["reportId"],
        },
        annotations: { idempotentHint: true },
      },
      {
        name: "save_report",
        description: "save_report",
        risk: "write",
        inputSchema: {
          type: "object",
          properties: { html: { type: "string" } },
          required: ["html"],
        },
      },
      {
        name: "search_serp_locations",
        title: "Search SERP locations",
        description: "Find location codes.",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            countryCode: { type: "string", minLength: 2, maxLength: 2 },
          },
          required: ["query"],
        },
        outputSchema: expect.objectContaining({ type: "object" }),
        annotations: { openWorldHint: true },
      },
      {
        name: "whoami",
        description: "whoami",
        risk: "write",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("validates a raw shape: drops unknown keys, paths issues by field", async () => {
    const { search_serp_locations } = fromMcpTools([searchSerpLocations]);
    const input = search_serp_locations!.input;
    expect(await validateWithSchema(input, { query: "x", extra: 1 })).toEqual({
      ok: true,
      value: { query: "x" },
    });
    const bad = await validateWithSchema(input, { countryCode: "usa" });
    expect(bad.ok).toBe(false);
    expect(
      !bad.ok && bad.issues.map((issue) => issue.path?.[0]).sort(),
    ).toEqual(["countryCode", "query"]);
  });

  it("returns the text blocks for the model and the structured content", async () => {
    const extra = vi.fn((tool: ToolContext) => ({ email: tool.user.email }));
    const { search_serp_locations } = fromMcpTools([searchSerpLocations], {
      context: extra,
    });
    expect(await run(search_serp_locations!, { query: "Catonsville" })).toEqual(
      {
        content: [
          {
            type: "text",
            text: "Locations for Catonsville\n\nasked by ana@example.com",
          },
        ],
        structuredContent: { locations: ["Catonsville"] },
      },
    );
    expect(extra).toHaveBeenCalledWith(context);
  });

  it("passes the ToolContext by default and returns text alone", async () => {
    const { whoami } = fromMcpTools([
      {
        name: "whoami",
        handler: (_args, tool) => ({
          content: [{ type: "text", text: `Account: ${tool.user.email}` }],
        }),
      },
    ]);
    expect(await run(whoami!, {})).toEqual({
      content: [{ type: "text", text: "Account: ana@example.com" }],
    });
  });

  it("turns isError into a ToolError the model reads", async () => {
    const { run_site_audit } = fromMcpTools([
      {
        name: "run_site_audit",
        handler: () => ({
          content: [{ type: "text", text: "Not enough credits." }],
          isError: true,
        }),
      },
      { name: "empty", handler: () => ({ content: [], isError: true }) },
    ]);
    await expect(run(run_site_audit!, {})).rejects.toEqual(
      new ToolError("Not enough credits."),
    );
    const { empty } = fromMcpTools([
      { name: "empty", handler: () => ({ isError: true }) },
    ]);
    await expect(run(empty!, {})).rejects.toBeInstanceOf(ToolError);
  });

  it("lets the app decide risk, falling back to the annotations", () => {
    const tools = fromMcpTools(
      [
        {
          name: "save_report",
          annotations: { destructiveHint: true },
          handler: () => ({ content: [] }),
        },
        {
          name: "remove_saved_keywords",
          handler: () => ({ content: [] }),
        },
        {
          name: "list_reports",
          annotations: { readOnlyHint: true },
          handler: () => ({ content: [] }),
        },
      ],
      {
        risk: (tool) =>
          tool.annotations?.readOnlyHint
            ? undefined
            : /^(delete|remove)_/.test(tool.name)
              ? "destructive"
              : "write",
      },
    );
    expect(
      Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [name, tool.risk]),
      ),
    ).toEqual({
      save_report: "write",
      remove_saved_keywords: "destructive",
      list_reports: "read",
    });
  });

  it("refuses what it can't adapt when the app loads", () => {
    const handler = () => ({ content: [] });
    expect(() => fromMcpTools([{ name: "getWeather", handler }])).toThrow(
      /"getWeather" must be named in lowercase snake_case/,
    );
    expect(() =>
      fromMcpTools([
        { name: "a", handler },
        { name: "a", handler },
      ]),
    ).toThrow('fromMcpTools: tool "a" is listed twice');
    expect(() =>
      fromMcpTools([{ name: "a", handler: "nope" as never }]),
    ).toThrow("needs a handler function");
    const zod3Like = { "~standard": { validate: () => ({ value: {} }) } };
    expect(() =>
      fromMcpTools([{ name: "a", inputSchema: zod3Like, handler }]),
    ).toThrow("doesn't convert to JSON Schema");
    expect(() =>
      fromMcpTools([{ name: "a", inputSchema: { query: zod3Like }, handler }]),
    ).toThrow("raw shape whose fields don't convert");
  });
});
