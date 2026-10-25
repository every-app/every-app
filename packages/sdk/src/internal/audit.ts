/**
 * The audit log's shared reading of an event row: who did it, what it was
 * about, and what the type means in plain words. Admin → Activity → Audit,
 * `everyapp workspace audit` and `everyapp_workspace_audit` all show the
 * same columns, so the three derive them here, from the stored `actor`
 * and `data` (the catalogue's builders decide what those hold; the
 * gateway's `summarize` writes the one-line summary from the same data).
 * Nothing here reads a secret, a tool's arguments or result, or a mail
 * body: the rows never hold one.
 */
import {
  APP_EVENT_PREFIX,
  EVENT_TYPES,
  eventPatternMatches,
  eventTypeInfo,
  isAppOwnEventType,
  type EventGroup,
  type EventTypeInfo,
} from "./events.js";

/** Who caused an audit event, as every surface shows it. */
export interface AuditActor {
  /** `user`, `agent`, `app`, `operator`, `gateway`, or what the row says. */
  kind: string;
  /** The user id, the credential id (an agent), the app id, the operator's id; null for the gateway. */
  id: string | null;
  email: string | null;
  /** A member's name, or the AI app's name for an agent. */
  name: string | null;
}

/** What an audit event is about, picked from its `data` by the keys the catalogue uses. */
export interface AuditSubject {
  app?: { id: string; name: string | null };
  user?: { id: string; email: string | null; name: string | null };
  group?: { id: string; name: string | null };
  provider?: { id: string; name: string | null };
  mcpApp?: { id: string; name: string | null };
  subscription?: { id: string; name: string | null };
  /** `member.invited`: whom. */
  invitation?: { email: string; role: string | null };
  /** Setting names an event lists (never a value): unmet, changed, added, removed. */
  settings?: string[];
  tool?: string;
  /** The AI app of a connection or a blocked call. */
  client?: string;
  /** A personal access token's name. */
  token?: string;
}

type Data = Record<string, unknown>;

function obj(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The stored `actor` (a JSON string or the parsed object) as the surfaces show it. */
export function auditActorOf(actor: unknown): AuditActor {
  let parsed: unknown = actor;
  if (typeof actor === "string") {
    try {
      parsed = JSON.parse(actor);
    } catch {
      parsed = {};
    }
  }
  const who = obj(parsed);
  return {
    kind: str(who.kind) ?? "gateway",
    id: str(who.id),
    email: str(who.email),
    name: str(who.name),
  };
}

/**
 * The Who cell: a person by name or email, "agent · Claude" for an AI
 * client, "CLI · <operator>" for the operator's command line, "app · crm"
 * for an app's own event, "Gateway" for what the gateway did by itself.
 */
export function auditActorLabel(actor: AuditActor): string {
  switch (actor.kind) {
    case "user":
      return actor.name ?? actor.email ?? actor.id ?? "a member";
    case "agent":
      return `agent · ${actor.name ?? actor.id ?? "AI app"}`;
    case "operator":
      return `CLI · ${actor.email ?? actor.id ?? "operator"}`;
    case "app":
      return `app · ${actor.id ?? "app"}`;
    case "gateway":
      return "Gateway";
    default:
      return actor.name ?? actor.email ?? actor.id ?? actor.kind;
  }
}

/** The plain-words label for a type: the catalogue's description, or "App event" for an app's own. */
export function auditTypeLabel(type: string): string {
  const info = eventTypeInfo(type);
  if (info) return info.description;
  if (isAppOwnEventType(type)) {
    const rest = type.slice(APP_EVENT_PREFIX.length);
    return `App event: ${rest.slice(rest.indexOf(".") + 1)}`;
  }
  return type;
}

function named(
  value: unknown,
): { id: string; name: string | null } | undefined {
  const subject = obj(value);
  const id = str(subject.id) ?? str(subject.rowId);
  return id ? { id, name: str(subject.name) } : undefined;
}

/** What the event is about, from its stored `data`. */
export function auditSubjectOf(type: string, data: unknown): AuditSubject {
  const d = obj(data);
  const subject: AuditSubject = {};
  const app = named(d.app);
  if (app) {
    if (type.startsWith("mcp_app.")) subject.mcpApp = app;
    else subject.app = app;
  } else if (isAppOwnEventType(type)) {
    const rest = type.slice(APP_EVENT_PREFIX.length);
    subject.app = { id: rest.slice(0, rest.indexOf(".")), name: null };
  }
  const user = obj(d.user);
  if (str(user.id)) {
    subject.user = {
      id: str(user.id)!,
      email: str(user.email),
      name: str(user.name),
    };
  }
  const group = named(d.group);
  if (group) subject.group = group;
  const provider = named(d.provider);
  if (provider) subject.provider = provider;
  const subscription = named(d.subscription);
  if (subscription) subject.subscription = subscription;
  const invitation = obj(d.invitation);
  if (str(invitation.email)) {
    subject.invitation = {
      email: str(invitation.email)!,
      role: str(invitation.role),
    };
  }
  const settings = [
    ...strings(d.settings),
    ...strings(d.unmet),
    ...strings(d.changed),
    ...strings(d.names),
  ];
  if (settings.length > 0) subject.settings = [...new Set(settings)];
  const tool = str(d.tool);
  if (tool) subject.tool = tool;
  const client = str(obj(d.client).name) ?? str(obj(d.connection).clientName);
  if (client) subject.client = client;
  if (type.startsWith("token.") && str(d.name)) subject.token = str(d.name)!;
  return subject;
}

/** The Subject cell: the first thing the event is about, by name, then what else it names. */
export function auditSubjectLabel(subject: AuditSubject): string {
  const parts: string[] = [];
  const app = subject.app ?? subject.mcpApp;
  if (app) parts.push(app.name ?? app.id);
  if (subject.user) {
    parts.push(subject.user.name ?? subject.user.email ?? subject.user.id);
  }
  if (subject.invitation) parts.push(subject.invitation.email);
  if (subject.group) parts.push(subject.group.name ?? subject.group.id);
  if (subject.provider) {
    parts.push(subject.provider.name ?? subject.provider.id);
  }
  if (subject.subscription) {
    parts.push(subject.subscription.name ?? subject.subscription.id);
  }
  if (subject.token) parts.push(subject.token);
  if (subject.tool) parts.push(subject.tool);
  if (subject.client) parts.push(subject.client);
  if (subject.settings) parts.push(subject.settings.join(", "));
  return parts.join(" · ");
}

/**
 * What the audit log leaves out unless asked for by type: `ping` (a test)
 * and `tool.*` (the tool-calls view lists every call, blocked or not).
 */
export const AUDIT_DEFAULT_EXCLUDED: readonly string[] = ["ping", "tool.*"];

/**
 * Whether an event of `type` is in the audit log's default view, or
 * matches the type filter given (an exact type, or a prefix like
 * `member.*`; `*` is everything, the excluded included).
 */
export function auditTypeMatches(
  type: string,
  filter: string | undefined,
): boolean {
  if (filter === undefined) {
    return !AUDIT_DEFAULT_EXCLUDED.some((pattern) =>
      eventPatternMatches(pattern, type),
    );
  }
  if (filter === "*") return true;
  return eventPatternMatches(filter, type);
}

/** The SQL the filter translates to: `type = ?` or `type LIKE 'prefix.%'`; null for `*`. */
export function auditTypeCondition(
  filter: string,
): { op: "eq"; value: string } | { op: "prefix"; value: string } | null {
  if (filter === "*") return null;
  if (filter.endsWith(".*"))
    return { op: "prefix", value: filter.slice(0, -1) };
  return { op: "eq", value: filter };
}

/** A type-filter value someone typed, cleaned, or null for none. */
export function auditTypeFilterOf(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : undefined;
}

export interface AuditTypeGroup {
  group: EventGroup;
  label: string;
  /** `member.*` */
  pattern: string;
  types: EventTypeInfo[];
}

/** A group with no heading here reads as its name ("organization" → "Organization"). */
function groupHeading(group: string): string {
  const words = group.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The groups' plain-words headings, as the Add-subscription dialog names them. */
export const AUDIT_GROUP_LABELS: Partial<Record<EventGroup, string>> = {
  member: "Members",
  app: "Apps",
  cap: "Monthly caps",
  tool: "Agent tool calls",
  connection: "AI connections",
  token: "Tokens",
  access: "Cloudflare Access",
  mcp_app: "MCP apps",
  provider: "API providers",
  ping: "Test",
};

/** The catalogue grouped for a type filter, in catalogue order, `ping` left out. */
export function auditTypeGroups(
  types: readonly EventTypeInfo[] = EVENT_TYPES,
): AuditTypeGroup[] {
  const groups = new Map<EventGroup, AuditTypeGroup>();
  for (const info of types) {
    if (info.group === "ping") continue;
    const existing = groups.get(info.group);
    if (existing) existing.types.push(info);
    else {
      groups.set(info.group, {
        group: info.group,
        label: AUDIT_GROUP_LABELS[info.group] ?? groupHeading(info.group),
        pattern: `${info.group}.*`,
        types: [info],
      });
    }
  }
  return [...groups.values()];
}
