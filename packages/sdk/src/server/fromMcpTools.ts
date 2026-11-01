/**
 * `fromMcpTools()` — an app's existing MCP tools as `defineTools()` entries.
 *
 *   const tools: McpToolLike[] = [];
 *   registerMyTools((name, config, handler) =>
 *     tools.push({ name, ...config, handler }),
 *   );
 *   export default everyApp(handler, {
 *     tools: defineTools(fromMcpTools(tools), { instructions }),
 *   });
 *
 * Takes the shape `McpServer.registerTool(name, config, handler)` is called
 * with (or what a low-level server's `tools/list` returns, plus a handler),
 * structurally: the SDK takes no dependency on `@modelcontextprotocol/sdk`,
 * and a live `McpServer` keeps its registry private, so the app hands over
 * the list it registers from.
 */
import { TOOL_NAME_PATTERN, type ToolRisk } from "../internal/index.js";
import {
  ToolError,
  toolResult,
  type StandardSchemaWithJSON,
  type ToolContext,
  type ToolDefinition,
  type ToolSchema,
} from "./tools.js";

const JSON_SCHEMA_TARGET = "draft-2020-12";

/** MCP tool annotations (all hints); only these are read. */
export interface McpToolAnnotationsLike {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** An MCP `CallToolResult`, structurally. */
export interface McpToolResultLike {
  content?: ReadonlyArray<{ readonly type: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * A tool schema as MCP servers write one: a {@link ToolSchema} (a full zod
 * object, `{ jsonSchema, validate }`), a raw shape of Standard Schemas
 * (`{ query: z.string() }`, what `McpServer.registerTool` takes), or a plain
 * JSON Schema object (a low-level server's `tools/list`), which is described
 * but not validated: the handler checks its own arguments, as it did before.
 */
export type McpToolSchemaLike =
  | ToolSchema
  | Readonly<Record<string, StandardSchemaWithJSON>>
  | Readonly<Record<string, unknown>>;

/** One MCP tool: `registerTool`'s name, config and handler, flattened. */
export interface McpToolLike<TExtra = ToolContext> {
  name: string;
  title?: string;
  description?: string;
  /** Omitted: the tool takes no arguments. */
  inputSchema?: McpToolSchemaLike;
  outputSchema?: McpToolSchemaLike;
  annotations?: McpToolAnnotationsLike;
  /**
   * Called with the validated arguments and the value of
   * {@link FromMcpToolsOptions.context} (the call's {@link ToolContext} by
   * default). Return a `CallToolResult`; throw {@link ToolError} for a message
   * the model may read.
   */
  handler: (
    args: never,
    extra: TExtra,
  ) => McpToolResultLike | Promise<McpToolResultLike>;
}

export interface FromMcpToolsOptions<TExtra = ToolContext> {
  /**
   * What each handler gets as its second argument, built per call from the
   * verified caller (`user`, `env`, `request`, `callId`). Default: the
   * {@link ToolContext} itself.
   */
  context?: (context: ToolContext) => TExtra | Promise<TExtra>;
  /**
   * A tool's risk, overriding the default for the tools it returns a risk
   * for. Default: `readOnlyHint: true` is `read`, `destructiveHint: true`
   * is `destructive`, anything else `write`.
   */
  risk?: (tool: McpToolLike<TExtra>) => ToolRisk | undefined;
}

/**
 * Adapt MCP tools into `defineTools()` entries, keyed by tool name, to spread
 * beside the app's own: `defineTools({ ...fromMcpTools(list), my_tool })`.
 *
 * - `title`, `description` (the name when absent), `idempotentHint` and
 *   `openWorldHint` carry over; risk as {@link FromMcpToolsOptions.risk}.
 * - A result's text blocks, joined by a blank line, are what the model
 *   reads; `structuredContent` is sent as structured content (checked
 *   against `outputSchema` when there is one). Other blocks are dropped.
 * - `isError: true` becomes a {@link ToolError} with the result's text.
 *
 * Names must already be lowercase snake_case; `defineTools()` checks them.
 */
export function fromMcpTools<TExtra = ToolContext>(
  tools: Iterable<McpToolLike<TExtra>>,
  options: FromMcpToolsOptions<TExtra> = {},
): Record<string, ToolDefinition> {
  const out: Record<string, ToolDefinition> = {};
  for (const tool of tools) {
    const problem = (message: string) =>
      new TypeError(`fromMcpTools: tool "${tool?.name}" ${message}`);
    if (!tool || typeof tool.name !== "string") {
      throw new TypeError("fromMcpTools: every tool needs a name");
    }
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw problem(
        "must be named in lowercase snake_case: a letter, then letters, digits or _ (at most 48 characters); rename it in the list",
      );
    }
    if (Object.prototype.hasOwnProperty.call(out, tool.name)) {
      throw problem("is listed twice");
    }
    if (typeof tool.handler !== "function") {
      throw problem("needs a handler function");
    }
    const output =
      tool.outputSchema === undefined
        ? undefined
        : toToolSchema(tool.outputSchema, problem);
    const annotations = tool.annotations ?? {};
    const title = tool.title ?? annotations.title;
    out[tool.name] = {
      ...(title !== undefined ? { title } : {}),
      description: tool.description?.trim() ? tool.description : tool.name,
      risk: options.risk?.(tool) ?? defaultRisk(annotations),
      input: toToolSchema(tool.inputSchema ?? {}, problem),
      ...(output ? { output } : {}),
      ...(annotations.idempotentHint !== undefined
        ? { idempotent: annotations.idempotentHint }
        : {}),
      ...(annotations.openWorldHint !== undefined
        ? { openWorld: annotations.openWorldHint }
        : {}),
      handler: async (args, context) => {
        const extra = options.context
          ? await options.context(context)
          : (context as TExtra);
        const result = await tool.handler(args as never, extra);
        return fromCallToolResult(result);
      },
    };
  }
  return out;
}

function defaultRisk(annotations: McpToolAnnotationsLike): ToolRisk {
  if (annotations.readOnlyHint === true) return "read";
  return annotations.destructiveHint === true ? "destructive" : "write";
}

function fromCallToolResult(result: McpToolResultLike): unknown {
  if (!isRecord(result)) {
    throw new Error("the MCP tool did not return a CallToolResult");
  }
  const text = (Array.isArray(result.content) ? result.content : [])
    .flatMap((part: unknown) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n\n");
  if (result.isError === true) throw new ToolError(text || "The tool failed.");
  const structured = result.structuredContent;
  if (isRecord(structured) && !Array.isArray(structured)) {
    return toolResult({ text, structured });
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStandardWithJson(value: unknown): value is StandardSchemaWithJSON {
  if (!isRecord(value)) return false;
  const standard = value["~standard"];
  return (
    isRecord(standard) &&
    typeof standard.validate === "function" &&
    isRecord(standard.jsonSchema)
  );
}

function isPlainToolSchema(value: Record<string, unknown>): boolean {
  return isRecord(value.jsonSchema) && typeof value.validate === "function";
}

function toToolSchema(
  schema: McpToolSchemaLike,
  problem: (message: string) => TypeError,
): ToolSchema {
  if (!isRecord(schema) || Array.isArray(schema)) {
    throw problem("has a schema that is not an object");
  }
  if (isStandardWithJson(schema) || isPlainToolSchema(schema)) {
    return schema as unknown as ToolSchema;
  }
  if ("~standard" in schema) {
    throw problem(
      "has a schema that doesn't convert to JSON Schema (zod >= 4.2 does)",
    );
  }
  const values = Object.values(schema);
  if (values.every((value) => isRecord(value) && "~standard" in value)) {
    if (!values.every(isStandardWithJson)) {
      throw problem(
        "has a raw shape whose fields don't convert to JSON Schema (zod >= 4.2 does)",
      );
    }
    return rawShapeSchema(schema as Record<string, StandardSchemaWithJSON>);
  }
  return jsonSchemaOnly(schema);
}

/** A plain JSON Schema: described as is; any object passes. */
function jsonSchemaOnly(jsonSchema: Record<string, unknown>): ToolSchema {
  return {
    jsonSchema,
    validate: (value) =>
      isRecord(value) && !Array.isArray(value)
        ? { value }
        : { issues: [{ message: "Expected an object" }] },
  };
}

type Issue = { message: string; path?: ReadonlyArray<PropertyKey> };

/**
 * `{ key: schema }` as an object schema, the way `McpServer` wraps one in
 * `z.object()`: unknown keys are dropped, and a field is optional when its
 * schema accepts `undefined`.
 */
function rawShapeSchema(
  shape: Record<string, StandardSchemaWithJSON>,
): ToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const { $schema: _, ...property } = field["~standard"].jsonSchema.input({
      target: JSON_SCHEMA_TARGET,
    });
    properties[key] = property;
    const absent = field["~standard"].validate(undefined);
    // An async validator can't be asked here; call the field required.
    if (absent instanceof Promise || absent.issues) required.push(key);
  }
  return {
    jsonSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    validate: async (value) => {
      if (!isRecord(value) || Array.isArray(value)) {
        return { issues: [{ message: "Expected an object" }] };
      }
      const parsed: Record<string, unknown> = {};
      const issues: Issue[] = [];
      for (const [key, field] of Object.entries(shape)) {
        const result = await field["~standard"].validate(value[key]);
        if (result.issues) {
          for (const issue of result.issues) {
            issues.push({
              message: issue.message,
              path: [
                key,
                ...(issue.path ?? []).map((segment) =>
                  typeof segment === "object" ? segment.key : segment,
                ),
              ],
            });
          }
        } else if (key in value || result.value !== undefined) {
          parsed[key] = result.value;
        }
      }
      return issues.length > 0 ? { issues } : { value: parsed };
    },
  };
}
