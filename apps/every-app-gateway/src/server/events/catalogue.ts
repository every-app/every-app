/**
 * The catalogue's builders (docs/design/2026-10-events-out.md, section 1):
 * for every type in EVENT_TYPES, one function that takes typed input and
 * returns the event's `data`, version, dedupe key and app row, exactly as
 * the contract's table lists them. These are the only writers of a
 * gateway event's `data`, so what an event can carry is decided here and
 * nowhere else: a member as `{ id, email, name }`, an app as
 * `{ id, rowId, name }`, names of settings and tools, counts, reasons.
 * Never a link, a token's value, a tool's arguments or result, a mail
 * body or a provider's answer; a test holds every builder to the same
 * credential-key rule an app's own event meets.
 *
 * The summary line and the fields the email sink reads come from the
 * stored `data` ({@link summarize}, {@link eventEmailFields}), not from a
 * column, so an event the CLI queued straight into D1 reads the same as
 * one the gateway emitted.
 */
import {
  eventTypeInfo,
  isAppOwnEventType,
  APP_EVENT_PREFIX,
} from "@every-app/sdk/internal";

/** The member an event is about; null fields for a person who has left. */
export interface EventUser {
  id: string;
  email: string | null;
  name: string | null;
}

/** Who caused an event. */
export type EventActor =
  | { kind: "user"; id: string; email?: string | null; name?: string | null }
  | { kind: "agent"; id?: string; name?: string }
  | { kind: "app"; id: string }
  | { kind: "operator"; id: string }
  | { kind: "gateway" };

/** The app an event is about: the manifest id, the registry row, the name. */
export interface EventApp {
  id: string;
  rowId: string;
  name: string;
}

/** The provider an event is about: its id, its name, and what kind it is. */
interface EventProvider {
  id: string;
  name: string;
  /** An API key the Gateway holds, or an OAuth client it runs the flow for. */
  kind?: "api_key" | "oauth";
}

/** Whose account at a provider: a person's (with who) or the organization's. */
interface EventProviderAccount {
  kind: "user" | "organization";
  /** The member whose account it is, for a person's. */
  user?:
    | { id: string; email?: string | null; name?: string | null }
    | undefined;
  /** How the provider names the account ("ben" at GitHub). */
  label?: string | null | undefined;
}

/** What a builder returns: everything emit() stores, minus who and where. */
export interface BuiltEvent {
  type: string;
  version: number;
  data: Record<string, unknown>;
  /** Set for events that happen once per subject (cap.warning per month). */
  dedupeKey?: string;
  /** The app row the event is about, for the deliveries filter. */
  appRowId?: string;
}

type CapSource = "app" | "default";
type McpAppKind = "builtin" | "remote";
type ToolClientKind = "pat" | "session" | "dev" | "oauth" | "access";

/** Tool names an app.tools_changed event lists, each way. */
const TOOL_NAMES_MAX = 50;
/** The share of the cap cap.warning fires at. */
export const CAP_WARNING_THRESHOLD = 80;

function versionOf(type: string): number {
  return eventTypeInfo(type)?.version ?? 1;
}

function built(
  type: string,
  data: Record<string, unknown>,
  extra: { dedupeKey?: string; appRowId?: string } = {},
): BuiltEvent {
  return { type, version: versionOf(type), data, ...extra };
}

/** A user as `data` carries it: the three fields, nulls kept. */
function user(member: EventUser): EventUser {
  return { id: member.id, email: member.email, name: member.name };
}

function provider(input: EventProvider): Data {
  return {
    id: input.id,
    name: input.name,
    ...(input.kind ? { kind: input.kind } : {}),
  };
}

function account(input: EventProviderAccount): Data {
  return {
    kind: input.kind,
    ...(input.user
      ? {
          user: {
            id: input.user.id,
            ...(input.user.email ? { email: input.user.email } : {}),
            ...(input.user.name ? { name: input.user.name } : {}),
          },
        }
      : {}),
    ...(input.label ? { label: input.label } : {}),
  };
}

function app(subject: EventApp): EventApp {
  return { id: subject.id, rowId: subject.rowId, name: subject.name };
}

/** Drop undefined fields so the stored JSON has no "key": undefined holes. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

/** `cap.<kind>:<org>:<app row>:<month>:<cap>`, with the threshold for a warning. */
export function capKey(
  type: string,
  organizationId: string,
  appRowId: string,
  month: string,
  cap: number,
  threshold?: number,
): string {
  const base = `${type}:${organizationId}:${appRowId}:${month}:${cap}`;
  return threshold === undefined ? base : `${base}:${threshold}`;
}

interface CapInput {
  organizationId: string;
  app: EventApp;
  cap: number;
  calls: number;
  /** "YYYY-MM" */
  month: string;
  source: CapSource;
}

export const catalogue = {
  memberInvited(input: {
    invitation: { id: string; email: string; role: string; expiresAt: Date };
    emailSent: boolean;
  }): BuiltEvent {
    const { invitation } = input;
    return built("member.invited", {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
      },
      emailSent: input.emailSent,
    });
  },

  memberJoined(input: {
    user: EventUser;
    role: string;
    via: "invitation" | "access" | "sign_in" | "setup" | "member_add";
  }): BuiltEvent {
    return built("member.joined", {
      user: user(input.user),
      role: input.role,
      via: input.via,
    });
  },

  memberRoleChanged(input: {
    user: EventUser;
    role: string;
    previousRole: string;
  }): BuiltEvent {
    return built("member.role_changed", {
      user: user(input.user),
      role: input.role,
      previousRole: input.previousRole,
    });
  },

  memberDeactivated(input: { user: EventUser; reason?: string }): BuiltEvent {
    return built(
      "member.deactivated",
      compact({ user: user(input.user), reason: input.reason }),
    );
  },

  memberReactivated(input: { user: EventUser }): BuiltEvent {
    return built("member.reactivated", { user: user(input.user) });
  },

  memberRemoved(input: {
    user: EventUser;
    accountDeleted: boolean;
  }): BuiltEvent {
    return built("member.removed", {
      user: user(input.user),
      accountDeleted: input.accountDeleted,
    });
  },

  memberPasswordReset(input: {
    user: EventUser;
    by: "self" | "admin_link" | "admin_email";
  }): BuiltEvent {
    return built("member.password_reset", {
      user: user(input.user),
      by: input.by,
    });
  },

  appInstalled(input: {
    app: EventApp;
    version?: string | null;
    hostname?: string | null;
    scope: "org" | "shared";
    source: "cli" | "browser" | "release";
  }): BuiltEvent {
    return built(
      "app.installed",
      compact({
        app: app(input.app),
        version: input.version ?? undefined,
        hostname: input.hostname ?? undefined,
        scope: input.scope,
        source: input.source,
      }),
      { appRowId: input.app.rowId },
    );
  },

  appUpdated(input: {
    app: EventApp;
    version?: string | null;
    previousVersion?: string | null;
  }): BuiltEvent {
    return built(
      "app.updated",
      compact({
        app: app(input.app),
        version: input.version ?? undefined,
        previousVersion: input.previousVersion ?? undefined,
      }),
      { appRowId: input.app.rowId },
    );
  },

  appRemoved(input: { app: EventApp; purged: boolean }): BuiltEvent {
    return built(
      "app.removed",
      { app: app(input.app), purged: input.purged },
      { appRowId: input.app.rowId },
    );
  },

  appNeedsSetup(input: { app: EventApp; unmet: string[] }): BuiltEvent {
    return built(
      "app.needs_setup",
      { app: app(input.app), unmet: [...input.unmet] },
      { appRowId: input.app.rowId },
    );
  },

  appReady(input: { app: EventApp }): BuiltEvent {
    return built(
      "app.ready",
      { app: app(input.app) },
      { appRowId: input.app.rowId },
    );
  },

  appPausedCap(input: CapInput): BuiltEvent {
    return built(
      "app.paused_cap",
      {
        app: app(input.app),
        cap: input.cap,
        calls: input.calls,
        month: input.month,
        source: input.source,
      },
      {
        appRowId: input.app.rowId,
        dedupeKey: capKey(
          "app.paused_cap",
          input.organizationId,
          input.app.rowId,
          input.month,
          input.cap,
        ),
      },
    );
  },

  appToolsChanged(input: {
    app: EventApp;
    kind: "app" | McpAppKind;
    toolCount: number;
    previousToolCount: number;
    added: string[];
    removed: string[];
  }): BuiltEvent {
    return built(
      "app.tools_changed",
      {
        app: app(input.app),
        kind: input.kind,
        toolCount: input.toolCount,
        previousToolCount: input.previousToolCount,
        added: input.added.slice(0, TOOL_NAMES_MAX),
        removed: input.removed.slice(0, TOOL_NAMES_MAX),
      },
      { appRowId: input.app.rowId },
    );
  },

  capWarning(input: CapInput): BuiltEvent {
    return built(
      "cap.warning",
      {
        app: app(input.app),
        cap: input.cap,
        calls: input.calls,
        month: input.month,
        threshold: CAP_WARNING_THRESHOLD,
        source: input.source,
      },
      {
        appRowId: input.app.rowId,
        dedupeKey: capKey(
          "cap.warning",
          input.organizationId,
          input.app.rowId,
          input.month,
          input.cap,
          CAP_WARNING_THRESHOLD,
        ),
      },
    );
  },

  capReached(input: CapInput): BuiltEvent {
    return built(
      "cap.reached",
      {
        app: app(input.app),
        cap: input.cap,
        calls: input.calls,
        month: input.month,
        source: input.source,
      },
      {
        appRowId: input.app.rowId,
        dedupeKey: capKey(
          "cap.reached",
          input.organizationId,
          input.app.rowId,
          input.month,
          input.cap,
        ),
      },
    );
  },

  capRaised(input: {
    /** The app whose own setting changed; null for the workspace default (`source: "default"`). */
    app: EventApp | null;
    /**
     * For an app, the cap that binds it after and before the change (its
     * own, else the default; null = none), not the row's own column: a cap
     * set under the default is no raise, `unlimited` under a default is a
     * removal. For the default, the default itself.
     */
    cap: number | null;
    previousCap: number | null;
    source: CapSource;
  }): BuiltEvent {
    return built(
      "cap.raised",
      {
        app: input.app ? app(input.app) : null,
        cap: input.cap,
        previousCap: input.previousCap,
        source: input.source,
      },
      input.app ? { appRowId: input.app.rowId } : {},
    );
  },

  toolBlocked(input: {
    tool: string;
    app?: EventApp;
    user: EventUser;
    client?: { kind: ToolClientKind; name?: string; id: string };
    risk?: string;
    reason: string;
    callId: string;
  }): BuiltEvent {
    return built(
      "tool.blocked",
      compact({
        tool: input.tool,
        app: input.app ? app(input.app) : undefined,
        user: user(input.user),
        client: input.client ? compact({ ...input.client }) : undefined,
        risk: input.risk,
        reason: input.reason,
        callId: input.callId,
      }),
      input.app ? { appRowId: input.app.rowId } : {},
    );
  },

  toolError(input: {
    tool: string;
    app?: EventApp;
    user: EventUser;
    client?: { kind: ToolClientKind; name?: string; id: string };
    risk?: string;
    outcome: string;
    callId: string;
    durationMs: number;
  }): BuiltEvent {
    return built(
      "tool.error",
      compact({
        tool: input.tool,
        app: input.app ? app(input.app) : undefined,
        user: user(input.user),
        client: input.client ? compact({ ...input.client }) : undefined,
        risk: input.risk,
        outcome: input.outcome,
        callId: input.callId,
        durationMs: input.durationMs,
      }),
      input.app ? { appRowId: input.app.rowId } : {},
    );
  },

  connectionCreated(input: {
    connection: {
      id: string;
      clientName: string;
      clientDomain?: string | null;
      access: "read" | "write";
      appScope: "all" | "selected";
    };
    user: EventUser;
  }): BuiltEvent {
    const { connection } = input;
    return built("connection.created", {
      connection: compact({
        id: connection.id,
        clientName: connection.clientName,
        clientDomain: connection.clientDomain ?? undefined,
        access: connection.access,
        appScope: connection.appScope,
      }),
      user: user(input.user),
    });
  },

  connectionRevoked(input: {
    connection: { id: string; clientName: string };
    user: EventUser;
    reason: string;
  }): BuiltEvent {
    return built("connection.revoked", {
      connection: {
        id: input.connection.id,
        clientName: input.connection.clientName,
      },
      user: user(input.user),
      reason: input.reason,
    });
  },

  /**
   * The token's row id, name, scopes, app and expiry, flat: the contract
   * nests them under `token`, but every key named like a credential is
   * refused for events (CREDENTIAL_KEY_PATTERN matches "token" itself),
   * and the gateway's own events keep the same rule.
   */
  tokenCreated(input: {
    id: string;
    name: string;
    scopes: string[];
    appId?: string | null;
    expiresAt?: Date | null;
    user: EventUser;
  }): BuiltEvent {
    return built(
      "token.created",
      compact({
        id: input.id,
        name: input.name,
        scopes: [...input.scopes],
        appId: input.appId ?? undefined,
        expiresAt: input.expiresAt?.toISOString(),
        user: user(input.user),
      }),
    );
  },

  tokenRevoked(input: {
    id: string;
    name: string;
    user: EventUser;
  }): BuiltEvent {
    return built("token.revoked", {
      id: input.id,
      name: input.name,
      user: user(input.user),
    });
  },

  accessChanged(input: {
    access: "on" | "off";
    teamDomain?: string;
    emailDomains?: string[];
  }): BuiltEvent {
    return built(
      "access.changed",
      compact({
        access: input.access,
        teamDomain: input.teamDomain,
        emailDomains: input.emailDomains ? [...input.emailDomains] : undefined,
      }),
    );
  },

  /**
   * `everyapp signin add|remove` (the CLI's outbox): which provider, and
   * its button's label. Never a setting's name or value.
   */
  signInProviderAdded(input: { provider: string; label: string }): BuiltEvent {
    return built("signin_provider.added", {
      provider: input.provider,
      label: input.label,
    });
  },

  signInProviderRemoved(input: {
    provider: string;
    label: string;
  }): BuiltEvent {
    return built("signin_provider.removed", {
      provider: input.provider,
      label: input.label,
    });
  },

  mcpAppAdded(input: { app: EventApp; kind: McpAppKind }): BuiltEvent {
    return built(
      "mcp_app.added",
      { app: app(input.app), kind: input.kind },
      { appRowId: input.app.rowId },
    );
  },

  mcpAppRemoved(input: { app: EventApp; kind: McpAppKind }): BuiltEvent {
    return built(
      "mcp_app.removed",
      { app: app(input.app), kind: input.kind },
      { appRowId: input.app.rowId },
    );
  },

  mcpAppEnabled(input: { app: EventApp; kind: McpAppKind }): BuiltEvent {
    return built(
      "mcp_app.enabled",
      { app: app(input.app), kind: input.kind },
      { appRowId: input.app.rowId },
    );
  },

  mcpAppDisabled(input: { app: EventApp; kind: McpAppKind }): BuiltEvent {
    return built(
      "mcp_app.disabled",
      { app: app(input.app), kind: input.kind },
      { appRowId: input.app.rowId },
    );
  },

  providerAdded(input: { provider: EventProvider }): BuiltEvent {
    return built("provider.added", { provider: provider(input.provider) });
  },

  providerRemoved(input: { provider: EventProvider }): BuiltEvent {
    return built("provider.removed", { provider: provider(input.provider) });
  },

  /** A provider's spec was replaced, or its OAuth client uploaded again. */
  providerUpdated(input: {
    provider: EventProvider;
    /** What changed: the spec, or the client (never its value). */
    change: "spec" | "client";
  }): BuiltEvent {
    return built("provider.updated", {
      provider: provider(input.provider),
      change: input.change,
    });
  },

  /** Someone connected their account, or the organization's, at an OAuth provider. */
  providerConnected(input: {
    provider: EventProvider;
    account: EventProviderAccount;
    scopeSets: readonly string[];
    /** True when the connection replaced an earlier one. */
    reconnected?: boolean;
  }): BuiltEvent {
    return built("provider.connected", {
      provider: provider(input.provider),
      account: account(input.account),
      scopeSets: [...input.scopeSets],
      reconnected: input.reconnected ?? false,
    });
  },

  providerDisconnected(input: {
    provider: EventProvider;
    account: EventProviderAccount;
    /** Whether the Gateway revoked the grant at the provider too. */
    revoked: boolean;
  }): BuiltEvent {
    return built("provider.disconnected", {
      provider: provider(input.provider),
      account: account(input.account),
      revoked: input.revoked,
    });
  },

  /** The provider refused a refresh; once per connection until it is connected again. */
  providerConnectionExpired(input: {
    provider: EventProvider;
    account: EventProviderAccount;
    connectionId: string;
  }): BuiltEvent {
    return built(
      "provider.connection_expired",
      {
        provider: provider(input.provider),
        account: account(input.account),
      },
      { dedupeKey: `provider.connection_expired:${input.connectionId}` },
    );
  },

  ping(input: {
    subscription: { id: string; name: string };
    message?: string;
  }): BuiltEvent {
    return built("ping", {
      subscription: {
        id: input.subscription.id,
        name: input.subscription.name,
      },
      message:
        input.message ??
        "Test event from Every App. Your subscription receives events.",
    });
  },
} as const;

/* ---- Reading an event back: the summary line and the email's fields ---- */

type Data = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/** Whose provider account: the person named in it, "the workspace" for the organization's, else the actor. */
function accountLabel(
  value: unknown,
  actor: EventActor | Data | null | undefined,
): string {
  const account = obj(value);
  if (account.kind === "organization") return "The workspace";
  const who = obj(account.user);
  return str(who.email) ?? str(who.name) ?? actorLabel(actor);
}

/** A member as a summary names them: the address, else the name, else the id. */
function userLabel(value: unknown): string {
  const member = obj(value);
  return str(member.email) ?? str(member.name) ?? str(member.id) ?? "someone";
}

/** An actor as a summary names them: the name, else the address, else the kind. */
function actorLabel(actor: EventActor | Data | null | undefined): string {
  const who = obj(actor);
  return (
    str(who.name) ??
    str(who.email) ??
    (who.kind === "app" || who.kind === "operator" ? str(who.id) : null) ??
    (who.kind === "agent" ? "an agent" : null) ??
    (who.kind === "gateway" ? "the gateway" : null) ??
    "someone"
  );
}

function appLabel(value: unknown): string {
  const subject = obj(value);
  return str(subject.name) ?? str(subject.id) ?? "an app";
}

const n = (value: number | null): string =>
  value === null ? "?" : value.toLocaleString("en-US");

/**
 * The one line a person reads for an event, from its stored data and
 * actor: what the email sink puts in the subject, the envelope carries as
 * `summary`, and the deliveries list shows.
 */
export function summarize(
  type: string,
  data: Data,
  actor: EventActor | Data | null | undefined,
): string {
  const d = obj(data);
  switch (type) {
    case "member.invited": {
      const invitation = obj(d.invitation);
      return `${actorLabel(actor)} invited ${str(invitation.email) ?? "someone"} as ${str(invitation.role) ?? "member"}`;
    }
    case "member.joined":
      return `${userLabel(d.user)} joined as ${str(d.role) ?? "member"}`;
    case "member.role_changed":
      return `${userLabel(d.user)} is now ${str(d.role) ?? "a member"}`;
    case "member.deactivated":
      return `${userLabel(d.user)} was deactivated`;
    case "member.reactivated":
      return `${userLabel(d.user)} was reactivated`;
    case "member.removed":
      return `${userLabel(d.user)} was removed`;
    case "member.password_reset":
      return `${userLabel(d.user)} reset their password`;
    case "app.installed":
      return `${appLabel(d.app)} was installed`;
    case "app.updated":
      return str(d.version)
        ? `${appLabel(d.app)} was redeployed (version ${str(d.version)})`
        : `${appLabel(d.app)} was redeployed`;
    case "app.removed":
      return `${appLabel(d.app)} was removed`;
    case "app.needs_setup": {
      const unmet = list(d.unmet);
      return unmet.length
        ? `${appLabel(d.app)} needs setup: ${unmet.join(", ")}`
        : `${appLabel(d.app)} needs setup`;
    }
    case "app.ready":
      return `${appLabel(d.app)} is ready`;
    case "app.paused_cap":
      return `${appLabel(d.app)} is paused: monthly cap of ${n(num(d.cap))} reached`;
    case "app.tools_changed":
      return `${appLabel(d.app)}'s tools changed: ${n(num(d.toolCount))} tools (was ${n(num(d.previousToolCount))})`;
    case "cap.warning":
      return `${appLabel(d.app)} is at ${num(d.threshold) ?? CAP_WARNING_THRESHOLD}% of its monthly cap (${n(num(d.calls))} of ${n(num(d.cap))})`;
    case "cap.reached":
      return `${appLabel(d.app)} reached its monthly cap (${n(num(d.cap))})`;
    case "cap.raised": {
      // The workspace default names no app.
      const whose =
        str(d.source) === "default" && !obj(d.app).id
          ? "The default cap"
          : `${appLabel(d.app)}'s cap`;
      return num(d.cap) === null
        ? `${whose} was removed (was ${n(num(d.previousCap))})`
        : num(d.previousCap) === null
          ? `${whose} set to ${n(num(d.cap))}`
          : `${whose} raised from ${n(num(d.previousCap))} to ${n(num(d.cap))}`;
    }
    case "tool.blocked": {
      const client = str(obj(d.client).name) ?? userLabel(d.user);
      return `${client}'s call to ${str(d.tool) ?? "a tool"} was blocked: ${str(d.reason) ?? "refused"}`;
    }
    case "tool.error": {
      const client = str(obj(d.client).name) ?? userLabel(d.user);
      return `${str(d.tool) ?? "A tool"} failed for ${client}: ${str(d.outcome) ?? "error"}`;
    }
    case "connection.created": {
      const connection = obj(d.connection);
      const access =
        connection.access === "write" ? "read & write" : "read only";
      const scope =
        connection.appScope === "all" ? "all apps" : "selected apps";
      return `${actorLabel(actor)} connected ${str(connection.clientName) ?? "an AI app"} (${access}, ${scope})`;
    }
    case "connection.revoked": {
      const connection = obj(d.connection);
      return `${userLabel(d.user)}'s ${str(connection.clientName) ?? "AI app"} connection was revoked (${str(d.reason) ?? "revoked"})`;
    }
    case "token.created":
      return `${actorLabel(actor)} created the token ${str(d.name) ?? ""}`.trim();
    case "token.revoked":
      return `${actorLabel(actor)} revoked the token ${str(d.name) ?? ""}`.trim();
    case "access.changed":
      return `Cloudflare Access was turned ${str(d.access) ?? "off"}`;
    case "signin_provider.added":
      return `${str(d.label) ?? str(d.provider) ?? "A provider"} sign-in was added`;
    case "signin_provider.removed":
      return `${str(d.label) ?? str(d.provider) ?? "A provider"} sign-in was removed`;
    case "mcp_app.added":
      return `${appLabel(d.app)} was added as an MCP app`;
    case "mcp_app.removed":
      return `${appLabel(d.app)} was removed`;
    case "mcp_app.enabled":
      return `${appLabel(d.app)} is being served again`;
    case "mcp_app.disabled":
      return `${appLabel(d.app)} stopped being served`;
    case "provider.added":
      return `${str(obj(d.provider).name) ?? "A provider"} was registered`;
    case "provider.removed":
      return `${str(obj(d.provider).name) ?? "A provider"} was removed`;
    case "provider.updated":
      return `${str(obj(d.provider).name) ?? "A provider"}'s ${str(d.change) === "client" ? "OAuth client" : "spec"} was replaced`;
    case "provider.connected":
      return `${accountLabel(d.account, actor)} connected ${str(obj(d.provider).name) ?? "a provider"}`;
    case "provider.disconnected":
      return `${accountLabel(d.account, actor)}'s ${str(obj(d.provider).name) ?? "provider"} account was disconnected`;
    case "provider.connection_expired":
      return `${accountLabel(d.account, actor)}'s ${str(obj(d.provider).name) ?? "provider"} connection expired and needs reconnecting`;
    case "ping":
      return "Test event from Every App";
    default:
      if (isAppOwnEventType(type)) {
        const rest = type.slice(APP_EVENT_PREFIX.length);
        const dot = rest.indexOf(".");
        return `${rest.slice(0, dot)}: ${rest.slice(dot + 1)}`;
      }
      return eventTypeInfo(type)?.description ?? type;
  }
}

/** Where the email's one link points, by the event's group. */
export function adminPathFor(type: string): string {
  if (type.startsWith("cap.") || type === "app.paused_cap")
    return "/admin/usage";
  if (type.startsWith("member.")) return "/admin/users";
  if (type.startsWith("tool.")) return "/admin/activity";
  if (type.startsWith("token.")) return "/admin/tokens";
  if (type.startsWith("connection.")) return "/settings/connections";
  if (type.startsWith("provider.")) return "/admin/providers";
  if (type.startsWith("app.") || type.startsWith("mcp_app.")) {
    return "/admin/apps";
  }
  return "/admin/events";
}

interface EmailField {
  label: string;
  value: string;
}

/**
 * The data fields a person reads in the mail, by name where a name
 * exists: the app, the cap, the member, the tool, the unmet settings.
 * Ids alone are left out; an app's own event lists its top-level scalars.
 */
export function eventEmailFields(type: string, data: Data): EmailField[] {
  const d = obj(data);
  const fields: EmailField[] = [];
  const add = (label: string, value: unknown) => {
    const text =
      typeof value === "number"
        ? n(value)
        : typeof value === "string"
          ? value
          : null;
    if (text) fields.push({ label, value: text });
  };
  const member = obj(d.user);
  if (member.email || member.name) {
    add(
      "Member",
      str(member.name) && str(member.email)
        ? `${str(member.name)} (${str(member.email)})`
        : (str(member.email) ?? str(member.name)),
    );
  }
  const subject = obj(d.app);
  if (subject.name || subject.id)
    add("App", str(subject.name) ?? str(subject.id));
  if (type === "member.invited") {
    const invitation = obj(d.invitation);
    add("Invited", invitation.email);
    add("Role", invitation.role);
    add("Email sent", d.emailSent ? "yes" : "no");
  }
  add("Role", d.role);
  add("Previous role", d.previousRole);
  add("Reason", d.reason);
  add("Joined via", d.via);
  add("Version", d.version);
  add("Source", d.source);
  if (list(d.unmet).length) add("Needs", list(d.unmet).join(", "));
  add("Cap", d.cap);
  add("Previous cap", d.previousCap);
  add("Calls this month", d.calls);
  add("Month", d.month);
  add("Tool", d.tool);
  add("AI app", str(obj(d.client).name) ?? str(obj(d.connection).clientName));
  add("Risk", d.risk);
  add("Outcome", d.outcome);
  add("Tools now", d.toolCount);
  if (list(d.added).length) add("Added", list(d.added).join(", "));
  if (list(d.removed).length) add("Removed", list(d.removed).join(", "));
  if (type.startsWith("token.")) add("Token", d.name);
  add("Access", d.access);
  add("Message", d.message);
  if (isAppOwnEventType(type)) {
    for (const [key, value] of Object.entries(d)) {
      if (typeof value === "string" || typeof value === "number")
        add(key, value);
    }
  }
  return fields;
}
