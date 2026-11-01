/**
 * `defineTools()` — agent tools an app offers to MCP clients through the
 * Every App gateway.
 *
 *   export const tools = defineTools(
 *     {
 *       list_todos: {
 *         description: "List the user's todos.",
 *         risk: "read",
 *         input: z.object({}).strict(),
 *         handler: async (_input, { user }) => listTodos(user.id),
 *       },
 *     },
 *     { instructions: "Never guess todo ids; call list_todos first." },
 *   );
 *   export default everyApp(handler, { tools });
 *
 * Apps never speak MCP. The gateway snapshots this catalog at deploy, serves
 * MCP clients from the snapshot, and calls a tool over the internal tools
 * contract (../internal/tools.ts) with a verified `chan: "mcp"` identity.
 *
 * `input` and `output` accept any validator implementing Standard Schema and
 * Standard JSON Schema (zod >= 4.2 does both), or a plain
 * `{ jsonSchema, validate }` pair. The SDK itself takes no dependency.
 */
import {
  TOOL_NAME_PATTERN,
  catalogHash,
  isToolRisk,
  type EveryAppUser,
  type ToolCallResultV1,
  type ToolDescriptorV1,
  type ToolIssueV1,
  type ToolRisk,
} from "../internal/index.js";
import type { ExecutionContextLike } from "./everyApp.js";

/** Reported with every catalog; must match package.json. */
export const SDK_VERSION = "0.3.0";

const JSON_SCHEMA_TARGET = "draft-2020-12";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
// The 2026-07-28 MCP revision lets a schema property ask clients to mirror an
// argument into an HTTP header. Apps never route on headers, and the gateway
// fronts many apps, so the hint is never passed on.
const MCP_HEADER_KEYWORD = "x-mcp-header";

/**
 * Throw from a tool handler to return an error the model can read and act on
 * ("No todo with that id"). Any other error is logged here and reaches the
 * client only as "Internal error in <app> (ref <call id>)".
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// Standard Schema v1 and Standard JSON Schema v1 (https://standardschema.dev),
// declared here rather than imported, as the spec recommends.
type StandardPathSegment = PropertyKey | { readonly key: PropertyKey };

interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<StandardPathSegment> | undefined;
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

interface StandardSchemaProps<Input, Output> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
    options?: { readonly libraryOptions?: Record<string, unknown> },
  ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?:
    | { readonly input: Input; readonly output: Output }
    | undefined;
}

interface StandardJsonSchemaConverter {
  readonly input: (options: {
    readonly target: string;
  }) => Record<string, unknown>;
  readonly output: (options: {
    readonly target: string;
  }) => Record<string, unknown>;
}

/** A Standard Schema validator that also converts to JSON Schema (zod >= 4.2). */
export interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output> & {
    readonly jsonSchema: StandardJsonSchemaConverter;
  };
}

/** For validators without Standard JSON Schema: supply the JSON Schema too. */
export interface PlainToolSchema<Output = unknown> {
  jsonSchema: Record<string, unknown>;
  validate(
    value: unknown,
  ): StandardResult<Output> | Promise<StandardResult<Output>>;
}

export type ToolSchema<Output = unknown> =
  | StandardSchemaWithJSON<unknown, Output>
  | PlainToolSchema<Output>;

/** What a tool handler receives besides its validated input. */
export interface ToolContext<TEnv = Cloudflare.Env> {
  /** The verified caller. `channel` is "mcp"; `toolCall` names this call. */
  user: EveryAppUser;
  env: TEnv;
  ctx: ExecutionContextLike;
  request: Request;
  /** Unique id of this call; also the ref in masked error messages. */
  callId: string;
}

export interface ToolDefinition<TInput = unknown> {
  /** Short human-readable name clients may show. */
  title?: string;
  /** What the tool does and when to use it. The model reads this. */
  description: string;
  /**
   * `read` changes nothing. `write` creates or changes data. `destructive`
   * deletes or irreversibly changes data; AI clients can't see or call
   * destructive tools until approvals exist.
   */
  risk: ToolRisk;
  /** Arguments schema; must describe an object. */
  input: ToolSchema<TInput>;
  /**
   * Result schema; must describe an object. The result is validated and
   * also sent as MCP structured content.
   */
  output?: ToolSchema;
  /** Repeating a call with the same arguments has no further effect. */
  idempotent?: boolean;
  /** The tool reaches systems outside this app (other APIs, the web). */
  openWorld?: boolean;
  /**
   * Return a string (sent as text), a JSON-serializable value (sent as a
   * JSON text block), or {@link toolResult} for text and data together.
   * Throw {@link ToolError} for errors the model may see.
   */
  handler: (input: TInput, context: ToolContext) => unknown;
}

const TOOL_RESULT = Symbol.for("everyapp.toolResult");

/** What {@link toolResult} returns; a handler returns it as is. */
export interface ToolResult {
  readonly [TOOL_RESULT]: true;
  readonly text: string;
  readonly structured: Record<string, unknown>;
}

/**
 * Return a written result and the same result as data. The model reads
 * `text` (a summary, a table); clients also get `structured`, checked
 * against the tool's `output` schema. Without this, a tool with an `output`
 * schema sends its value as JSON text.
 */
export function toolResult(result: {
  text: string;
  structured: Record<string, unknown>;
}): ToolResult {
  return {
    [TOOL_RESULT]: true,
    text: result.text,
    structured: result.structured,
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    isRecord(value) && (value as Partial<ToolResult>)[TOOL_RESULT] === true
  );
}

export interface DefineToolsOptions {
  /** Guidance for the model that spans this app's tools (at most 2 KB). */
  instructions?: string;
}

/** Returned by {@link defineTools}; pass it to `everyApp(…, { tools })`. */
export interface ToolSet {
  /** Tool names, sorted. */
  readonly names: readonly string[];
}

export interface ToolCatalog {
  instructions?: string;
  tools: ToolDescriptorV1[];
  hash: string;
  /** Tools left out because they can't be described, and why. */
  warnings: string[];
}

interface ToolSetInternals {
  tool(name: string): ToolDefinition | undefined;
  /** Descriptors and hash, computed once per isolate. */
  catalog(): Promise<ToolCatalog>;
}

const internals = new WeakMap<ToolSet, ToolSetInternals>();

/** @internal The everyApp() side of a tool set. */
export function toolSetInternals(toolSet: ToolSet): ToolSetInternals {
  const found = internals.get(toolSet);
  if (!found) {
    throw new TypeError("tools must be the value returned by defineTools()");
  }
  return found;
}

/**
 * Define an app's agent tools. Names are lowercase snake_case (at most 48
 * characters); the gateway prefixes them with the app id where several apps
 * share one MCP endpoint. Handler inputs are typed from each `input` schema.
 */
export function defineTools<TInputs extends Record<string, unknown>>(
  tools: { [K in keyof TInputs]: ToolDefinition<TInputs[K]> },
  options: DefineToolsOptions = {},
): ToolSet {
  const definitions = new Map<string, ToolDefinition>();
  for (const name of Object.keys(tools).sort()) {
    const definition = (tools as Record<string, ToolDefinition>)[name];
    assertToolDefinition(name, definition);
    definitions.set(name, definition);
  }
  if (
    options.instructions !== undefined &&
    typeof options.instructions !== "string"
  ) {
    throw new TypeError("defineTools: instructions must be a string");
  }

  let catalog: Promise<ToolCatalog> | undefined;
  const toolSet: ToolSet = Object.freeze({
    names: Object.freeze([...definitions.keys()]),
  });
  internals.set(toolSet, {
    tool: (name) => definitions.get(name),
    catalog: () => {
      catalog ??= buildCatalog(definitions, options.instructions).catch(
        (error: unknown) => {
          catalog = undefined;
          throw error;
        },
      );
      return catalog;
    },
  });
  return toolSet;
}

function assertToolDefinition(
  name: string,
  definition: ToolDefinition | undefined,
): asserts definition is ToolDefinition {
  const problem = (message: string) =>
    new TypeError(`defineTools: tool "${name}" ${message}`);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw problem(
      "must be named in lowercase snake_case: a letter, then letters, digits or _ (at most 48 characters)",
    );
  }
  if (!definition || typeof definition !== "object") {
    throw problem("must be an object");
  }
  if (
    typeof definition.description !== "string" ||
    !definition.description.trim()
  ) {
    throw problem("needs a description");
  }
  if (!isToolRisk(definition.risk)) {
    throw problem('needs a risk: "read", "write" or "destructive"');
  }
  if (!isToolSchema(definition.input)) {
    throw problem(
      "input must be a Standard Schema with JSON Schema support (zod >= 4.2) or { jsonSchema, validate }",
    );
  }
  if (definition.output !== undefined && !isToolSchema(definition.output)) {
    throw problem(
      "output must be a Standard Schema with JSON Schema support (zod >= 4.2) or { jsonSchema, validate }",
    );
  }
  if (typeof definition.handler !== "function") {
    throw problem("needs a handler function");
  }
  if (definition.title !== undefined && typeof definition.title !== "string") {
    throw problem("title must be a string");
  }
  for (const flag of ["idempotent", "openWorld"] as const) {
    if (
      definition[flag] !== undefined &&
      typeof definition[flag] !== "boolean"
    ) {
      throw problem(`${flag} must be a boolean`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null
  );
}

function isPlainToolSchema(value: unknown): value is PlainToolSchema {
  return (
    isRecord(value) &&
    !("~standard" in value) &&
    isRecord(value.jsonSchema) &&
    typeof value.validate === "function"
  );
}

function isStandardWithJson(value: unknown): value is StandardSchemaWithJSON {
  if (!isRecord(value)) return false;
  const standard = value["~standard"];
  if (!isRecord(standard) || typeof standard.validate !== "function") {
    return false;
  }
  const converter = standard.jsonSchema;
  return (
    isRecord(converter) &&
    typeof converter.input === "function" &&
    typeof converter.output === "function"
  );
}

function isToolSchema(value: unknown): value is ToolSchema {
  return isStandardWithJson(value) || isPlainToolSchema(value);
}

/**
 * Describe every tool that can be described. A tool whose schema has no
 * object JSON Schema form is left out with a warning (logged here, and
 * reported to the gateway so the deploy prints it) instead of taking the
 * app's other tools down with it.
 */
async function buildCatalog(
  definitions: ReadonlyMap<string, ToolDefinition>,
  instructions: string | undefined,
): Promise<ToolCatalog> {
  const tools: ToolDescriptorV1[] = [];
  const warnings: string[] = [];
  for (const [name, definition] of definitions) {
    const described = describeTool(name, definition);
    if (typeof described === "string") {
      warnings.push(`${name}: skipped, ${described}`);
      console.warn(`[everyapp] defineTools: tool "${name}" ${described}`);
    } else {
      tools.push(described);
    }
  }
  return {
    ...(instructions !== undefined ? { instructions } : {}),
    tools,
    hash: await catalogHash({ instructions, tools }),
    warnings,
  };
}

/** A tool's descriptor, or why it can't be described. */
function describeTool(
  name: string,
  definition: ToolDefinition,
): ToolDescriptorV1 | string {
  const inputSchema = objectJsonSchema(definition.input, "input");
  if (typeof inputSchema === "string") return inputSchema;
  const outputSchema = definition.output
    ? objectJsonSchema(definition.output, "output")
    : undefined;
  if (typeof outputSchema === "string") return outputSchema;
  const annotations = {
    ...(definition.idempotent !== undefined
      ? { idempotentHint: definition.idempotent }
      : {}),
    ...(definition.openWorld !== undefined
      ? { openWorldHint: definition.openWorld }
      : {}),
  };
  return {
    name,
    ...(definition.title ? { title: definition.title } : {}),
    description: definition.description,
    risk: definition.risk,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

/**
 * The JSON Schema for one side of a tool: the arguments a client sends
 * (`input`) or the result it receives (`output`), or why there is none.
 *
 * Both sides must describe objects. Unions of objects (zod's `union` and
 * `discriminatedUnion`) come out as a root `anyOf`/`oneOf` without a `type`,
 * so like the MCP SDK this adds `type: "object"` to a typeless input root
 * (MCP arguments are always an object) and to a typeless output root whose
 * every branch is an object.
 */
function objectJsonSchema(
  schema: ToolSchema,
  side: "input" | "output",
): Record<string, unknown> | string {
  let raw: unknown;
  try {
    raw = isPlainToolSchema(schema)
      ? schema.jsonSchema
      : schema["~standard"].jsonSchema[side]({ target: JSON_SCHEMA_TARGET });
    // A JSON round trip copies the schema and drops anything JSON can't carry.
    raw = JSON.parse(JSON.stringify(raw));
  } catch (error) {
    return `${side} has no JSON Schema form: ${(error as Error).message}`;
  }
  if (!isRecord(raw) || Array.isArray(raw)) {
    return `${side} has no JSON Schema form`;
  }
  const copy = withoutMcpHeaders(raw) as Record<string, unknown>;
  if (copy.$schema === DRAFT_2020_12) delete copy.$schema;
  if (
    copy.type === undefined &&
    (side === "input" || isProvablyObjectShaped(copy))
  ) {
    return { type: "object", ...copy };
  }
  if (copy.type !== "object") {
    return `${side} must describe an object (JSON Schema type "object")`;
  }
  return copy;
}

/**
 * A typeless schema that can only match objects: it has object keywords, or
 * every branch of its `oneOf`/`anyOf`/`allOf` is an object. `$ref` is not
 * followed.
 */
function isProvablyObjectShaped(schema: Record<string, unknown>): boolean {
  if (
    [
      "properties",
      "patternProperties",
      "additionalProperties",
      "required",
    ].some((keyword) => keyword in schema)
  ) {
    return true;
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.every(
        (branch) =>
          isRecord(branch) &&
          (branch.type === "object" || isProvablyObjectShaped(branch)),
      );
    }
  }
  return false;
}

function withoutMcpHeaders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMcpHeaders);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== MCP_HEADER_KEYWORD) out[key] = withoutMcpHeaders(member);
  }
  return out;
}

export type ValidationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ToolIssueV1[] };

/** Run a tool schema's validator. */
export async function validateWithSchema<T>(
  schema: ToolSchema<T>,
  value: unknown,
): Promise<ValidationOutcome<T>> {
  const result = isPlainToolSchema(schema)
    ? await schema.validate(value)
    : await schema["~standard"].validate(value);
  if (result.issues) {
    return { ok: false, issues: result.issues.map(toIssue) };
  }
  return { ok: true, value: result.value };
}

function toIssue(issue: StandardIssue): ToolIssueV1 {
  const path = (issue.path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null ? segment.key : segment,
    )
    .filter(
      (key): key is string | number =>
        typeof key === "string" || typeof key === "number",
    );
  return {
    message: String(issue.message),
    ...(path.length > 0 ? { path } : {}),
  };
}

/**
 * Turn a handler's return value into a tool result. With an output schema,
 * the value must validate and is sent as structured content as well as text.
 */
export async function toToolResult(
  definition: ToolDefinition,
  value: unknown,
): Promise<ToolCallResultV1> {
  if (isToolResult(value)) {
    const structured = definition.output
      ? (await toToolResult(definition, value.structured)).structuredContent
      : value.structured;
    if (!isRecord(structured) || Array.isArray(structured)) {
      throw new Error("structured results must be JSON objects");
    }
    return {
      content: [{ type: "text", text: value.text }],
      structuredContent: structured,
    };
  }
  if (definition.output) {
    const checked = await validateWithSchema(definition.output, value);
    if (!checked.ok) {
      throw new Error(
        `result does not match the output schema: ${checked.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    if (
      !isRecord(checked.value) ||
      Array.isArray(checked.value) ||
      typeof checked.value === "function"
    ) {
      throw new Error("structured results must be JSON objects");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(checked.value) }],
      structuredContent: checked.value,
    };
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  if (value === undefined) return { content: [] };
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
