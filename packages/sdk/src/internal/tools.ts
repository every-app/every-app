/**
 * The internal tools contract (v1) between the gateway's ToolBus and an app's
 * `everyApp()` wrapper. Two reserved endpoints, reached only over the
 * gateway's service binding and never public:
 *
 *   POST /__everyapp/tools/list  x-everyapp-system JWT (purpose "tools.list")
 *   POST /__everyapp/tools/call  x-everyapp-identity JWT, chan "mcp" + tc claim
 *
 * MCP itself (protocol eras, headers, envelopes) stays in the gateway; apps
 * only ever speak this small versioned JSON shape. Both sides import the
 * shapes, paths and the catalog hash from here so they cannot drift.
 */

export const TOOLS_PROTOCOL_VERSION = 1;
export const TOOLS_PATH_PREFIX = "/__everyapp/tools";
export const TOOLS_LIST_PATH = `${TOOLS_PATH_PREFIX}/list`;
export const TOOLS_CALL_PATH = `${TOOLS_PATH_PREFIX}/call`;

export const TOOL_RISKS = ["read", "write", "destructive"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

/** Scopes the gateway mints on `chan: "mcp"` identities, one per risk. */
export const MCP_READ_SCOPE = "mcp:read";
export const MCP_WRITE_SCOPE = "mcp:write";
/** Never minted in v1: destructive tools are hidden until approvals exist. */
export const MCP_DESTRUCTIVE_SCOPE = "mcp:destructive";

/** Local tool names: lowercase snake_case, at most 48 characters. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

export function isToolRisk(value: unknown): value is ToolRisk {
  return (
    typeof value === "string" &&
    (TOOL_RISKS as readonly string[]).includes(value)
  );
}

/** The exact scope a `chan: "mcp"` identity must carry to call a tool. */
export function requiredScopeForRisk(risk: ToolRisk): string {
  switch (risk) {
    case "read":
      return MCP_READ_SCOPE;
    case "write":
      return MCP_WRITE_SCOPE;
    case "destructive":
      return MCP_DESTRUCTIVE_SCOPE;
  }
}

export interface ToolAnnotationsV1 {
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One tool as an app describes it to the gateway. */
export interface ToolDescriptorV1 {
  name: string;
  title?: string;
  description: string;
  risk: ToolRisk;
  /** JSON Schema (draft 2020-12) of the arguments; always `type: "object"`. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotationsV1;
}

export interface ToolsListRequestV1 {
  v: 1;
}

export interface ToolsListResponseV1 {
  v: 1;
  /** The SDK version that produced the catalog. */
  sdk: string;
  /** {@link catalogHash} of `instructions` + `tools`. */
  hash: string;
  instructions?: string;
  tools: ToolDescriptorV1[];
  /** Tools the SDK left out because it can't describe them, and why. */
  warnings?: string[];
}

/** The `tc` identity claim: binds a `chan: "mcp"` token to one call. */
export interface ToolCallClaim {
  id: string;
  name: string;
}

export interface ToolsCallRequestV1 {
  v: 1;
  name: string;
  arguments: Record<string, unknown>;
  /** Must equal the identity token's `tc.id`. */
  callId: string;
}

export interface ToolContentBlockV1 {
  type: string;
  [key: string]: unknown;
}

export interface ToolCallResultV1 {
  content: ToolContentBlockV1[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolsErrorCodeV1 =
  | "unknown_tool"
  | "invalid_arguments"
  | "invalid_request"
  | "forbidden"
  | "unauthenticated"
  | "method_not_allowed"
  | "misconfigured";

export interface ToolIssueV1 {
  message: string;
  path?: (string | number)[];
}

export interface ToolsErrorV1 {
  code: ToolsErrorCodeV1;
  message: string;
  issues?: ToolIssueV1[];
}

export interface ToolsCallSuccessV1 {
  v: 1;
  /** The app's current catalog hash; the gateway re-syncs on a mismatch. */
  catalogHash: string;
  result: ToolCallResultV1;
}

export interface ToolsErrorResponseV1 {
  v: 1;
  error: ToolsErrorV1;
}

export type ToolsCallResponseV1 = ToolsCallSuccessV1 | ToolsErrorResponseV1;

/**
 * JSON with object keys sorted at every depth, so equal values always
 * serialize identically. `undefined` members are dropped, as JSON.stringify
 * does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) sorted[key] = sortKeys(member);
  }
  return sorted;
}

/**
 * `sha256:<hex>` over the canonical JSON of a catalog. The SDK reports it with
 * every list and call; the gateway stores it at sync and re-syncs when a call
 * reports a different one.
 */
export async function catalogHash(catalog: {
  instructions?: string;
  tools: readonly ToolDescriptorV1[];
}): Promise<string> {
  const canonical = canonicalJson({
    instructions: catalog.instructions ?? null,
    tools: catalog.tools,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return `sha256:${toHex(digest)}`;
}

function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
