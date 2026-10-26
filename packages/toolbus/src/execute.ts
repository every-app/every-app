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
 * The gateway's built-in `everyapp_*` tools go through the same shape
 * checks and are validated against their own schemas. Three are answered
 * here without calling any app and audited the same way. The two wrappers
 * (`everyapp_call_read`, `everyapp_call_write`) delegate exactly one inner
 * call down the app-tool path above, or one workspace tool, no fan-out and
 * no recursion: the inner call mints its own identity, leaves the one
 * audit row (naming the inner tool, with the wrapper as `via`), and the
 * wrapper writes none of its own. A workspace tool (kind `host`) is run by
 * the host's handler (`ToolBusDeps.workspace`) as the caller, after the
 * policy (its `minRole`, the caller's access) and its own schema, and is
 * audited like any built-in; it mints no identity and calls no app.
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
import {
  BUILTIN_APP_ID,
  WRITE_WRAPPER_NAME,
  findBuiltinTool,
  resultBytes,
  runBuiltinTool,
  type BuiltinTool,
} from "./builtins";
import { TimeoutError, isPlainObject, readTextCapped, withTimeout } from "./io";
import {
  MAX_CALLED_NAME_LENGTH,
  displayedToolName,
  namespacedToolName,
  resolveToolName,
  splitNamespacedToolName,
} from "./names";
import { evaluateToolPolicy } from "./policy";
import type {
  JsonObject,
  McpAccess,
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
  /** The client's self-description for the audit event (`describeClient`). */
  clientInfo?: string;
}

export type ToolCallResolution =
  /** `tool` is the tool the client called: for a wrapped call, the wrapper. */
  | { kind: "result"; result: ToolCallResultV1; tool: ToolBusTool }
  /** No such tool for this caller: absent, or hidden by policy. */
  | { kind: "unknown_tool" };

/** The scopes minted on a tool-call identity: explicit, never "*". */
export function scopesForAccess(access: McpPrincipal["access"]): string[] {
  return access === "write"
    ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE]
    : [MCP_READ_SCOPE];
}

/**
 * `act.sub` on the minted identity: the credential acting for the user. An
 * AI client that Cloudflare Access authenticated acts for them like a
 * connection or a token does: `access:<email>`.
 */
function actorFor(principal: McpPrincipal): string {
  switch (principal.credential.kind) {
    case "pat":
      return `pat:${principal.credential.id}`;
    case "oauth":
      return `oauth:${principal.credential.id}`;
    case "access":
      return `access:${principal.credential.id}`;
    default:
      return principal.userId;
  }
}

function errorResult(text: string): ToolCallResultV1 {
  return { content: [{ type: "text", text }], isError: true };
}

/** One tools/call as it travels through the steps: one id, one clock. */
interface CallContext {
  view: ToolBusView;
  deps: ToolBusDeps;
  call: ToolCallRequest;
  callId: string;
  startedAt: number;
  /**
   * The wrapper the call came through, for its inner call: the audit rows
   * name it as `via`, its ceiling bounds the inner tool's risk and the
   * scopes minted, and it is the tool the client called.
   */
  via?: { name: string; tool: BuiltinTool; ceiling: McpAccess };
}

type Audit = (
  tool: string,
  event: Pick<ToolCallAuditEvent, "decision" | "outcome"> &
    Partial<ToolCallAuditEvent>,
) => void;

function auditor(ctx: CallContext): Audit {
  const { view, deps, call } = ctx;
  const { principal } = view;
  return (tool, event) =>
    deps.audit?.({
      surface: view.surface,
      tool: displayedToolName(tool),
      callId: ctx.callId,
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
      ...(call.clientInfo ? { clientInfo: call.clientInfo } : {}),
      ...(view.requestId ? { requestId: view.requestId } : {}),
      ...(ctx.via ? { via: ctx.via.name } : {}),
      ...event,
      durationMs: Date.now() - ctx.startedAt,
    });
}

export async function executeToolCall(
  view: ToolBusView,
  call: ToolCallRequest,
  deps: ToolBusDeps,
): Promise<ToolCallResolution> {
  const ctx: CallContext = {
    view,
    deps,
    call,
    callId: crypto.randomUUID(),
    startedAt: Date.now(),
  };
  const split =
    view.surface === "gateway" && call.name.length <= MAX_CALLED_NAME_LENGTH
      ? splitNamespacedToolName(call.name)
      : null;
  const builtin =
    split?.appId === BUILTIN_APP_ID ? findBuiltinTool(split.localName) : null;
  return builtin
    ? runBuiltin(ctx, builtin)
    : runAppTool(ctx, call.name, call.arguments);
}

type ArgumentsCheck =
  | { ok: true; args: JsonObject; argsDigest?: string }
  | { ok: false; problem: string; reason?: string; argsDigest?: string };

/**
 * The shape checks every call's arguments pass before anything walks them
 * recursively (the digest, the validator), which a deep enough value would
 * overflow; then the digest for the audit row and the schema check.
 *
 * An app's schema is checked only for arguments of at most
 * `MAX_CHECKED_VALUES` (validation.ts says why: the app validates every
 * call anyway). A built-in's schema is the gateway's own, small and free of
 * regular expressions, references, `uniqueItems` and unions, so checking it
 * costs no more than the walk `measureJson` already made, and nobody checks
 * after the gateway: `ownSchema` runs it whatever the value count.
 */
async function checkArguments(
  deps: ToolBusDeps,
  raw: unknown,
  validatorKey: string,
  schema: JsonObject,
  options: { ownSchema?: boolean } = {},
): Promise<ArgumentsCheck> {
  const args: unknown = raw ?? {};
  if (!isPlainObject(args)) {
    return { ok: false, problem: "arguments must be a JSON object." };
  }
  const shape = measureJson(args, MAX_ARGUMENT_DEPTH);
  if (shape.tooDeep) {
    return {
      ok: false,
      problem: `arguments are nested more than ${MAX_ARGUMENT_DEPTH} levels deep.`,
      reason: "too_deep",
    };
  }
  let argsDigest: string | undefined;
  let invalid: string | null;
  try {
    argsDigest = deps.digestArguments
      ? await deps.digestArguments(args)
      : undefined;
    invalid =
      options.ownSchema || shape.values <= MAX_CHECKED_VALUES
        ? argumentsProblem(validatorKey, schema, args)
        : null;
  } catch {
    // Whatever broke the check (a schema the validator can't handle), the
    // call is refused and still audited, without the details.
    return {
      ok: false,
      problem: "they could not be checked.",
      reason: "check_failed",
      ...(argsDigest ? { argsDigest } : {}),
    };
  }
  if (invalid) {
    return {
      ok: false,
      problem: invalid,
      ...(argsDigest ? { argsDigest } : {}),
    };
  }
  return { ok: true, args, ...(argsDigest ? { argsDigest } : {}) };
}

/** The audit fields a refused check carries. */
function refusal(
  checked: Extract<ArgumentsCheck, { ok: false }>,
): Pick<ToolCallAuditEvent, "outcome"> & Partial<ToolCallAuditEvent> {
  return {
    outcome: "invalid_arguments",
    ...(checked.reason ? { reason: checked.reason } : {}),
    ...(checked.argsDigest ? { argsDigest: checked.argsDigest } : {}),
  };
}

/**
 * A built-in: policy (the write wrapper is hidden from read-only callers
 * like any write tool), the shape checks, its own schema, then its answer
 * from the view or, for a wrapper, the one inner call it delegates. A
 * workspace tool takes its own path, which a wrapper reaches too.
 */
async function runBuiltin(
  ctx: CallContext,
  builtin: BuiltinTool,
): Promise<ToolCallResolution> {
  const { view, deps, call } = ctx;
  if (builtin.kind === "host") {
    return runHostTool(ctx, builtin, call.arguments);
  }
  const audit = auditor(ctx);
  const name = namespacedToolName(BUILTIN_APP_ID, builtin.name);
  const about = { appId: BUILTIN_APP_ID, risk: builtin.risk };

  const policy = evaluateToolPolicy(builtin, view.principal);
  if (policy.action !== "allow") {
    audit(name, {
      ...about,
      decision: "blocked",
      reason: policy.reason,
      outcome: "not_run",
    });
    return { kind: "unknown_tool" };
  }

  const refuse = (problem: string, event: Partial<ToolCallAuditEvent>) => {
    audit(name, {
      ...about,
      decision: "allowed",
      outcome: "invalid_arguments",
      ...event,
    });
    return {
      kind: "result" as const,
      result: errorResult(`Invalid arguments for ${name}: ${problem}`),
      tool: builtin,
    };
  };
  // Keyed apart from every app's validators: an app's row id never starts
  // with this. The schema is the gateway's own, so it is checked however
  // many values the arguments hold: past the gate an app would re-validate,
  // and nothing re-validates a built-in.
  const checked = await checkArguments(
    deps,
    call.arguments,
    `builtin\u0000${builtin.name}`,
    builtin.inputSchema,
    { ownSchema: true },
  );
  if (!checked.ok) return refuse(checked.problem, refusal(checked));
  const digest = checked.argsDigest ? { argsDigest: checked.argsDigest } : {};

  if (builtin.kind === "answer") {
    const answer = runBuiltinTool(builtin, view, checked.args, {
      workspace: deps.workspace !== undefined,
      providers: deps.workspace?.providers === true,
    });
    if ("problem" in answer) return refuse(answer.problem, digest);
    audit(name, {
      ...about,
      decision: "allowed",
      outcome: "ok",
      ...digest,
      resultBytes: resultBytes(answer.result),
    });
    return { kind: "result", result: answer.result, tool: builtin };
  }

  // A wrapper. Its schema just held the two fields it relies on to their
  // types; read again here so the bound is this code's own, whatever
  // checked the arguments before it.
  const inner = checked.args["name"];
  const innerArgs = checked.args["arguments"];
  if (typeof inner !== "string") {
    return refuse("name must be the tool's name, `<app>_<tool>`.", digest);
  }
  if (innerArgs !== undefined && !isPlainObject(innerArgs)) {
    return refuse("arguments must be a JSON object.", digest);
  }
  // From here the inner call is the call: its row is the only one, and the
  // wrapper is what the client called.
  return runAppTool(
    { ...ctx, via: { name, tool: builtin, ceiling: builtin.ceiling } },
    inner,
    innerArgs ?? {},
  );
}

/**
 * A workspace tool, called by name directly or through a wrapper: it is
 * unknown without a host to run it, hidden below its role or above the
 * caller's access, held to the read wrapper's ceiling, checked against its
 * own schema whatever the value count, then run by the host as the caller.
 * One audit row either way, naming the tool, with the wrapper as `via`.
 */
async function runHostTool(
  ctx: CallContext,
  builtin: Extract<BuiltinTool, { kind: "host" }>,
  rawArgs: unknown,
): Promise<ToolCallResolution> {
  const { view, deps } = ctx;
  const audit = auditor(ctx);
  const name = namespacedToolName(BUILTIN_APP_ID, builtin.name);
  const about = { appId: BUILTIN_APP_ID, risk: builtin.risk };
  const called = ctx.via?.tool ?? builtin;
  // Directly, an unknown tool is the protocol's error; through a wrapper it
  // is the wrapper's answer, a tool error, like an app tool's.
  const unknown = (reason: string): ToolCallResolution => {
    audit(name, { ...about, decision: "blocked", reason, outcome: "not_run" });
    return ctx.via
      ? {
          kind: "result",
          result: errorResult(`Unknown tool: ${name}`),
          tool: ctx.via.tool,
        }
      : { kind: "unknown_tool" };
  };

  const workspace = deps.workspace;
  if (!workspace) return unknown("unknown_tool");
  // A tool that writes the provider registry runs only where the host
  // registers providers (a self-hosted gateway): elsewhere it is as unknown
  // as without a host.
  if (builtin.needs === "providers" && workspace.providers !== true) {
    return unknown("unknown_tool");
  }
  const policy = evaluateToolPolicy(builtin, view.principal);
  if (policy.action !== "allow") return unknown(policy.reason);
  if (ctx.via?.ceiling === "read" && builtin.risk !== "read") {
    audit(name, {
      ...about,
      decision: "blocked",
      reason: "write_via_read_wrapper",
      outcome: "not_run",
    });
    return {
      kind: "result",
      result: errorResult(
        `\`${name}\` changes data; call it through ${WRITE_WRAPPER_NAME}.`,
      ),
      tool: ctx.via.tool,
    };
  }

  const checked = await checkArguments(
    deps,
    rawArgs,
    `builtin\u0000${builtin.name}`,
    builtin.inputSchema,
    { ownSchema: true },
  );
  if (!checked.ok) {
    audit(name, { ...about, decision: "allowed", ...refusal(checked) });
    return {
      kind: "result",
      result: errorResult(`Invalid arguments for ${name}: ${checked.problem}`),
      tool: called,
    };
  }
  const allowed = {
    ...about,
    decision: "allowed" as const,
    ...(checked.argsDigest ? { argsDigest: checked.argsDigest } : {}),
  };

  let result: ToolCallResultV1;
  try {
    result = await workspace.run(builtin.name, checked.args, view.principal);
  } catch {
    // Whatever broke in the host (its handler maps the errors it means
    // the caller to see into tool errors), the client gets no detail.
    audit(name, { ...allowed, outcome: "app_error", reason: "host_error" });
    return {
      kind: "result",
      result: errorResult(`${name} failed.`),
      tool: called,
    };
  }
  audit(name, {
    ...allowed,
    outcome: result.isError ? "tool_error" : "ok",
    resultBytes: resultBytes(result),
  });
  return { kind: "result", result, tool: called };
}

/**
 * An app tool, called by name directly or through a wrapper: resolve,
 * policy, the wrapper's ceiling, the arguments, one identity, one call.
 */
async function runAppTool(
  ctx: CallContext,
  name: string,
  rawArgs: unknown,
): Promise<ToolCallResolution> {
  const { view, deps } = ctx;
  const { principal } = view;
  const audit = auditor(ctx);
  // Directly, an unknown tool is the protocol's error; through a wrapper it
  // is the wrapper's answer, a tool error, so the client's turn goes on.
  const unknown = (event: Partial<ToolCallAuditEvent>): ToolCallResolution => {
    audit(name, { decision: "blocked", outcome: "not_run", ...event });
    return ctx.via
      ? {
          kind: "result",
          result: errorResult(`Unknown tool: ${displayedToolName(name)}`),
          tool: ctx.via.tool,
        }
      : { kind: "unknown_tool" };
  };

  // No catalog name is anywhere near this long.
  if (name.length > MAX_CALLED_NAME_LENGTH) {
    return unknown({ reason: "unknown_tool" });
  }
  // A wrapper delegates one app call or one workspace tool, never another
  // built-in: no recursion, and nothing a wrapper answers that a direct
  // call to it wouldn't.
  if (ctx.via) {
    const split = splitNamespacedToolName(name);
    if (split?.appId === BUILTIN_APP_ID) {
      const inner = findBuiltinTool(split.localName);
      return inner?.kind === "host"
        ? runHostTool(ctx, inner, rawArgs)
        : unknown({ reason: "unknown_tool" });
    }
  }
  const target = resolveToolName(view, name);
  if (!target) return unknown({ reason: "unknown_tool" });
  const { app, tool } = target;
  const about = { appId: app.appId, appRowId: app.rowId, risk: tool.risk };

  const policy = evaluateToolPolicy(tool, principal);
  if (policy.action !== "allow") {
    return unknown({ ...about, reason: policy.reason });
  }
  // The read wrapper's ceiling: a write tool is a tool the caller may well
  // use, just not through here, so the answer says where.
  if (ctx.via?.ceiling === "read" && tool.risk !== "read") {
    audit(name, {
      ...about,
      decision: "blocked",
      reason: "write_via_read_wrapper",
      outcome: "not_run",
    });
    return {
      kind: "result",
      result: errorResult(
        `\`${name}\` changes data; call it through ${WRITE_WRAPPER_NAME}.`,
      ),
      tool: ctx.via.tool,
    };
  }
  const called = ctx.via?.tool ?? tool;

  // By registry row: two rows (one app id in two organizations, or a fork
  // beside the app it forked) never share a validator, whatever hash each
  // reports.
  const checked = await checkArguments(
    deps,
    rawArgs,
    `${app.rowId}\u0000${app.catalogHash}\u0000${tool.name}`,
    tool.inputSchema,
  );
  if (!checked.ok) {
    audit(name, { ...about, decision: "allowed", ...refusal(checked) });
    return {
      kind: "result",
      result: errorResult(`Invalid arguments for ${name}: ${checked.problem}`),
      tool: called,
    };
  }
  const { args } = checked;
  const allowed = {
    ...about,
    decision: "allowed" as const,
    ...(checked.argsDigest ? { argsDigest: checked.argsDigest } : {}),
  };

  // The read wrapper narrows what the identity may do, whatever the
  // principal's access; the write wrapper and a direct call mint the
  // principal's own.
  const access = ctx.via?.ceiling === "read" ? "read" : principal.access;
  const identity = await mintIdentityJwt(deps.signing.privateKeyPem, {
    subject: {
      sub: principal.userId,
      email: principal.email,
      orgId: principal.organizationId,
      orgRole: principal.orgRole,
      orgName: principal.organizationName,
    },
    audience: app.audience,
    issuer: deps.signing.issuer,
    keyId: deps.signing.keyId,
    channel: "mcp",
    actor: { sub: actorFor(principal) },
    scopes: scopesForAccess(access),
    toolCall: { id: ctx.callId, name: tool.name },
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
            callId: ctx.callId,
          }),
          signal,
        }),
      );
      return readAppAnswer(app, tool, response, signal);
    });
  } catch (error) {
    const timedOut = error instanceof TimeoutError;
    audit(name, { ...allowed, outcome: timedOut ? "timeout" : "unreachable" });
    return {
      kind: "result",
      result: errorResult(
        timedOut
          ? `${app.name} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
          : `${app.name} could not be reached.`,
      ),
      tool: called,
    };
  }

  if (answer.drifted) deps.onCatalogDrift?.(app);
  audit(name, {
    ...allowed,
    outcome: answer.outcome,
    resultBytes: answer.bytes,
    ...(answer.reason ? { reason: answer.reason } : {}),
  });
  return { kind: "result", result: answer.result, tool: called };
}

/** What's wrong with the arguments, as far as the gateway checks them. */
function argumentsProblem(
  validatorKey: string,
  schema: JsonObject,
  args: unknown,
): string | null {
  const validate = argumentsValidator(validatorKey, schema);
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
