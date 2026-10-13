/**
 * The app side of the internal tools contract (../internal/tools.ts).
 *
 * `everyApp()` answers the two reserved paths here, before any app code runs
 * and whether or not the app defines tools:
 *
 *  - `/__everyapp/tools/list` needs the gateway's system token for this app
 *    (purpose "tools.list"). It describes tools; it never runs them.
 *  - `/__everyapp/tools/call` needs an identity token minted for this exact
 *    call: `chan: "mcp"` plus a `tc` claim naming the tool and call id. The
 *    token's scopes must include the scope the tool's risk requires; `*` does
 *    not count, because the ToolBus only ever mints explicit scopes.
 *
 * The perimeter also refuses these paths from outside and strips inbound
 * `x-everyapp-*` headers, so only the gateway's ToolBus ever reaches them.
 */
import {
  ConfigurationError,
  IDENTITY_HEADER,
  IdentityError,
  SYSTEM_HEADER,
  TOOLS_CALL_PATH,
  TOOLS_LIST_PATH,
  TOOLS_PROTOCOL_VERSION,
  catalogHash,
  requiredScopeForRisk,
  resolveVerifyOptions,
  verifyIdentityJwt,
  verifySystemJwt,
  type EveryAppUser,
  type RequestIdentityOptions,
  type ToolCallResultV1,
  type ToolIssueV1,
  type ToolsCallRequestV1,
  type ToolsErrorCodeV1,
  type ToolsListResponseV1,
  type VerifyOptions,
} from "../internal/index.js";
import type { ExecutionContextLike } from "./everyApp.js";
import {
  SDK_VERSION,
  ToolError,
  toToolResult,
  toolSetInternals,
  validateWithSchema,
  type ToolCatalog,
  type ToolSet,
} from "./tools.js";

export interface ToolsEndpointOptions {
  toolSet?: ToolSet;
  /** This app's id: the expected token audience and the masked-error label. */
  appId: string;
  /** How to verify gateway-minted tokens (keys, issuer, dev opt-in). */
  identity: RequestIdentityOptions;
}

function toolsJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function toolsError(
  status: number,
  code: ToolsErrorCodeV1,
  message: string,
  extra: { issues?: ToolIssueV1[]; headers?: Record<string, string> } = {},
): Response {
  return toolsJson(
    status,
    {
      v: TOOLS_PROTOCOL_VERSION,
      error: {
        code,
        message,
        ...(extra.issues ? { issues: extra.issues } : {}),
      },
    },
    extra.headers,
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

let emptyCatalog: Promise<ToolCatalog> | undefined;

/**
 * The app's catalog, or the contract's "misconfigured" answer when it can't
 * be built at all, so the deploy shows the developer what to fix. (A single
 * tool that can't be described is left out of the catalog with a warning.)
 */
async function catalogOrError(
  toolSet: ToolSet | undefined,
): Promise<ToolCatalog | Response> {
  try {
    return await catalogFor(toolSet);
  } catch (error) {
    console.error(error);
    return toolsError(
      500,
      "misconfigured",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function catalogFor(toolSet: ToolSet | undefined): Promise<ToolCatalog> {
  if (toolSet) return toolSetInternals(toolSet).catalog();
  // An app without tools still answers the contract, with an empty catalog,
  // so the gateway can tell "no tools" from "no contract".
  emptyCatalog ??= catalogHash({ tools: [] }).then((hash) => ({
    tools: [],
    hash,
    warnings: [],
  }));
  return emptyCatalog;
}

/**
 * Answer a request to the reserved tools paths, or return null for any other
 * path so the app's own handler runs.
 */
export async function handleToolsRequest(
  request: Request,
  env: unknown,
  ctx: ExecutionContextLike,
  options: ToolsEndpointOptions,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== TOOLS_LIST_PATH && pathname !== TOOLS_CALL_PATH) {
    return null;
  }
  if (request.method !== "POST") {
    return toolsError(405, "method_not_allowed", "Use POST.", {
      headers: { allow: "POST" },
    });
  }

  let verify: VerifyOptions;
  try {
    verify = resolveVerifyOptions(options.identity);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(error);
      return toolsError(500, "misconfigured", error.message);
    }
    throw error;
  }

  return pathname === TOOLS_LIST_PATH
    ? listTools(request, verify, options)
    : callTool(request, env, ctx, verify, options);
}

async function listTools(
  request: Request,
  verify: VerifyOptions,
  options: ToolsEndpointOptions,
): Promise<Response> {
  try {
    await verifySystemJwt(request.headers.get(SYSTEM_HEADER) ?? "", {
      ...verify,
      purpose: "tools.list",
    });
  } catch (error) {
    if (error instanceof IdentityError) {
      return toolsError(401, "unauthenticated", error.message);
    }
    throw error;
  }

  const body = await readJsonBody(request);
  if (!isPlainObject(body) || body.v !== TOOLS_PROTOCOL_VERSION) {
    return toolsError(
      400,
      "invalid_request",
      `Expected {"v":${TOOLS_PROTOCOL_VERSION}}.`,
    );
  }

  const catalog = await catalogOrError(options.toolSet);
  if (catalog instanceof Response) return catalog;
  const response: ToolsListResponseV1 = {
    v: TOOLS_PROTOCOL_VERSION,
    sdk: SDK_VERSION,
    hash: catalog.hash,
    ...(catalog.instructions !== undefined
      ? { instructions: catalog.instructions }
      : {}),
    tools: catalog.tools,
    ...(catalog.warnings.length > 0 ? { warnings: catalog.warnings } : {}),
  };
  return toolsJson(200, response);
}

function parseCallRequest(body: unknown): ToolsCallRequestV1 | null {
  if (!isPlainObject(body) || body.v !== TOOLS_PROTOCOL_VERSION) return null;
  const { name, callId } = body;
  const args = body.arguments ?? {};
  if (typeof name !== "string" || !name) return null;
  if (typeof callId !== "string" || !callId) return null;
  if (!isPlainObject(args)) return null;
  return { v: TOOLS_PROTOCOL_VERSION, name, arguments: args, callId };
}

async function callTool(
  request: Request,
  env: unknown,
  ctx: ExecutionContextLike,
  verify: VerifyOptions,
  options: ToolsEndpointOptions,
): Promise<Response> {
  let user: EveryAppUser;
  try {
    user = await verifyIdentityJwt(
      request.headers.get(IDENTITY_HEADER) ?? "",
      verify,
    );
  } catch (error) {
    if (error instanceof IdentityError) {
      return toolsError(401, "unauthenticated", error.message);
    }
    throw error;
  }
  if (user.channel !== "mcp" || !user.toolCall) {
    return toolsError(
      403,
      "forbidden",
      "Tool calls need an identity the gateway minted for this call.",
    );
  }

  const call = parseCallRequest(await readJsonBody(request));
  if (!call) {
    return toolsError(
      400,
      "invalid_request",
      `Expected {"v":${TOOLS_PROTOCOL_VERSION},"name","arguments","callId"}.`,
    );
  }
  if (call.name !== user.toolCall.name || call.callId !== user.toolCall.id) {
    return toolsError(
      403,
      "forbidden",
      "The identity was minted for a different tool call.",
    );
  }

  const tool = options.toolSet
    ? toolSetInternals(options.toolSet).tool(call.name)
    : undefined;
  if (!tool) {
    return toolsError(404, "unknown_tool", `Unknown tool: ${call.name}`);
  }
  const scope = requiredScopeForRisk(tool.risk);
  if (!user.scopes.includes(scope)) {
    return toolsError(
      403,
      "forbidden",
      `Calling ${call.name} needs the ${scope} scope.`,
    );
  }

  const input = await validateWithSchema(tool.input, call.arguments);
  if (!input.ok) {
    return toolsError(
      400,
      "invalid_arguments",
      `Invalid arguments for ${call.name}: ${input.issues
        .map((issue) =>
          issue.path?.length
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; ")}`,
      { issues: input.issues },
    );
  }

  // The hash only lets the gateway notice a newer catalog: a catalog that
  // can't be built is logged here, and doesn't stop this tool from running.
  const hash = await catalogFor(options.toolSet).then(
    (catalog) => catalog.hash,
    (error: unknown) => {
      console.error(error);
      return "";
    },
  );
  let result: ToolCallResultV1;
  try {
    const value = await tool.handler(input.value, {
      user,
      env: env as Cloudflare.Env,
      ctx,
      request,
      callId: call.callId,
    });
    result = await toToolResult(tool, value);
  } catch (error) {
    if (error instanceof ToolError) {
      result = {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    } else {
      console.error(
        `[everyapp] tool "${call.name}" failed (ref ${call.callId}):`,
        error,
      );
      result = {
        content: [
          {
            type: "text",
            text: `Internal error in ${options.appId} (ref ${call.callId})`,
          },
        ],
        isError: true,
      };
    }
  }

  return toolsJson(200, {
    v: TOOLS_PROTOCOL_VERSION,
    catalogHash: hash,
    result,
  });
}
