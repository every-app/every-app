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
  | {
      kind: "agent";
      /** The credential's id. */
      id?: string;
      /** The connection's client name. */
      name?: string;
      /** The member the agent acts for. */
      email?: string | null;
    }
  | { kind: "app"; id: string }
  | { kind: "operator"; id: string }
  | { kind: "gateway" };

/**
 * What made a `binding` app active: `app.live`'s `trigger`. `deploy` is the
 * CLI's nudge after it binds an app (the activation queue, server.ts
 * `queue`); `scheduled` the per-minute cron.
 */
export type AppLiveTrigger = "request" | "list" | "scheduled" | "deploy";

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
  /** An API key the Gateway holds, an OAuth client it runs the flow for, or an OpenAI-compatible model provider. */
  kind?: "api_key" | "oauth" | "ai";
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
type CapKind = "calls" | "cost";
type McpAppKind = "builtin" | "remote";
type ToolClientKind = "pat" | "session" | "dev" | "oauth" | "access";

/** Tool names an app.tools_changed event lists, each way. */
const TOOL_NAMES_MAX = 50;
/** Members an access or group change lists, each way; the counts are exact. */
const USERS_MAX = 50;
/** Setting names an app.settings_changed event lists. */
const SETTINGS_MAX = 50;
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

/** A group as `data` carries it. */
interface EventGroup {
  id: string;
  name: string;
}

function group(subject: EventGroup): EventGroup {
  return { id: subject.id, name: subject.name };
}

/** A subscription as `data` carries it: never its secret, never a URL's query. */
interface EventSubscriptionSubject {
  id: string;
  name: string;
  sink: "webhook" | "email";
}

function subscription(
  subject: EventSubscriptionSubject,
): EventSubscriptionSubject {
  return { id: subject.id, name: subject.name, sink: subject.sink };
}

/** The first `max` members, each as `{ id, email, name }`. */
function users(members: readonly EventUser[], max = USERS_MAX): EventUser[] {
  return members.slice(0, max).map(user);
}

/** Drop undefined fields so the stored JSON has no "key": undefined holes. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

/**
 * `<type>:<org>:<app row>:<month>:<kind>:<cap>`, with the threshold for a
 * warning: the call cap and the dollar cap are announced each on its own.
 */
export function capKey(
  type: string,
  organizationId: string,
  appRowId: string,
  month: string,
  kind: CapKind,
  cap: number,
  threshold?: number,
): string {
  const base = `${type}:${organizationId}:${appRowId}:${month}:${kind}:${cap}`;
  return threshold === undefined ? base : `${base}:${threshold}`;
}

/** Micro-dollars as the events carry dollars: a number with cents. */
function dollars(micros: number): number {
  return Math.round(micros / 10_000) / 100;
}

/** One cap's standing, as cap-events.ts hands it over. */
export interface CapInput {
  organizationId: string;
  app: EventApp;
  kind: CapKind;
  /** Calls, or micro-dollars for `cost`. */
  cap: number;
  source: CapSource;
  /** The month's counted calls. */
  calls: number;
  /** The month's provider-reported cost, micro-dollars. */
  costMicros: number;
  /** "YYYY-MM" */
  month: string;
}

/**
 * What `data` says of a cap: `kind`, then for the call cap `cap` and
 * `calls` as before, for the dollar cap `costCap` and `cost` in dollars
 * (with the month's `calls` beside them).
 */
function capData(input: CapInput): Record<string, unknown> {
  return input.kind === "cost"
    ? {
        app: app(input.app),
        kind: "cost",
        costCap: dollars(input.cap),
        cost: dollars(input.costMicros),
        calls: input.calls,
        month: input.month,
      }
    : {
        app: app(input.app),
        kind: "calls",
        cap: input.cap,
        calls: input.calls,
        month: input.month,
      };
}

function capEventKey(type: string, input: CapInput, threshold?: number) {
  return capKey(
    type,
    input.organizationId,
    input.app.rowId,
    input.month,
    input.kind,
    input.cap,
    threshold,
  );
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

  memberInvitationCancelled(input: {
    invitation: { id: string; email: string; role: string };
  }): BuiltEvent {
    const { invitation } = input;
    return built("member.invitation_cancelled", {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
      },
    });
  },

  organizationRenamed(input: {
    name: string;
    previousName: string;
  }): BuiltEvent {
    return built("organization.renamed", {
      name: input.name,
      previousName: input.previousName,
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

  /**
   * The Gateway reached the app's Worker and made it `active`: `trigger`
   * says which request did it (one on the app's host, a list of the apps,
   * or the per-minute sweep behind Cloudflare Access).
   */
  appLive(input: {
    app: EventApp;
    version?: string | null;
    trigger: AppLiveTrigger;
  }): BuiltEvent {
    return built(
      "app.live",
      compact({
        app: app(input.app),
        version: input.version ?? undefined,
        trigger: input.trigger,
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
      { ...capData(input), source: input.source },
      {
        appRowId: input.app.rowId,
        dedupeKey: capEventKey("app.paused_cap", input),
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

  /** The name and the description after the change; `previousName` when the name changed. */
  appRenamed(input: {
    app: EventApp;
    previousName?: string | null;
    description?: string | null;
  }): BuiltEvent {
    return built(
      "app.renamed",
      compact({
        app: app(input.app),
        previousName:
          input.previousName && input.previousName !== input.app.name
            ? input.previousName
            : undefined,
        description: input.description ?? undefined,
      }),
      { appRowId: input.app.rowId },
    );
  },

  /**
   * Setting names only, never a value: what was set or unset, and where.
   * `app` is null for a Gateway setting set outside any app (a provider's
   * key from the Gateway's directory).
   */
  appSettingsChanged(input: {
    app: EventApp | null;
    settings: readonly string[];
    action: "set" | "unset";
    /** `gateway` for a Gateway setting the app reads; `app` for its own Worker's. */
    target: "gateway" | "app";
  }): BuiltEvent {
    return built(
      "app.settings_changed",
      {
        app: input.app ? app(input.app) : null,
        settings: [...new Set(input.settings)].slice(0, SETTINGS_MAX),
        action: input.action,
        target: input.target,
      },
      input.app ? { appRowId: input.app.rowId } : {},
    );
  },

  /**
   * Direct grants that came and went (the first 50 each way, the counts
   * exact), and `everyone` when "Available to everyone" was switched.
   */
  appAccessChanged(input: {
    app: EventApp;
    granted: readonly EventUser[];
    revoked: readonly EventUser[];
    grantedCount?: number;
    revokedCount?: number;
    everyone?: boolean;
  }): BuiltEvent {
    return built(
      "app.access_changed",
      compact({
        app: app(input.app),
        granted: users(input.granted),
        revoked: users(input.revoked),
        grantedCount: input.grantedCount ?? input.granted.length,
        revokedCount: input.revokedCount ?? input.revoked.length,
        everyone: input.everyone,
      }),
      { appRowId: input.app.rowId },
    );
  },

  /** The sender and inbound address names as stored now; never a mail. */
  appEmailChanged(input: {
    app: EventApp;
    senders: readonly string[];
    inbound: readonly string[];
  }): BuiltEvent {
    return built(
      "app.email_changed",
      {
        app: app(input.app),
        senders: [...input.senders],
        inbound: [...input.inbound],
      },
      { appRowId: input.app.rowId },
    );
  },

  capWarning(input: CapInput): BuiltEvent {
    return built(
      "cap.warning",
      {
        ...capData(input),
        threshold: CAP_WARNING_THRESHOLD,
        source: input.source,
      },
      {
        appRowId: input.app.rowId,
        dedupeKey: capEventKey("cap.warning", input, CAP_WARNING_THRESHOLD),
      },
    );
  },

  capReached(input: CapInput): BuiltEvent {
    return built(
      "cap.reached",
      { ...capData(input), source: input.source },
      {
        appRowId: input.app.rowId,
        dedupeKey: capEventKey("cap.reached", input),
      },
    );
  },

  capRaised(input: {
    /** The app whose own setting changed; null for the workspace default (`source: "default"`). */
    app: EventApp | null;
    /**
     * For an app, the call cap that binds it after and before the change
     * (its own, else the default; null = none), not the row's own column:
     * a cap set under the default is no raise, `unlimited` under a default
     * is a removal. For the default, the default itself.
     */
    cap: number | null;
    previousCap: number | null;
    /**
     * The dollar cap after and before, in dollars by the same rule; given
     * only when it changed (the event fires when either cap ended higher
     * or gone).
     */
    costCap?: number | null;
    previousCostCap?: number | null;
    source: CapSource;
  }): BuiltEvent {
    return built(
      "cap.raised",
      compact({
        app: input.app ? app(input.app) : null,
        cap: input.cap,
        previousCap: input.previousCap,
        costCap: input.costCap,
        previousCostCap: input.previousCostCap,
        source: input.source,
      }),
      input.app ? { appRowId: input.app.rowId } : {},
    );
  },

  /**
   * The counterpart of cap.raised: a cap set under the default, lowered,
   * or an app's own row changed while the binding caps stayed. Same
   * fields; `cap` and `previousCap` are the binding call caps after and
   * before, `costCap` and `previousCostCap` the dollar caps when changed.
   */
  capChanged(input: {
    app: EventApp | null;
    cap: number | null;
    previousCap: number | null;
    costCap?: number | null;
    previousCostCap?: number | null;
    source: CapSource;
  }): BuiltEvent {
    return built(
      "cap.changed",
      compact({
        app: input.app ? app(input.app) : null,
        cap: input.cap,
        previousCap: input.previousCap,
        costCap: input.costCap,
        previousCostCap: input.previousCostCap,
        source: input.source,
      }),
      input.app ? { appRowId: input.app.rowId } : {},
    );
  },

  groupCreated(input: {
    group: EventGroup;
    description?: string | null;
  }): BuiltEvent {
    return built(
      "group.created",
      compact({
        group: group(input.group),
        description: input.description ?? undefined,
      }),
    );
  },

  groupUpdated(input: {
    group: EventGroup;
    previousName?: string | null;
    description?: string | null;
  }): BuiltEvent {
    return built(
      "group.updated",
      compact({
        group: group(input.group),
        previousName:
          input.previousName && input.previousName !== input.group.name
            ? input.previousName
            : undefined,
        description: input.description ?? undefined,
      }),
    );
  },

  groupRemoved(input: { group: EventGroup }): BuiltEvent {
    return built("group.removed", { group: group(input.group) });
  },

  groupMembersChanged(input: {
    group: EventGroup;
    added: readonly EventUser[];
    removed: readonly EventUser[];
    addedCount?: number;
    removedCount?: number;
  }): BuiltEvent {
    return built("group.members_changed", {
      group: group(input.group),
      added: users(input.added),
      removed: users(input.removed),
      addedCount: input.addedCount ?? input.added.length,
      removedCount: input.removedCount ?? input.removed.length,
    });
  },

  groupAppsChanged(input: {
    group: EventGroup;
    granted: readonly EventApp[];
    revoked: readonly EventApp[];
  }): BuiltEvent {
    return built("group.apps_changed", {
      group: group(input.group),
      granted: input.granted.slice(0, USERS_MAX).map(app),
      revoked: input.revoked.slice(0, USERS_MAX).map(app),
      grantedCount: input.granted.length,
      revokedCount: input.revoked.length,
    });
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

  /**
   * `kind` "mcp" (an AI app at /mcp) or "native" (a native app signed in
   * to one app host, docs/design/native-sign-in.md); `app` is a native
   * connection's one app, absent for an MCP connection.
   */
  connectionCreated(input: {
    connection: {
      id: string;
      clientName: string;
      clientDomain?: string | null;
      access: "read" | "write";
      appScope: "all" | "selected";
      kind?: "mcp" | "native";
      app?: { rowId: string; id: string; name: string } | null;
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
        kind: connection.kind ?? "mcp",
        app: connection.app ? app(connection.app) : undefined,
      }),
      user: user(input.user),
    });
  },

  connectionRevoked(input: {
    connection: {
      id: string;
      clientName: string;
      kind?: "mcp" | "native";
      app?: { rowId: string; id: string; name: string } | null;
    };
    user: EventUser;
    reason: string;
  }): BuiltEvent {
    return built("connection.revoked", {
      connection: compact({
        id: input.connection.id,
        clientName: input.connection.clientName,
        kind: input.connection.kind ?? "mcp",
        app: input.connection.app ? app(input.connection.app) : undefined,
      }),
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

  /** Which fields changed, by name; the risk default after, when it did. */
  mcpAppUpdated(input: {
    app: EventApp;
    kind: McpAppKind;
    changed: readonly ("risk" | "name" | "description" | "tools")[];
    risk?: string;
  }): BuiltEvent {
    return built(
      "mcp_app.updated",
      compact({
        app: app(input.app),
        kind: input.kind,
        changed: [...input.changed],
        risk: input.risk,
      }),
      { appRowId: input.app.rowId },
    );
  },

  /** One tool's override after the change: its risk, whether it is served; `cleared` when the override went. */
  mcpAppToolChanged(input: {
    app: EventApp;
    kind: McpAppKind;
    tool: string;
    risk?: string;
    enabled?: boolean;
    cleared?: boolean;
  }): BuiltEvent {
    return built(
      "mcp_app.tool_changed",
      compact({
        app: app(input.app),
        kind: input.kind,
        tool: input.tool,
        risk: input.risk,
        enabled: input.enabled,
        cleared: input.cleared,
      }),
      { appRowId: input.app.rowId },
    );
  },

  providerAdded(input: { provider: EventProvider }): BuiltEvent {
    return built("provider.added", { provider: provider(input.provider) });
  },

  providerRemoved(input: { provider: EventProvider }): BuiltEvent {
    return built("provider.removed", { provider: provider(input.provider) });
  },

  /** A provider's spec was replaced, its OAuth client uploaded again, or a scope set added to or removed from a built-in client. */
  providerUpdated(input: {
    provider: EventProvider;
    /** What changed: the spec, the client (never its value), or the scope sets (`scopeSet` names which). */
    change: "spec" | "client" | "scope_sets";
    scopeSet?: { name: string; action: "added" | "removed" };
  }): BuiltEvent {
    return built("provider.updated", {
      provider: provider(input.provider),
      change: input.change,
      ...(input.scopeSet ? { scopeSet: { ...input.scopeSet } } : {}),
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

  /** The subscription, its patterns and, for a webhook, the target's host; never the secret or the URL. */
  subscriptionCreated(input: {
    subscription: EventSubscriptionSubject;
    events: readonly string[];
    host?: string | null;
    recipients?: string | null;
  }): BuiltEvent {
    return built(
      "subscription.created",
      compact({
        subscription: subscription(input.subscription),
        events: [...input.events],
        host: input.host ?? undefined,
        recipients: input.recipients ?? undefined,
      }),
    );
  },

  subscriptionUpdated(input: {
    subscription: EventSubscriptionSubject;
    changed: readonly ("enabled" | "events" | "name" | "description")[];
    enabled?: boolean;
    events?: readonly string[];
  }): BuiltEvent {
    return built(
      "subscription.updated",
      compact({
        subscription: subscription(input.subscription),
        changed: [...input.changed],
        enabled: input.enabled,
        events: input.events ? [...input.events] : undefined,
      }),
    );
  },

  /** `disabled` when a built-in one was turned off instead of removed. */
  subscriptionRemoved(input: {
    subscription: EventSubscriptionSubject;
    disabled: boolean;
  }): BuiltEvent {
    return built("subscription.removed", {
      subscription: subscription(input.subscription),
      disabled: input.disabled,
    });
  },

  subscriptionRedelivered(input: {
    subscription: EventSubscriptionSubject;
    delivery: { id: string; eventId: string; eventType: string };
  }): BuiltEvent {
    return built("subscription.redelivered", {
      subscription: subscription(input.subscription),
      delivery: {
        id: input.delivery.id,
        eventId: input.delivery.eventId,
        eventType: input.delivery.eventType,
      },
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

  /**
   * The default model provider changed (`everyapp ai default`, Manage
   * workspace → Usage → AI default): what it is now and what it was, each
   * a provider id with the model when one was chosen, or null when the
   * shipped order decides.
   */
  aiDefaultChanged(input: {
    aiDefault: { provider: string; model: string | null } | null;
    previous: { provider: string; model: string | null } | null;
  }): BuiltEvent {
    return built("ai.default_changed", {
      aiDefault: input.aiDefault,
      previous: input.previous,
    });
  },

  /**
   * One provider's default models changed (`everyapp ai model`, the
   * `everyapp_ai_model` tool): the chat and
   * embeddings model settings now and before, null where the catalog's
   * seed serves.
   */
  aiModelChanged(input: {
    provider: string;
    models: { chat: string | null; embeddings: string | null };
    previous: { chat: string | null; embeddings: string | null };
  }): BuiltEvent {
    return built("ai.model_changed", {
      provider: input.provider,
      models: input.models,
      previous: input.previous,
    });
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
        "Test event from EveryApp. Your subscription receives events.",
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

function groupLabel(value: unknown): string {
  const subject = obj(value);
  return str(subject.name) ?? str(subject.id) ?? "a group";
}

function subscriptionLabel(value: unknown): string {
  const subject = obj(value);
  return str(subject.name) ?? str(subject.id) ?? "a subscription";
}

const n = (value: number | null): string =>
  value === null ? "?" : value.toLocaleString("en-US");

/** Dollars as a person reads them: "$1,250.00". */
const usd = (value: number | null): string =>
  value === null
    ? "?"
    : `$${value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

/** A cap event's dollar cap was the one: `kind: "cost"`. */
const isCost = (d: Data): boolean => str(d.kind) === "cost";

/**
 * What `cap.raised` says changed: the call cap, then the dollar cap when
 * it is in the event (each "set to", "raised from … to" or "removed").
 */
function raisedLine(whose: string, d: Data): string {
  const change = (
    now: number | null,
    was: number | null,
    say: (value: number | null) => string,
  ): string | null => {
    if (now === was) return null;
    if (now === null) return `was removed (was ${say(was)})`;
    if (was === null) return `set to ${say(now)}`;
    return now > was
      ? `raised from ${say(was)} to ${say(now)}`
      : `lowered from ${say(was)} to ${say(now)}`;
  };
  const calls = change(num(d.cap), num(d.previousCap), n);
  const cost =
    "costCap" in d ? change(num(d.costCap), num(d.previousCostCap), usd) : null;
  if (calls && cost) return `${whose} ${calls}; its dollar cap ${cost}`;
  if (cost) return `${whose.replace(/cap$/, "dollar cap")} ${cost}`;
  return `${whose} ${calls ?? `is ${n(num(d.cap))}`}`;
}

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
    case "member.invitation_cancelled":
      return `${actorLabel(actor)} cancelled the invitation for ${str(obj(d.invitation).email) ?? "someone"}`;
    case "organization.renamed":
      return `${actorLabel(actor)} renamed the workspace to ${str(d.name) ?? "a new name"}`;
    case "app.installed":
      return `${appLabel(d.app)} was installed`;
    case "app.updated":
      return str(d.version)
        ? `${appLabel(d.app)} was redeployed (version ${str(d.version)})`
        : `${appLabel(d.app)} was redeployed`;
    case "app.live":
      return `${appLabel(d.app)} is live`;
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
      return isCost(d)
        ? `${appLabel(d.app)} is paused: monthly dollar cap of ${usd(num(d.costCap))} reached`
        : `${appLabel(d.app)} is paused: monthly cap of ${n(num(d.cap))} reached`;
    case "app.tools_changed":
      return `${appLabel(d.app)}'s tools changed: ${n(num(d.toolCount))} tools (was ${n(num(d.previousToolCount))})`;
    case "app.renamed":
      return str(d.previousName)
        ? `${str(d.previousName)} was renamed to ${appLabel(d.app)}`
        : `${appLabel(d.app)}'s description changed`;
    case "app.settings_changed": {
      const settings = list(d.settings);
      const whose = obj(d.app).id ? `${appLabel(d.app)}'s` : "The Gateway's";
      return `${whose} settings ${str(d.action) ?? "changed"}: ${settings.join(", ") || "none"}`;
    }
    case "app.access_changed": {
      const parts: string[] = [];
      if (num(d.grantedCount)) parts.push(`${n(num(d.grantedCount))} granted`);
      if (num(d.revokedCount)) parts.push(`${n(num(d.revokedCount))} revoked`);
      if (d.everyone === true) parts.push("available to everyone");
      if (d.everyone === false) parts.push("no longer for everyone");
      return `${appLabel(d.app)}'s access changed${parts.length ? `: ${parts.join(", ")}` : ""}`;
    }
    case "app.email_changed": {
      const senders = list(d.senders);
      const inbound = list(d.inbound);
      return `${appLabel(d.app)}'s email changed: ${senders.length} sender${senders.length === 1 ? "" : "s"}, ${inbound.length} inbound`;
    }
    case "cap.warning": {
      const share = `${num(d.threshold) ?? CAP_WARNING_THRESHOLD}%`;
      return isCost(d)
        ? `${appLabel(d.app)} is at ${share} of its monthly dollar cap (${usd(num(d.cost))} of ${usd(num(d.costCap))})`
        : `${appLabel(d.app)} is at ${share} of its monthly cap (${n(num(d.calls))} of ${n(num(d.cap))})`;
    }
    case "cap.reached":
      return isCost(d)
        ? `${appLabel(d.app)} reached its monthly dollar cap (${usd(num(d.costCap))})`
        : `${appLabel(d.app)} reached its monthly cap (${n(num(d.cap))})`;
    case "cap.raised": {
      // The workspace default names no app.
      const whose =
        str(d.source) === "default" && !obj(d.app).id
          ? "The default cap"
          : `${appLabel(d.app)}'s cap`;
      return raisedLine(whose, d);
    }
    case "cap.changed": {
      // cap.raised's counterpart, read the same way (lowered, set, removed).
      const whose =
        str(d.source) === "default" && !obj(d.app).id
          ? "The default cap"
          : `${appLabel(d.app)}'s cap`;
      return raisedLine(whose, d);
    }
    case "group.created":
      return `${actorLabel(actor)} created the group ${groupLabel(d.group)}`;
    case "group.updated":
      return str(d.previousName)
        ? `The group ${str(d.previousName)} was renamed to ${groupLabel(d.group)}`
        : `The group ${groupLabel(d.group)} was changed`;
    case "group.removed":
      return `The group ${groupLabel(d.group)} was removed`;
    case "group.members_changed":
      return `The group ${groupLabel(d.group)}'s members changed: ${n(num(d.addedCount))} added, ${n(num(d.removedCount))} removed`;
    case "group.apps_changed":
      return `The group ${groupLabel(d.group)}'s apps changed: ${n(num(d.grantedCount))} granted, ${n(num(d.revokedCount))} revoked`;
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
      if (connection.kind === "native") {
        const app = obj(connection.app);
        return `${actorLabel(actor)} signed in to ${str(app.name) ?? "an app"} from ${str(connection.clientName) ?? "a native app"}`;
      }
      const access =
        connection.access === "write" ? "read & write" : "read only";
      const scope =
        connection.appScope === "all" ? "all apps" : "selected apps";
      return `${actorLabel(actor)} connected ${str(connection.clientName) ?? "an AI app"} (${access}, ${scope})`;
    }
    case "connection.revoked": {
      const connection = obj(d.connection);
      if (connection.kind === "native") {
        const app = obj(connection.app);
        return `${userLabel(d.user)}'s ${str(connection.clientName) ?? "native app"} sign-in to ${str(app.name) ?? "an app"} was revoked (${str(d.reason) ?? "revoked"})`;
      }
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
    case "mcp_app.updated":
      return `${appLabel(d.app)} was changed: ${list(d.changed).join(", ") || "nothing"}`;
    case "mcp_app.tool_changed":
      return d.cleared === true
        ? `${appLabel(d.app)}'s tool ${str(d.tool) ?? ""} override was cleared`.trim()
        : `${appLabel(d.app)}'s tool ${str(d.tool) ?? ""} was changed${d.enabled === false ? " (off)" : d.enabled === true ? " (on)" : ""}${str(d.risk) ? ` (risk ${str(d.risk)})` : ""}`;
    case "provider.added":
      return `${str(obj(d.provider).name) ?? "A provider"} was registered`;
    case "provider.removed":
      return `${str(obj(d.provider).name) ?? "A provider"} was removed`;
    case "subscription.created":
      return `${actorLabel(actor)} added the subscription ${subscriptionLabel(d.subscription)}`;
    case "subscription.updated": {
      const changed = list(d.changed);
      if (changed.length === 1 && changed[0] === "enabled") {
        return `The subscription ${subscriptionLabel(d.subscription)} was ${d.enabled === false ? "paused" : "resumed"}`;
      }
      return `The subscription ${subscriptionLabel(d.subscription)} was changed: ${changed.join(", ") || "nothing"}`;
    }
    case "subscription.removed":
      return d.disabled === true
        ? `The subscription ${subscriptionLabel(d.subscription)} was turned off`
        : `The subscription ${subscriptionLabel(d.subscription)} was removed`;
    case "subscription.redelivered":
      return `${actorLabel(actor)} redelivered ${str(obj(d.delivery).eventType) ?? "an event"} to ${subscriptionLabel(d.subscription)}`;
    case "provider.updated":
      return `${str(obj(d.provider).name) ?? "A provider"}'s ${str(d.change) === "client" ? "OAuth client" : "spec"} was replaced`;
    case "provider.connected":
      return `${accountLabel(d.account, actor)} connected ${str(obj(d.provider).name) ?? "a provider"}`;
    case "provider.disconnected":
      return `${accountLabel(d.account, actor)}'s ${str(obj(d.provider).name) ?? "provider"} account was disconnected`;
    case "provider.connection_expired":
      return `${accountLabel(d.account, actor)}'s ${str(obj(d.provider).name) ?? "provider"} connection expired and needs reconnecting`;
    case "ai.default_changed": {
      const now = d.aiDefault === null ? null : obj(d.aiDefault);
      const was = d.previous === null ? null : obj(d.previous);
      const name = (choice: Data | null): string =>
        choice === null
          ? "the shipped order"
          : `${str(choice.provider) ?? "?"}${str(choice.model) ? ` (${str(choice.model)})` : ""}`;
      return `The default model provider is now ${name(now)}${was === null && now === null ? "" : ` (was ${name(was)})`}`;
    }
    case "ai.model_changed": {
      const now = obj(d.models);
      const model = (value: unknown) => str(value) ?? "the seed";
      return `${str(d.provider) ?? "A provider"}'s default models are now chat ${model(now.chat)}, embeddings ${model(now.embeddings)}`;
    }
    case "ping":
      return "Test event from EveryApp";
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
  if (type.startsWith("group.")) return "/admin/groups";
  if (type.startsWith("subscription.")) return "/admin/events";
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
  const grp = obj(d.group);
  if (grp.name || grp.id) add("Group", str(grp.name) ?? str(grp.id));
  const sub = obj(d.subscription);
  if (type.startsWith("subscription.") && (sub.name || sub.id))
    add("Subscription", str(sub.name) ?? str(sub.id));
  if (type === "member.invited") {
    const invitation = obj(d.invitation);
    add("Invited", invitation.email);
    add("Role", invitation.role);
    add("Email sent", d.emailSent ? "yes" : "no");
  }
  add("Role", d.role);
  add("Previous role", d.previousRole);
  add("Previous name", d.previousName);
  if (type === "organization.renamed") add("Name", d.name);
  if (list(d.settings).length) add("Settings", list(d.settings).join(", "));
  add("Action", d.action);
  if (list(d.changed).length) add("Changed", list(d.changed).join(", "));
  add("Granted", d.grantedCount);
  add("Revoked", d.revokedCount);
  if (list(d.senders).length) add("Senders", list(d.senders).join(", "));
  if (list(d.inbound).length) add("Inbound", list(d.inbound).join(", "));
  add("Reason", d.reason);
  add("Joined via", d.via);
  add("Version", d.version);
  add("Source", d.source);
  if (list(d.unmet).length) add("Needs", list(d.unmet).join(", "));
  add("Cap", d.cap);
  add("Previous cap", d.previousCap);
  const dollarsField = (label: string, value: unknown) => {
    if (num(value) !== null) add(label, usd(num(value)));
  };
  dollarsField("Dollar cap", d.costCap);
  dollarsField("Previous dollar cap", d.previousCostCap);
  dollarsField("Cost this month", d.cost);
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
