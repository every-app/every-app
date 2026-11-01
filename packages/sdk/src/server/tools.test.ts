import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { catalogHash } from "../internal";
import {
  SDK_VERSION,
  defineTools,
  toToolResult,
  toolResult,
  toolSetInternals,
  validateWithSchema,
  type PlainToolSchema,
  type ToolDefinition,
} from "./tools";

const noop = () => "ok";

describe("defineTools", () => {
  it("lists tool names in order and types inputs from their schemas", async () => {
    const tools = defineTools({
      update_todo: {
        description: "Change a todo.",
        risk: "write",
        input: z.object({ id: z.string(), done: z.boolean() }).strict(),
        handler: (input) => {
          const done: boolean = input.done;
          return { id: input.id, done };
        },
      },
      list_todos: {
        description: "List todos.",
        risk: "read",
        input: z.object({}).strict(),
        handler: noop,
      },
    });
    expect(tools.names).toEqual(["list_todos", "update_todo"]);
  });

  it("rejects malformed definitions when the app loads", () => {
    const valid = {
      description: "d",
      risk: "read",
      input: z.object({}),
      handler: noop,
    } as const;
    const cases: [string, Record<string, unknown>, string][] = [
      ["ListTodos", valid, "lowercase snake_case"],
      ["list-todos", valid, "lowercase snake_case"],
      ["x".repeat(49), valid, "lowercase snake_case"],
      ["list", { ...valid, description: " " }, "needs a description"],
      ["list", { ...valid, risk: "admin" }, "needs a risk"],
      ["list", { ...valid, risk: undefined }, "needs a risk"],
      ["list", { ...valid, input: { parse: noop } }, "input must be"],
      ["list", { ...valid, output: "nope" }, "output must be"],
      ["list", { ...valid, handler: "nope" }, "needs a handler"],
      ["list", { ...valid, idempotent: "yes" }, "idempotent must be"],
    ];
    for (const [name, definition, message] of cases) {
      expect(
        () =>
          defineTools({
            [name]: definition as unknown as ToolDefinition,
          }),
        `${name} ${message}`,
      ).toThrow(message);
    }
  });

  it("explains that a Standard Schema without JSON Schema support needs zod >= 4.2", () => {
    const standardOnly = {
      "~standard": { version: 1, vendor: "x", validate: () => ({ value: 1 }) },
    };
    expect(() =>
      defineTools({
        list: {
          description: "d",
          risk: "read",
          input: standardOnly as never,
          handler: noop,
        },
      }),
    ).toThrow("zod >= 4.2");
  });
});

describe("tool catalog", () => {
  it("describes tools as JSON Schema, with hints and without dialect noise", async () => {
    const tools = defineTools(
      {
        create_todo: {
          title: "Create todo",
          description: "Create a todo.",
          risk: "write",
          idempotent: false,
          openWorld: false,
          input: z
            .object({
              title: z.string().trim().min(1).max(255).describe("The task."),
              list: z.string().meta({ "x-mcp-header": "List" }).optional(),
            })
            .strict(),
          output: z.object({ id: z.string() }),
          handler: () => ({ id: "t1" }),
        },
      },
      { instructions: "Call list_todos first." },
    );

    const catalog = await toolSetInternals(tools).catalog();

    expect(catalog.instructions).toBe("Call list_todos first.");
    expect(catalog.tools).toEqual([
      {
        name: "create_todo",
        title: "Create todo",
        description: "Create a todo.",
        risk: "write",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: 255,
              description: "The task.",
            },
            list: { type: "string" },
          },
          required: ["title"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        annotations: { idempotentHint: false, openWorldHint: false },
      },
    ]);
    expect(catalog.hash).toBe(
      await catalogHash({
        instructions: "Call list_todos first.",
        tools: catalog.tools,
      }),
    );
  });

  it("computes the catalog once per isolate", async () => {
    const internals = toolSetInternals(
      defineTools({
        list: {
          description: "d",
          risk: "read",
          input: z.object({}),
          handler: noop,
        },
      }),
    );
    expect(await internals.catalog()).toBe(await internals.catalog());
  });

  it("accepts a plain { jsonSchema, validate } pair", async () => {
    const plain: PlainToolSchema<{ q: string }> = {
      jsonSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
      validate: (value) =>
        typeof (value as { q?: unknown })?.q === "string"
          ? { value: value as { q: string } }
          : { issues: [{ message: "q is required", path: ["q"] }] },
    };
    const internals = toolSetInternals(
      defineTools({
        search: {
          description: "Search",
          risk: "read",
          input: plain,
          handler: (input) => input.q,
        },
      }),
    );
    const [descriptor] = (await internals.catalog()).tools;
    expect(descriptor?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    await expect(validateWithSchema(plain, {})).resolves.toEqual({
      ok: false,
      issues: [{ message: "q is required", path: ["q"] }],
    });
  });

  it("describes unions of objects as objects", async () => {
    const byTitleOrId = z.discriminatedUnion("by", [
      z.object({ by: z.literal("title"), title: z.string() }),
      z.object({ by: z.literal("id"), id: z.string() }),
    ]);
    const internals = toolSetInternals(
      defineTools({
        find_todo: {
          description: "Find a todo by title or id.",
          risk: "read",
          input: byTitleOrId,
          output: z.union([
            z.object({ found: z.literal(true), id: z.string() }),
            z.object({ found: z.literal(false) }),
          ]),
          handler: noop,
        },
      }),
    );
    const { tools, warnings } = await internals.catalog();
    expect(warnings).toEqual([]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      oneOf: [
        { type: "object", required: ["by", "title"] },
        { type: "object", required: ["by", "id"] },
      ],
    });
    expect(tools[0]?.outputSchema).toMatchObject({
      type: "object",
      anyOf: [{ type: "object" }, { type: "object" }],
    });
  });

  it("leaves out only a tool it can't describe, with a warning", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const internals = toolSetInternals(
      defineTools({
        bad_input: {
          description: "Takes a bare string.",
          risk: "read",
          input: z.string() as never,
          handler: noop,
        },
        bad_output: {
          description: "Returns a bare number.",
          risk: "read",
          input: z.object({}),
          output: z.number() as never,
          handler: noop,
        },
        list_todos: {
          description: "List todos.",
          risk: "read",
          input: z.object({}),
          handler: noop,
        },
      }),
    );

    const catalog = await internals.catalog();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["list_todos"]);
    expect(catalog.warnings).toEqual([
      'bad_input: skipped, input must describe an object (JSON Schema type "object")',
      'bad_output: skipped, output must describe an object (JSON Schema type "object")',
    ]);
    expect(catalog.hash).toBe(await catalogHash({ tools: catalog.tools }));
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    consoleWarn.mockRestore();
  });
});

describe("tool results", () => {
  const plainTool = (output?: ToolDefinition["output"]): ToolDefinition => ({
    description: "d",
    risk: "read",
    input: z.object({}),
    output,
    handler: noop,
  });

  it("sends strings as text, values as JSON text, and nothing for undefined", async () => {
    await expect(toToolResult(plainTool(), "hi")).resolves.toEqual({
      content: [{ type: "text", text: "hi" }],
    });
    await expect(toToolResult(plainTool(), { a: 1 })).resolves.toEqual({
      content: [{ type: "text", text: '{"a":1}' }],
    });
    await expect(toToolResult(plainTool(), undefined)).resolves.toEqual({
      content: [],
    });
  });

  it("validates against the output schema and adds structured content", async () => {
    const tool = plainTool(z.object({ n: z.number() }));
    await expect(toToolResult(tool, { n: 2 })).resolves.toEqual({
      content: [{ type: "text", text: '{"n":2}' }],
      structuredContent: { n: 2 },
    });
    await expect(toToolResult(tool, { n: "2" })).rejects.toThrow(
      "does not match the output schema",
    );
  });

  it("sends a toolResult's text for the model and its checked data as structured content", async () => {
    const tool = plainTool(z.object({ n: z.number() }));
    await expect(
      toToolResult(
        tool,
        toolResult({ text: "Two rows.", structured: { n: 2 } }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Two rows." }],
      structuredContent: { n: 2 },
    });
    await expect(
      toToolResult(tool, toolResult({ text: "x", structured: { n: "2" } })),
    ).rejects.toThrow("does not match the output schema");
  });
});

describe("SDK_VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
