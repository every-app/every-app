/**
 * The event bus's shared contract (docs/design/2026-10-events-out.md): the
 * catalogue of types the gateway emits, the pattern a subscription matches
 * them by, the shape and size an app's own event may have, the headers a
 * delivery carries, and every limit, in one place the gateway, the CLI
 * (`everyapp events`), the SDK (`emit`) and the docs drift test read.
 *
 * The gateway builds each type's `data` and summary in
 * apps/every-app-gateway/src/server/events/catalogue.ts; this module knows
 * the names, versions and one-line descriptions only.
 */

export type EventGroup =
  | "member"
  | "app"
  | "cap"
  | "tool"
  | "connection"
  | "token"
  | "access"
  | "signin_provider"
  | "mcp_app"
  | "provider"
  | "ping";

export interface EventTypeInfo {
  /** `member.joined`, `cap.reached`, … */
  readonly type: string;
  /** Bumped when the type's `data` changes shape; the old one stays documented. */
  readonly version: number;
  /** One line, for `everyapp events types`, the Add dialog and the docs. */
  readonly description: string;
  readonly group: EventGroup;
}

const entry = (
  group: EventGroup,
  type: string,
  description: string,
  version = 1,
): EventTypeInfo => ({ type, version, description, group });

/**
 * Every type the gateway itself emits, in the order the docs list them.
 * An app's own events (`app.<id>.<name>`, {@link appEventType}) are a
 * pattern, not entries here. Reserved entries are emitted by sibling
 * features (remote MCP apps, the provider registry) through the same bus.
 */
export const EVENT_TYPES: readonly EventTypeInfo[] = [
  entry("member", "member.invited", "Someone was invited to the workspace"),
  entry("member", "member.joined", "Someone joined the workspace"),
  entry("member", "member.role_changed", "A member's role changed"),
  entry("member", "member.deactivated", "A member was deactivated"),
  entry("member", "member.reactivated", "A member was reactivated"),
  entry("member", "member.removed", "A member was removed"),
  entry("member", "member.password_reset", "A member reset their password"),
  entry("app", "app.installed", "An app was installed on the Gateway"),
  entry("app", "app.updated", "An app was redeployed"),
  entry("app", "app.removed", "An app was removed from the Gateway"),
  entry("app", "app.needs_setup", "An app needs a setting before it opens"),
  entry("app", "app.ready", "An app has every setting it needs"),
  entry(
    "app",
    "app.paused_cap",
    "An app is paused: its monthly cap is reached",
  ),
  entry("app", "app.tools_changed", "An app's AI tools changed"),
  entry("cap", "cap.warning", "An app is at 80% of its monthly cap"),
  entry("cap", "cap.reached", "An app reached its monthly cap"),
  entry(
    "cap",
    "cap.raised",
    "An app's monthly cap, or the workspace default, was raised or removed",
  ),
  entry("tool", "tool.blocked", "An AI client's tool call was blocked"),
  entry("tool", "tool.error", "An AI client's tool call failed"),
  entry("connection", "connection.created", "An AI app was connected"),
  entry("connection", "connection.revoked", "An AI app connection was revoked"),
  entry("token", "token.created", "A personal access token was created"),
  entry("token", "token.revoked", "A personal access token was revoked"),
  entry("access", "access.changed", "Cloudflare Access was turned on or off"),
  entry(
    "signin_provider",
    "signin_provider.added",
    "A sign-in provider (Continue with Google, …) was turned on",
  ),
  entry(
    "signin_provider",
    "signin_provider.removed",
    "A sign-in provider was turned off",
  ),
  entry("mcp_app", "mcp_app.added", "An MCP app was added"),
  entry("mcp_app", "mcp_app.removed", "An MCP app was removed"),
  entry("mcp_app", "mcp_app.enabled", "An MCP app is being served again"),
  entry("mcp_app", "mcp_app.disabled", "An MCP app stopped being served"),
  entry("provider", "provider.added", "An API provider was registered"),
  entry("provider", "provider.removed", "An API provider was removed"),
  entry("ping", "ping", "A test event, sent to one subscription on request"),
];

const typesByName = new Map(EVENT_TYPES.map((info) => [info.type, info]));

/** The catalogue entry for a type, or undefined for an app's own event. */
export function eventTypeInfo(type: string): EventTypeInfo | undefined {
  return typesByName.get(type);
}

/** The prefix every app's own event carries: `app.<app id>.<name>`. */
export const APP_EVENT_PREFIX = "app.";

/** An app's event name: `invoice.paid`, `todo_completed`; lowercase, dotted. */
export const APP_EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const APP_EVENT_NAME_MAX = 64;

/** The type an app's event is delivered as. */
export function appEventType(appId: string, name: string): string {
  return `${APP_EVENT_PREFIX}${appId}.${name}`;
}

/**
 * Whether `type` is an app's own event (`app.<id>.<name>`) rather than one
 * of the gateway's `app.*` entries, which have exactly one segment after
 * the prefix.
 */
export function isAppOwnEventType(type: string): boolean {
  return (
    type.startsWith(APP_EVENT_PREFIX) &&
    !typesByName.has(type) &&
    type.slice(APP_EVENT_PREFIX.length).includes(".")
  );
}

/** What is wrong with an app event's name, or null. */
export function appEventNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) {
    return "event is required: a name like invoice.paid";
  }
  if (name.length > APP_EVENT_NAME_MAX) {
    return `event is at most ${APP_EVENT_NAME_MAX} characters`;
  }
  if (!APP_EVENT_NAME_PATTERN.test(name)) {
    return "event is lowercase letters, digits and underscores, in segments joined by dots (invoice.paid)";
  }
  return null;
}

/** Bytes of `data` an app's event may carry, serialized. */
export const APP_EVENT_DATA_MAX_BYTES = 8 * 1024;
/** Bytes of `data` any event row may carry (the gateway's own included). */
export const EVENT_DATA_MAX_BYTES = 16 * 1024;
/** How deep `data` may nest. */
export const EVENT_DATA_MAX_DEPTH = 8;
/** Emits per app per hour (`rate_limit_counters`). */
export const APP_EVENT_RATE_PER_HOUR = 600;
/** Subscriptions per organization. */
export const EVENT_SUBSCRIPTIONS_MAX = 25;
/** A webhook signing secret's length. */
export const EVENT_SECRET_MIN_LENGTH = 16;
export const EVENT_SECRET_MAX_LENGTH = 128;
/**
 * Deliveries (the queue and its log) are kept this long. Events themselves
 * are the audit log and live longer ({@link AUDIT_RETENTION_DAYS}).
 */
export const EVENT_RETENTION_DAYS = 30;
/**
 * Events are kept this long: Admin → Activity → Audit, `everyapp workspace
 * audit` and `everyapp_workspace_audit` read them back. A constant, not a
 * setting.
 */
export const AUDIT_RETENTION_DAYS = 90;
/** The most audit rows one page carries, on every surface. */
export const AUDIT_PAGE_MAX = 200;
/** A subscription's URL. */
export const EVENT_URL_MAX_LENGTH = 2048;
/** A subscription's name. */
export const EVENT_SUBSCRIPTION_NAME_MAX = 100;
/**
 * The wait after attempt n fails (n from 1): the first attempt is right
 * after the event; the seventh failure is dead (about 35 hours in all).
 */
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [
  60_000, 300_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000,
];
export const EVENT_DELIVERY_MAX_ATTEMPTS = EVENT_RETRY_DELAYS_MS.length + 1;
/** A webhook's answer is awaited this long. */
export const EVENT_DELIVERY_TIMEOUT_MS = 10_000;
/** How much of a failed answer's body is read, and how much is kept. */
export const EVENT_RESPONSE_READ_MAX_BYTES = 1024;
export const EVENT_RESPONSE_KEEP_CHARS = 200;
/** The age of a signature's timestamp a receiver should accept. */
export const EVENT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The app-to-gateway route an app emits on (over the EVERY_APP_GATEWAY binding). */
export const EVENTS_EMIT_PATH = "/api/events/emit";

/** The headers every webhook delivery carries. */
export const EVENT_HEADERS = {
  event: "x-everyapp-event",
  eventId: "x-everyapp-event-id",
  delivery: "x-everyapp-delivery",
  attempt: "x-everyapp-attempt",
  signature: "x-everyapp-signature",
} as const;

/** The Gateway setting that lets http: and private hosts be targets. */
export const EVENTS_ALLOW_PRIVATE_TARGETS_SETTING =
  "EVENTS_ALLOW_PRIVATE_TARGETS";

/**
 * Name suffixes (and exact names) that mean a local or private machine: a
 * webhook target under one is refused unless EVENTS_ALLOW_PRIVATE_TARGETS
 * is "true". One list for the gateway (which checks a URL before every
 * attempt) and the CLI (which checks it when `everyapp events add` writes
 * the subscription), so the two never drift.
 */
export const EVENT_PRIVATE_NAME_SUFFIXES: readonly string[] = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "corp",
  "private",
  "home.arpa",
  "onion",
];

/**
 * Whether a normalized hostname (lowercase, no trailing dot) is a local or
 * private name: one of {@link EVENT_PRIVATE_NAME_SUFFIXES}, a name under
 * one (`n8n.lan`, `hooks.acme.corp`), or a bare label (`n8n`), which only
 * a private resolver answers.
 */
export function isPrivateEventTargetName(host: string): boolean {
  if (!host.includes(".")) return true;
  return EVENT_PRIVATE_NAME_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** The sinks a subscription delivers to. */
export const EVENT_SINKS = ["webhook", "email"] as const;
export type EventSink = (typeof EVENT_SINKS)[number];
/** Whom the email sink mails: the organization's owners, or owners and admins. */
export const EVENT_EMAIL_RECIPIENTS = ["owners", "admins"] as const;
export type EventEmailRecipients = (typeof EVENT_EMAIL_RECIPIENTS)[number];

/**
 * A subscription pattern: `*` (everything but ping), an exact type, or a
 * prefix with `.*` (`member.*`, `app.*`, `app.crm.*`). `app.*` matches the
 * gateway's app events and every app's own.
 */
export function eventPatternMatches(pattern: string, type: string): boolean {
  if (pattern === "*") return type !== "ping";
  if (pattern.endsWith(".*")) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return pattern === type;
}

/** Whether any of a subscription's patterns matches the type. */
export function eventSubscribed(
  patterns: readonly string[],
  type: string,
): boolean {
  return patterns.some((pattern) => eventPatternMatches(pattern, type));
}

const PATTERN_SHAPE = /^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/;

/**
 * What is wrong with a pattern someone typed, or null: a known type, a
 * prefix of known types (`member.*`), an app's own events (`app.crm.*`,
 * `app.crm.invoice.paid`), or `*`.
 */
export function eventPatternProblem(pattern: string): string | null {
  if (!PATTERN_SHAPE.test(pattern) || pattern.length > APP_EVENT_NAME_MAX + 8) {
    return `"${pattern}" isn't an event type or pattern (member.joined, member.*, app.crm.*, *)`;
  }
  if (pattern === "*" || typesByName.has(pattern)) return null;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    if (EVENT_TYPES.some((info) => info.type.startsWith(prefix))) return null;
    if (pattern.startsWith(APP_EVENT_PREFIX)) return null; // app.<id>.*
    return `"${pattern}" matches no event type (everyapp events types lists them)`;
  }
  if (isAppOwnEventType(pattern)) return null;
  return `"${pattern}" isn't an event type (everyapp events types lists them)`;
}

/**
 * A key that reads like a credential. An event's `data` is refused when any
 * key, at any depth, matches: a payload can't carry a secret by accident,
 * whether an app's own or the gateway's (the catalogue's builders are
 * checked by the same rule).
 */
export const CREDENTIAL_KEY_PATTERN =
  /secret|token|password|passwd|authorization|api[_-]?key|private[_-]?key|credential|cookie|session/i;

export type EventDataProblem =
  | { code: "event_data_invalid"; message: string }
  | { code: "event_data_too_large"; message: string; bytes: number }
  | { code: "event_data_refused"; message: string; key: string };

export type EventDataCheck =
  | { ok: true; bytes: number }
  | ({ ok: false } & EventDataProblem);

function findCredentialKey(value: unknown, depth: number): string | null {
  if (depth > EVENT_DATA_MAX_DEPTH) return "\0depth";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCredentialKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (CREDENTIAL_KEY_PATTERN.test(key)) return key;
      const found = findCredentialKey(inner, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Check an event's `data`: a JSON object (not an array, not a scalar), at
 * most `maxBytes` serialized, nested at most {@link EVENT_DATA_MAX_DEPTH}
 * deep, with no key named like a credential. Functions, bigints, dates and
 * the like must already be plain JSON: the caller serializes what it got.
 */
export function checkEventData(
  data: unknown,
  maxBytes = APP_EVENT_DATA_MAX_BYTES,
): EventDataCheck {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      code: "event_data_invalid",
      message: "data is a JSON object",
    };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return {
      ok: false,
      code: "event_data_invalid",
      message: "data must serialize as JSON",
    };
  }
  if (serialized === undefined) {
    return {
      ok: false,
      code: "event_data_invalid",
      message: "data is a JSON object",
    };
  }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: "event_data_too_large",
      message: `data is at most ${maxBytes.toLocaleString("en-US")} bytes as JSON (this is ${bytes.toLocaleString("en-US")})`,
      bytes,
    };
  }
  const key = findCredentialKey(JSON.parse(serialized), 1);
  if (key === "\0depth") {
    return {
      ok: false,
      code: "event_data_invalid",
      message: `data nests at most ${EVENT_DATA_MAX_DEPTH} levels deep`,
    };
  }
  if (key) {
    return {
      ok: false,
      code: "event_data_refused",
      message: `data must not carry a credential: the key "${key}" reads like one (secret, token, password, authorization, api key, private key, credential, cookie, session)`,
      key,
    };
  }
  return { ok: true, bytes };
}

/** What `POST /api/events/emit` takes from an app. */
export interface EmitEventRequest {
  /** The app's own name for the event (`invoice.paid`). */
  event: string;
  data: Record<string, unknown>;
}

/** What it answers. */
export interface EmitEventResult {
  /** The event's id (`evt_…`), or `dev-…` under `everyapp dev`. */
  id: string;
  /** The delivered type: `app.<app id>.<event>`. */
  type: string;
}

/**
 * The string a webhook delivery is signed over: the timestamp (seconds
 * since the epoch), a dot, the exact body.
 */
export function eventSigningInput(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

/** `t=<seconds>,v1=<hex>`, as the signature header carries it. */
export function formatEventSignature(
  timestamp: number,
  hexDigest: string,
): string {
  return `t=${timestamp},v1=${hexDigest}`;
}

/** The parts of a signature header, or null when it isn't one. */
export function parseEventSignature(
  header: string | null | undefined,
): { timestamp: number; v1: string[] } | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && value && /^[0-9a-f]{64}$/i.test(value)) {
      v1.push(value.toLowerCase());
    }
  }
  return timestamp !== null && v1.length > 0 ? { timestamp, v1 } : null;
}
