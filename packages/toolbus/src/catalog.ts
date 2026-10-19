/**
 * Catalog snapshots: fetch an app's tools over the internal contract and
 * normalize them into what the ToolBus may serve.
 *
 * The gateway serves clients from snapshots: taken at deploy, re-taken on
 * drift, and taken within a request only for an app that has none, with a
 * budget of a few seconds, so one slow app can't slow every list.
 * `everyapp dev` refetches live. Both go through here, so a tool that would
 * be refused in production is refused locally too.
 */
import {
  SYSTEM_HEADER,
  TOOLS_LIST_PATH,
  TOOLS_PROTOCOL_VERSION,
  TOOL_NAME_PATTERN,
  isToolRisk,
  mintSystemJwt,
} from "@every-app/sdk/internal";
import { isPlainObject, readTextCapped, withTimeout } from "./io";
import { MAX_TOOL_NAME_LENGTH, namespacedToolName } from "./names";
import type { JsonObject, ToolBusSigning, ToolBusTool } from "./types";
import { unusableSchemaReason } from "./validation";

export const CATALOG_LIMITS = {
  toolsPerApp: 100,
  /** Serialized size of one input or output schema. */
  schemaBytes: 20 * 1024,
  descriptionChars: 2048,
  titleChars: 100,
  instructionsChars: 2048,
  /** One warning the app reports about a tool it left out. */
  warningChars: 500,
  /** A whole catalog response. */
  responseBytes: 5 * 1024 * 1024,
} as const;

const CATALOG_TIMEOUT_MS = 15_000;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MCP_HEADER_KEYWORD = "x-mcp-header";

export type CatalogSnapshot =
  | {
      status: "ok" | "empty";
      hash: string;
      sdkVersion: string;
      instructions?: string;
      tools: ToolBusTool[];
      /** Tools skipped or trimmed, for the deploy output. */
      warnings: string[];
    }
  | {
      /** "unsupported": the app doesn't speak the contract (SDK < 0.3). */
      status: "unsupported" | "error";
      error: string;
    };

/** Turn an app's `tools/list` answer into a snapshot the ToolBus can serve. */
export function normalizeCatalog(
  appId: string,
  body: unknown,
): CatalogSnapshot {
  if (!isPlainObject(body) || body["v"] !== TOOLS_PROTOCOL_VERSION) {
    return {
      status: "error",
      error: `expected a v${TOOLS_PROTOCOL_VERSION} tools catalog`,
    };
  }
  const { hash, sdk, tools } = body;
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    return { status: "error", error: "the catalog has no valid hash" };
  }
  if (typeof sdk !== "string" || sdk.length > 32) {
    return { status: "error", error: "the catalog has no SDK version" };
  }
  if (!Array.isArray(tools)) {
    return { status: "error", error: "the catalog has no tools list" };
  }

  // Tools the SDK itself left out (it couldn't describe them), so the deploy
  // output shows them next to the ones skipped here.
  const warnings: string[] = Array.isArray(body["warnings"])
    ? body["warnings"]
        .filter((warning): warning is string => typeof warning === "string")
        .slice(0, CATALOG_LIMITS.toolsPerApp)
        .map((warning) => warning.slice(0, CATALOG_LIMITS.warningChars))
    : [];
  let instructions: string | undefined;
  if (typeof body["instructions"] === "string" && body["instructions"]) {
    instructions = body["instructions"];
    if (instructions.length > CATALOG_LIMITS.instructionsChars) {
      instructions = instructions.slice(0, CATALOG_LIMITS.instructionsChars);
      warnings.push(
        `instructions trimmed to ${CATALOG_LIMITS.instructionsChars} characters`,
      );
    }
  }

  const accepted: ToolBusTool[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of tools.entries()) {
    if (accepted.length === CATALOG_LIMITS.toolsPerApp) {
      warnings.push(
        `only the first ${CATALOG_LIMITS.toolsPerApp} tools are served; ${tools.length - index} skipped`,
      );
      break;
    }
    const checked = normalizeTool(appId, raw);
    if (typeof checked === "string") {
      warnings.push(checked);
      continue;
    }
    if (seen.has(checked.name)) {
      warnings.push(`${checked.name}: skipped, duplicate name`);
      continue;
    }
    seen.add(checked.name);
    accepted.push(checked);
  }

  return {
    status: accepted.length > 0 ? "ok" : "empty",
    hash,
    sdkVersion: sdk,
    ...(instructions ? { instructions } : {}),
    tools: accepted,
    warnings,
  };
}

/** A normalized tool, or a warning explaining why it was skipped. */
function normalizeTool(appId: string, raw: unknown): ToolBusTool | string {
  if (!isPlainObject(raw) || typeof raw["name"] !== "string") {
    return "skipped a tool without a name";
  }
  const name = raw["name"];
  const skip = (why: string) => `${name}: skipped, ${why}`;
  if (!TOOL_NAME_PATTERN.test(name)) {
    return skip("names must be lowercase snake_case, at most 48 characters");
  }
  const namespaced = namespacedToolName(appId, name);
  if (namespaced.length > MAX_TOOL_NAME_LENGTH) {
    return skip(
      `"${namespaced}" is longer than ${MAX_TOOL_NAME_LENGTH} characters`,
    );
  }

  const description = raw["description"];
  if (typeof description !== "string" || !description.trim()) {
    return skip("no description");
  }
  if (description.length > CATALOG_LIMITS.descriptionChars) {
    return skip(
      `description longer than ${CATALOG_LIMITS.descriptionChars} characters`,
    );
  }
  const title = raw["title"];
  if (title !== undefined && typeof title !== "string") {
    return skip("title is not a string");
  }
  if (typeof title === "string" && title.length > CATALOG_LIMITS.titleChars) {
    return skip(`title longer than ${CATALOG_LIMITS.titleChars} characters`);
  }

  // Unannotated tools are treated as write; an unknown risk is refused.
  const risk = raw["risk"] ?? "write";
  if (!isToolRisk(risk)) return skip(`unknown risk "${String(risk)}"`);

  const inputSchema = objectSchema(raw["inputSchema"]);
  if (typeof inputSchema === "string")
    return skip(`inputSchema ${inputSchema}`);
  let outputSchema: JsonObject | undefined;
  if (raw["outputSchema"] !== undefined) {
    const checked = objectSchema(raw["outputSchema"]);
    if (typeof checked === "string") return skip(`outputSchema ${checked}`);
    outputSchema = checked;
  }

  const annotations: NonNullable<ToolBusTool["annotations"]> = {};
  const rawAnnotations = raw["annotations"];
  if (isPlainObject(rawAnnotations)) {
    for (const hint of ["idempotentHint", "openWorldHint"] as const) {
      if (typeof rawAnnotations[hint] === "boolean") {
        annotations[hint] = rawAnnotations[hint];
      }
    }
  }

  return {
    name,
    ...(title ? { title } : {}),
    description,
    risk,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

/** A usable object schema (with `x-mcp-header` removed), or the problem. */
function objectSchema(raw: unknown): JsonObject | string {
  if (!isPlainObject(raw) || raw["type"] !== "object") {
    return 'must be a JSON Schema with type "object"';
  }
  const schema = withoutMcpHeaders(raw) as JsonObject;
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  if (bytes > CATALOG_LIMITS.schemaBytes) {
    return `is larger than ${CATALOG_LIMITS.schemaBytes / 1024} KB`;
  }
  const unusable = unusableSchemaReason(schema);
  return unusable ? `is not a usable JSON Schema (${unusable})` : schema;
}

// The 2026-07-28 MCP revision lets a schema ask clients to mirror arguments
// into HTTP headers. The gateway fronts many apps and routes on nothing an
// app declares, so the hint is never passed on.
function withoutMcpHeaders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMcpHeaders);
  if (!isPlainObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== MCP_HEADER_KEYWORD) out[key] = withoutMcpHeaders(member);
  }
  return out;
}

export interface FetchCatalogOptions {
  signing: ToolBusSigning;
  /** Reach the app's Worker. Errors (e.g. no binding yet) propagate. */
  invoke(request: Request): Promise<Response>;
  timeoutMs?: number;
}

/**
 * Ask an app for its catalog with a one-minute system token. Throws when the
 * app cannot be reached at all, or doesn't finish answering in time; the
 * caller decides whether to retry.
 */
export async function fetchAppCatalog(
  app: { appId: string; audience: string; baseUrl: string },
  options: FetchCatalogOptions,
): Promise<CatalogSnapshot> {
  const token = await mintSystemJwt(options.signing.privateKeyPem, {
    audience: app.audience,
    issuer: options.signing.issuer,
    purpose: "tools.list",
    keyId: options.signing.keyId,
  });
  // The deadline covers the body too: an app may answer headers and stall.
  const { response, read } = await withTimeout(
    options.timeoutMs ?? CATALOG_TIMEOUT_MS,
    async (signal) => {
      const response = await options.invoke(
        new Request(new URL(TOOLS_LIST_PATH, app.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SYSTEM_HEADER]: token,
          },
          body: JSON.stringify({ v: TOOLS_PROTOCOL_VERSION }),
          signal,
        }),
      );
      const read = await readTextCapped(
        response,
        CATALOG_LIMITS.responseBytes,
        signal,
      );
      return { response, read };
    },
  );

  if (!read.ok) {
    return {
      status: "error",
      error: `the catalog is larger than ${CATALOG_LIMITS.responseBytes / 1024 / 1024} MB`,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    body = undefined;
  }

  if (response.ok) return normalizeCatalog(app.appId, body);

  // An app on SDK 0.3+ answers with the contract's error envelope; anything
  // else is an app that doesn't speak the contract at all.
  const contractError = isPlainObject(body) ? body["error"] : undefined;
  if (
    isPlainObject(body) &&
    body["v"] === TOOLS_PROTOCOL_VERSION &&
    isPlainObject(contractError)
  ) {
    return {
      status: "error",
      error: `the app refused the catalog request (${String(contractError["code"])}): ${String(contractError["message"])}`,
    };
  }
  if ([401, 403, 404, 405].includes(response.status)) {
    return {
      status: "unsupported",
      error: `the app answered ${response.status}; it does not serve agent tools (Every App SDK 0.3 or later)`,
    };
  }
  return {
    status: "error",
    error: `the app answered ${response.status}`,
  };
}
