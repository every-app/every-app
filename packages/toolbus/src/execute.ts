/**
 * `executeToolCall` — the one path every tool call takes, whichever surface
 * (an app host's /mcp, the gateway /mcp; approvals and an in-gateway agent
 * later) it arrives on:
 *
 *   resolve the name → apply policy → validate the arguments against the
 *   snapshotted schema → mint a `chan: "mcp"` identity bound to this call →
 *   POST /__everyapp/tools/call over the app's binding (one invocation) →
 *   map the answer, notice catalog drift, and emit one audit event.
 *
 * The gateway's built-in `everyapp_*` tools are answered here without
 * calling any app, and audited the same way.
 *
 * Raw arguments and results never reach the audit event, only a keyed
 * digest and a byte count.
 */
import {
  IDENTITY_HEADER,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  TOOLS_CALL_PATH,
  TOOLS_PROTOCOL_VERSION,
  mintIdentityJwt,
  type ToolCallResultV1,
} from "@every-app/sdk/internal";
import { BUILTIN_APP_ID, findBuiltinTool, runBuiltinTool } from "./builtins";
import { TimeoutError, isPlainObject, readTextCapped, withTimeout } from "./io";
import {
  MAX_CALLED_NAME_LENGTH,
  displayedToolName,
  resolveToolName,
  splitNamespacedToolName,
} from "./names";
import { evaluateToolPolicy } from "./policy";
import type {
  McpPrincipal,
  ToolBusApp,
  ToolBusDeps,
  ToolBusTool,
  ToolBusView,
  ToolCallAuditEvent,
  ToolCallOutcome,
} from "./types";
import {
  MAX_CHECKED_VALUES,
  argumentsValidator,
  measureJson,
} from "./validation";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** Largest app answer the ToolBus relays. */
export const MAX_RESULT_BYTES = 1024 * 1024;
/** Arguments nested deeper than this are refused before anything walks them. */
const MAX_ARGUMENT_DEPTH = 64;

export interface ToolCallRequest {
  /** The tool name as the client called it. */
  name: string;
  arguments: unknown;
  protocolVersion?: string;
}

export type ToolCallResolution =
  | { kind: "result"; result: ToolCallResultV1; tool: ToolBusTool }
  /** No such tool for this caller: absent, or hidden by policy. */
  | { kind: "unknown_tool" };

/** The scopes minted on a tool-call identity: explicit, never "*". */
export function scopesForAccess(access: McpPrincipal["access"]): string[] {
  return access === "write"
    ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE]
    : [MCP_READ_SCOPE];
}

/** `act.sub` on the minted identity: the credential acting for the user. */
function actorFor(principal: McpPrincipal): string {
  switch (principal.credential.kind) {
    case "pat":
      return `pat:${principal.credential.id}`;
    case "oauth":
      return `oauth:${principal.credential.id}`;
    default:
      return principal.userId;
  }
}

function errorResult(text: string): ToolCallResultV1 {
  return { content: [{ type: "text", text }], isError: true };
}

export async function executeToolCall(
  view: ToolBusView,
  call: ToolCallRequest,
  deps: ToolBusDeps,
): Promise<ToolCallResolution> {
  const startedAt = Date.now();
  const callId = crypto.randomUUID();
  const { principal } = view;
  const audit = (
    event: Pick<ToolCallAuditEvent, "decision" | "outcome"> &
      Partial<ToolCallAuditEvent>,
  ) =>
    deps.audit?.({
      surface: view.surface,
      tool: displayedToolName(call.name),
      callId,
      userId: principal.userId,
      organizationId: principal.organizationId,
      credentialKind: principal.credential.kind,
      credentialId: principal.credential.id,
      ...(principal.credential.clientName
        ? { clientName: principal.credential.clientName }
        : {}),
      ...(call.protocolVersion
        ? { protocolVersion: call.protocolVersion }
        : {}),
      ...(view.requestId ? { requestId: view.requestId } : {}),
      ...event,
      durationMs: Date.now() - startedAt,
    });

  // No catalog name is anywhere near this long.
  if (call.name.length > MAX_CALLED_NAME_LENGTH) {
    audit({ decision: "blocked", reason: "unknown_tool", outcome: "not_run" });
    return { kind: "unknown_tool" };
  }

  const split =
    view.surface === "gateway" ? splitNamespacedToolName(call.name) : null;
  const builtin =
    split?.appId === BUILTIN_APP_ID ? findBuiltinTool(split.localName) : null;
  if (builtin) {
    const result = runBuiltinTool(builtin, view);
    audit({
      appId: BUILTIN_APP_ID,
      risk: builtin.risk,
      decision: "allowed",
      outcome: "ok",
      resultBytes: new TextEncoder().encode(JSON.stringify(result)).length,
    });
    return { kind: "result", result, tool: builtin };
  }

  const target = resolveToolName(view, call.name);
  if (!target) {
    audit({ decision: "blocked", reason: "unknown_tool", outcome: "not_run" });
    return { kind: "unknown_tool" };
  }
  const { app, tool } = target;
  const about = { appId: app.appId, appRowId: app.rowId, risk: tool.risk };

  const policy = evaluateToolPolicy(tool, principal);
  if (policy.action !== "allow") {
    audit({
      ...about,
      decision: "blocked",
      reason: policy.reason,
      outcome: "not_run",
    });
    return { kind: "unknown_tool" };
  }

  const args = call.arguments ?? {};
  const refuse = (problem: string, event: Partial<ToolCallAuditEvent>) => {
    audit({
      ...about,
      decision: "allowed",
      outcome: "invalid_arguments",
      ...event,
    });
    return {
      kind: "result" as const,
      result: errorResult(`Invalid arguments for ${call.name}: ${problem}`),
      tool,
    };
  };

  // Checked before anything walks the arguments recursively (the digest,
  // the validator), which a deep enough value would overflow.
  const shape = isPlainObject(args)
    ? measureJson(args, MAX_ARGUMENT_DEPTH)
    : null;
  if (!shape) return refuse("arguments must be a JSON object.", {});
  if (shape.tooDeep) {
    return refuse(
      `arguments are nested more than ${MAX_ARGUMENT_DEPTH} levels deep.`,
      { reason: "too_deep" },
    );
  }

  let argsDigest: string | undefined;
  let invalid: string | null;
  try {
    argsDigest = deps.digestArguments
      ? await deps.digestArguments(args)
      : undefined;
    invalid =
      shape.values <= MAX_CHECKED_VALUES
        ? argumentsProblem(app, tool, args)
        : null;
  } catch {
    // Whatever broke the check (a schema the validator can't handle), the
    // call is refused and still audited, without the details.
    return refuse("they could not be checked.", {
      reason: "check_failed",
      ...(argsDigest ? { argsDigest } : {}),
    });
  }
  const allowed = { ...about, decision: "allowed" as const, argsDigest };
  if (invalid) return refuse(invalid, { argsDigest });

  const identity = await mintIdentityJwt(deps.signing.privateKeyPem, {
    subject: {
      sub: principal.userId,
      email: principal.email,
      orgId: principal.organizationId,
      orgRole: principal.orgRole,
    },
    audience: app.appId,
    issuer: deps.signing.issuer,
    keyId: deps.signing.keyId,
    channel: "mcp",
    actor: { sub: actorFor(principal) },
    scopes: scopesForAccess(principal.access),
    toolCall: { id: callId, name: tool.name },
  });

  const timeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let answer: AppAnswer;
  try {
    // One deadline for the whole exchange: an app that sends its headers and
    // then stalls the body times out like one that never answers.
    answer = await withTimeout(timeoutMs, async (signal) => {
      const response = await deps.invokeApp(
        app,
        new Request(new URL(TOOLS_CALL_PATH, app.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [IDENTITY_HEADER]: identity,
          },
          body: JSON.stringify({
            v: TOOLS_PROTOCOL_VERSION,
            name: tool.name,
            arguments: args,
            callId,
          }),
          signal,
        }),
      );
      return readAppAnswer(app, tool, response, signal);
    });
  } catch (error) {
    const timedOut = error instanceof TimeoutError;
    audit({ ...allowed, outcome: timedOut ? "timeout" : "unreachable" });
    return {
      kind: "result",
      result: errorResult(
        timedOut
          ? `${app.name} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : `${app.name} could not be reached.`,
      ),
      tool,
    };
  }

  if (answer.drifted) deps.onCatalogDrift?.(app);
  audit({
    ...allowed,
    outcome: answer.outcome,
    resultBytes: answer.bytes,
    ...(answer.reason ? { reason: answer.reason } : {}),
  });
  return { kind: "result", result: answer.result, tool };
}

/** What's wrong with the arguments, as far as the gateway checks them. */
function argumentsProblem(
  app: ToolBusApp,
  tool: ToolBusTool,
  args: unknown,
): string | null {
  // By registry row: two rows (one app id in two organizations, or a fork
  // beside the app it forked) never share a validator, whatever hash each
  // reports.
  const validate = argumentsValidator(
    `${app.rowId}\u0000${app.catalogHash}\u0000${tool.name}`,
    tool.inputSchema,
  );
  // null: the app's own validation is the only check for this schema.
  const checked = validate?.(args);
  return !checked || checked.valid
    ? null
    : (checked.errorMessage ?? "invalid arguments.");
}

interface AppAnswer {
  result: ToolCallResultV1;
  outcome: ToolCallOutcome;
  bytes: number;
  drifted: boolean;
  reason?: string;
}

async function readAppAnswer(
  app: ToolBusApp,
  tool: ToolBusTool,
  response: Response,
  signal: AbortSignal,
): Promise<AppAnswer> {
  let read: Awaited<ReturnType<typeof readTextCapped>>;
  try {
    read = await readTextCapped(response, MAX_RESULT_BYTES, signal);
  } catch {
    return {
      result: errorResult(`${app.name} failed to run ${tool.name}.`),
      outcome: "app_error",
      bytes: 0,
      drifted: false,
      reason: "unreadable_answer",
    };
  }
  if (!read.ok) {
    return {
      result: errorResult(
        `The result from ${app.name} is larger than ${MAX_RESULT_BYTES / 1024 / 1024} MB.`,
      ),
      outcome: "app_error",
      bytes: read.bytes,
      drifted: false,
      reason: "result_too_large",
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    body = undefined;
  }
  const failed = (reason: string): AppAnswer => ({
    result: errorResult(`${app.name} failed to run ${tool.name}.`),
    outcome: "app_error",
    bytes: read.bytes,
    drifted: false,
    reason,
  });
  if (!isPlainObject(body) || body["v"] !== TOOLS_PROTOCOL_VERSION) {
    return failed(`http_${response.status}`);
  }

  if (response.ok) {
    const result = toolResult(body["result"]);
    if (!result) return failed("malformed_result");
    return {
      result,
      outcome: result.isError ? "tool_error" : "ok",
      bytes: read.bytes,
      drifted: body["catalogHash"] !== app.catalogHash,
    };
  }

  const error = isPlainObject(body["error"]) ? body["error"] : {};
  const code = typeof error["code"] === "string" ? error["code"] : "unknown";
  if (code === "invalid_arguments") {
    return {
      result: errorResult(
        typeof error["message"] === "string"
          ? error["message"]
          : `Invalid arguments for ${tool.name}.`,
      ),
      outcome: "invalid_arguments",
      bytes: read.bytes,
      drifted: false,
    };
  }
  if (code === "unknown_tool") {
    // The snapshot lists a tool the deployed app no longer has.
    return {
      result: errorResult(
        `${tool.name} is no longer available in ${app.name}. Its tool list is being refreshed; list tools again.`,
      ),
      outcome: "app_error",
      bytes: read.bytes,
      drifted: true,
      reason: "unknown_tool",
    };
  }
  return failed(code);
}

/** Keep only what MCP's CallToolResult allows; null if it isn't one. */
function toolResult(raw: unknown): ToolCallResultV1 | null {
  if (!isPlainObject(raw) || !Array.isArray(raw["content"])) return null;
  const content = raw["content"];
  if (
    !content.every(
      (block) =>
        isPlainObject(block) &&
        typeof block["type"] === "string" &&
        (block["type"] !== "text" || typeof block["text"] === "string"),
    )
  ) {
    return null;
  }
  const structured = raw["structuredContent"];
  if (structured !== undefined && !isPlainObject(structured)) return null;
  return {
    content: content as ToolCallResultV1["content"],
    ...(structured ? { structuredContent: structured } : {}),
    ...(raw["isError"] === true ? { isError: true } : {}),
  };
}
