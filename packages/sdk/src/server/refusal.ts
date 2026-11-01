/**
 * The Gateway's own refusals, read the same way wherever they surface: a
 * `Response` from a gateway fetch ({@link gatewayRefusal}), the error an
 * SDK helper throws ({@link GatewayRefusalError}), or the error an AI
 * client throws for a refused call (an OpenAI SDK's `APIError`, ai-sdk's
 * `APICallError`) ({@link refusalFromError}).
 *
 * A refusal that means "not set up" (`integration_not_configured`,
 * `ai_provider_not_configured`, `ai_default_not_configured`) carries what
 * to do in the Gateway's words: `settings` (the setting names it needs),
 * `setup` (one sentence for a person) and `command` (what an admin runs,
 * `pnpm everyapp configure <app>`, or null). Show them as they are; never
 * match the message text or hardcode a setting name or a command.
 */
import { ConfigurationError, GATEWAY_ERROR_HEADER } from "../internal/index.js";

/** What would make it work, as the Gateway words it. */
export interface SetupInfo {
  /** The Gateway settings it needs (`["DATAFORSEO_API_KEY"]`); `[]` when ready or not a setting. */
  settings: readonly string[];
  /** One sentence for a person, naming what to set and how; null when ready. */
  setup: string | null;
  /** The command an admin runs (`pnpm everyapp configure crm`), or null. */
  command: string | null;
}

/** A refusal the AppGateway binding made itself, not the provider. */
export interface GatewayRefusal extends SetupInfo {
  status: number;
  /** e.g. `capability_not_requested`, `integration_not_configured`. */
  code: string;
  message: string;
}

/** The refusal codes that mean no model is set up for the call. */
export const AI_NOT_CONFIGURED_CODES: readonly string[] = [
  "ai_provider_not_configured",
  "ai_default_not_configured",
];

/**
 * A refusal the AppGateway binding made, thrown: what `sendEmail()` throws
 * when the gateway won't send (`email_sender_not_allowed`,
 * `email_budget_exhausted`, ...). The thrown twin of {@link gatewayRefusal}.
 */
export class GatewayRefusalError extends Error implements GatewayRefusal {
  readonly status: number;
  readonly code: string;
  readonly settings: readonly string[];
  readonly setup: string | null;
  readonly command: string | null;

  constructor({
    status,
    code,
    message,
    settings = [],
    setup = null,
    command = null,
  }: Pick<GatewayRefusal, "status" | "code" | "message"> & Partial<SetupInfo>) {
    super(message);
    this.name = "GatewayRefusalError";
    this.status = status;
    this.code = code;
    this.settings = settings;
    this.setup = setup;
    this.command = command;
  }
}

/**
 * The gateway's own refusal in `response`, or null when the response is the
 * provider's answer (which may be an error of its own). Reads the body only
 * for a refusal, so call it before reading the body yourself.
 */
export async function gatewayRefusal(
  response: Response,
): Promise<GatewayRefusal | null> {
  const code = response.headers.get(GATEWAY_ERROR_HEADER);
  if (!code) return null;
  const body: unknown = await response.json().catch(() => null);
  return refusalOf(response.status, code, body);
}

/**
 * The Gateway's refusal behind a thrown error, or null when it isn't one:
 * a {@link GatewayRefusalError} (`sendEmail()`, `listMembers()`, `emit()`),
 * an OpenAI SDK `APIError` or an ai-sdk `APICallError` for a call the
 * Gateway refused (also inside ai-sdk's `RetryError` or an error's
 * `cause`), or the SDK's local-development `ConfigurationError` for a
 * missing key, which answers as the deployed refusal would
 * (`ai_provider_not_configured`, status 503, the `.dev.vars` names).
 */
export function refusalFromError(error: unknown): GatewayRefusal | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const found = refusalHere(current);
    if (found) return found;
    const record = current as Record<string, unknown>;
    current = record["lastError"] ?? record["cause"];
  }
  return null;
}

/**
 * Whether `error` (or a refusal already read) means no model is set up:
 * `ai_provider_not_configured` or `ai_default_not_configured`, from the
 * Gateway or, in local development, from the SDK with no key in
 * `.dev.vars`. Show `refusalFromError(error).setup` to the person.
 */
export function isAiNotConfigured(error: unknown): boolean {
  const refusal = isRefusal(error) ? error : refusalFromError(error);
  return refusal !== null && AI_NOT_CONFIGURED_CODES.includes(refusal.code);
}

function isRefusal(value: unknown): value is GatewayRefusal {
  return (
    !!value &&
    typeof value === "object" &&
    !(value instanceof Error) &&
    typeof (value as GatewayRefusal).code === "string" &&
    typeof (value as GatewayRefusal).status === "number"
  );
}

function refusalHere(error: object): GatewayRefusal | null {
  // A Response is read with gatewayRefusal(), which can read its body.
  if (error instanceof Response) return null;
  if (error instanceof GatewayRefusalError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      settings: error.settings,
      setup: error.setup,
      command: error.command,
    };
  }
  if (error instanceof ConfigurationError) {
    if (!error.code) return null;
    return {
      status: 503,
      code: error.code,
      message: error.message,
      settings: error.settings,
      setup: error.message,
      command: null,
    };
  }
  const record = error as Record<string, unknown>;
  // ai-sdk's APICallError: lowercase header names, the body as text.
  const responseHeaders = record["responseHeaders"];
  if (responseHeaders && typeof responseHeaders === "object") {
    const code = headerOf(responseHeaders, GATEWAY_ERROR_HEADER);
    if (!code) return null;
    return refusalOf(
      numberOf(record["statusCode"]),
      code,
      parseJson(record["responseBody"]),
      messageOf(error),
    );
  }
  // An OpenAI SDK APIError: `headers` (Headers or a record), `status`,
  // and `error`, the body's `error` object (which carries the same fields).
  const headers = record["headers"];
  if (headers && typeof headers === "object" && "status" in record) {
    const code = headerOf(headers, GATEWAY_ERROR_HEADER);
    if (!code) return null;
    return refusalOf(
      numberOf(record["status"]),
      code,
      record["error"],
      messageOf(error),
    );
  }
  return null;
}

/** A refusal from its status, code and body (the Gateway's `{ code, message, … }`, or OpenAI's `{ error: {…} }`). */
function refusalOf(
  status: number,
  code: string,
  body: unknown,
  fallback?: string,
): GatewayRefusal {
  const top = recordOf(body);
  const inner = recordOf(top?.["error"]);
  const field = (name: string): unknown => top?.[name] ?? inner?.[name];
  const message =
    stringOf(top?.["message"]) ??
    stringOf(inner?.["message"]) ??
    fallback ??
    `The EveryApp gateway refused the call (${code}).`;
  const settings = field("settings");
  return {
    status,
    code,
    message,
    settings: Array.isArray(settings)
      ? settings.filter((name): name is string => typeof name === "string")
      : [],
    setup: stringOf(field("setup")) ?? null,
    command: stringOf(field("command")) ?? null,
  };
}

function headerOf(headers: object, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function messageOf(error: object): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}
