/**
 * The handlers behind the workspace tools on the gateway's own /mcp
 * (`everyapp_workspace_*`, `everyapp_my_*`, `everyapp_revoke_*`): every
 * admin action of the UI, run for a resolved caller through the same
 * services the server functions call (serverFunctions/*.ts), on an
 * OrgContext built from the caller's live role.
 *
 * The ToolBus has already listed each tool to the caller's role and access
 * and checked the arguments against the tool's own schema
 * (packages/toolbus/src/workspace.ts); the services' finer rules (only an
 * owner changes an admin, never the last owner, never yourself, a shared
 * app is nobody's to grant) apply on top and come back as tool errors,
 * `CODE: message` for a PublicError. Any other error is logged here and
 * thrown, and the ToolBus answers a generic failure: never a stack.
 *
 * Identifiers are what a person would type: a user by email or id, an app
 * by manifest id or row id, a group by name or `grp_` id, an invitation by
 * id or email, a token by id or name, an event subscription by `sub_` id or
 * name. No handler returns a credential that opens the Gateway: no
 * invitation link, no reset link, no token value
 * (docs/design/2026-10-agent-parity.md, decision 2). The events tools
 * (docs/design/2026-10-events-out.md, section 9) run through the same
 * EventSubscriptionService as Admin → Events; the one secret any handler
 * returns is the webhook signing secret `workspace_events_add` generates,
 * once, in that answer: it signs deliveries to the URL the caller chose and
 * opens nothing here, and no list shows it again.
 *
 * The MCP app tools' handlers (`everyapp_mcp_*`) are mcp-app-tools.ts's,
 * merged into the map below.
 */
import { logEvent } from "@every-app/perimeter";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import type { ToolCallResultV1 } from "@every-app/sdk/internal";
import {
  ACTIVITY_TIME_MAX_MS,
  BUILTIN_APP_ID,
  type JsonObject,
  type McpPrincipal,
} from "@every-app/toolbus";
import { isEmailConfigured } from "@/server/email/sendEmail";
import { PublicError } from "@/server/errors";
import { listAudit } from "@/server/events/audit";
import type { EventActor } from "@/server/events/catalogue";
import { DELIVERY_ID_PATTERN } from "@/server/events/ids";
import { EventSubscriptionService } from "@/server/events/subscriptions";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import type { OrgContext } from "@/server/organization/orgContext";
import { AppRepository } from "@/server/repositories/AppRepository";
import { EventDeliveryRepository } from "@/server/repositories/EventDeliveryRepository";
import { GroupRepository } from "@/server/repositories/GroupRepository";
import { McpToolCallRepository } from "@/server/repositories/McpToolCallRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import { AdminService } from "@/server/services/AdminService";
import { AppAccessService } from "@/server/services/AppAccessService";
import { AppCapService } from "@/server/services/AppCapService";
import { AppService } from "@/server/services/AppService";
import { GroupService } from "@/server/services/GroupService";
import { InvitationService } from "@/server/services/InvitationService";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { MembershipService } from "@/server/services/MembershipService";
import { OrganizationService } from "@/server/services/OrganizationService";
import { UserPatService } from "@/server/services/UserPatService";
import { MCP_APP_HANDLERS } from "./mcp-app-tools";
import { AI_HANDLERS } from "./ai-tools";
import { PROVIDER_CONNECTION_HANDLERS } from "./provider-connection-tools";
import { PROVIDER_HANDLERS } from "./provider-tools";
import { SIGNIN_HANDLERS } from "./signin-tools";

type Handler = (
  ctx: OrgContext,
  args: JsonObject,
  principal: McpPrincipal,
) => Promise<JsonObject>;

/** `YYYY-MM`, as the usage summary takes it. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireText(args: JsonObject, field: string): string {
  const value = text(args[field]);
  if (!value) throw new PublicError("INVALID_INPUT", `${field} is required`);
  return value;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

/**
 * The two caps of a cap tool as the service takes them: a number, null
 * for none, or left out (absent, or not a number or null) to keep it.
 */
function capArgs(args: JsonObject): {
  cap?: number | null;
  costUsd?: number | null;
} {
  const kept = (value: unknown) =>
    typeof value === "number" || value === null ? value : undefined;
  const cap = kept(args["cap"]);
  const costUsd = kept(args["costUsd"]);
  return {
    ...(cap !== undefined && { cap }),
    ...(costUsd !== undefined && { costUsd }),
  };
}

/** `confirm: true`, checked here too: the action cannot be undone. */
function requireConfirm(args: JsonObject): void {
  if (args["confirm"] !== true) {
    throw new PublicError(
      "INVALID_INPUT",
      "confirm: true is required; this cannot be undone",
    );
  }
}

/**
 * A tool that sets a list takes the full list (`key`), or `add` and/or
 * `remove` against the current one; both forms at once are refused, and
 * so is neither.
 */
function listChange(
  args: JsonObject,
  key: "users" | "apps",
): { full: string[] } | { add: string[]; remove: string[] } {
  const full = strings(args[key]);
  const add = strings(args["add"]);
  const remove = strings(args["remove"]);
  if (full && (add || remove)) {
    throw new PublicError(
      "INVALID_INPUT",
      `Give ${key} (the full list) or add/remove, not both`,
    );
  }
  if (full) return { full };
  if (!add && !remove) {
    throw new PublicError(
      "INVALID_INPUT",
      `Give ${key} (the full list), or add and/or remove`,
    );
  }
  return { add: add ?? [], remove: remove ?? [] };
}

/** The list after a change: the full one, or the current one changed. */
function applyChange(
  current: string[],
  change: ReturnType<typeof listChange>,
): string[] {
  if ("full" in change) return [...new Set(change.full)];
  const next = new Set(current);
  for (const id of change.add) next.add(id);
  for (const id of change.remove) next.delete(id);
  return [...next];
}

/** The organization's members, as the identifier resolvers read them. */
async function membersOf(ctx: OrgContext) {
  return OrganizationMembersRepository.listMembersForOrganization(ctx.orgId);
}

type Member = Awaited<ReturnType<typeof membersOf>>[number];

function findMember(members: Member[], ref: string): Member {
  const wanted = ref.trim();
  const member =
    members.find((candidate) => candidate.id === wanted) ??
    members.find(
      (candidate) =>
        candidate.email.trim().toLowerCase() === wanted.toLowerCase(),
    );
  if (!member) {
    throw new PublicError(
      "USER_NOT_FOUND",
      `No member "${wanted}" in this organization`,
    );
  }
  return member;
}

/** A member by email or user id. */
async function resolveUser(ctx: OrgContext, ref: string): Promise<Member> {
  return findMember(await membersOf(ctx), ref);
}

/** Several members by email or user id, read once. */
async function resolveUsers(
  ctx: OrgContext,
  refs: string[],
): Promise<string[]> {
  const members = await membersOf(ctx);
  return [...new Set(refs.map((ref) => findMember(members, ref).id))];
}

/**
 * An app by manifest id or row id: the organization's own, and with
 * `callable` also a shared app the organization calls (what a cap or the
 * activity filter may name).
 */
async function resolveApp(
  ctx: OrgContext,
  ref: string,
  options: { callable?: boolean } = {},
) {
  const wanted = ref.trim();
  const byId = options.callable
    ? await AppRepository.findCallableById(wanted, ctx.orgId)
    : await AppRepository.findById(wanted, ctx.orgId);
  if (byId) return byId;
  const bySlug = await AppRepository.findByAppSlug(wanted, ctx.orgId);
  if (bySlug && bySlug.status !== DELETED_APP_STATUS) return bySlug;
  if (options.callable) {
    const shared = (await AppRepository.findAllShared(ctx.orgId)).find(
      (app) => app.appSlug === wanted,
    );
    if (shared) return shared;
  }
  throw new PublicError("APP_NOT_FOUND", `No app "${wanted}" here`);
}

/** Several of the organization's own apps, by manifest id or row id. */
async function resolveApps(ctx: OrgContext, refs: string[]): Promise<string[]> {
  const ids = await Promise.all(
    refs.map(async (ref) => (await resolveApp(ctx, ref)).id),
  );
  return [...new Set(ids)];
}

/**
 * A group by `grp_` id or name: the id first, then the name, so a group
 * named like an id (`grp_sales`, which the name rule allows) is still
 * reached by its name, as a member is by email after the id.
 */
async function resolveGroup(ctx: OrgContext, ref: string) {
  const wanted = ref.trim();
  const group =
    (await GroupRepository.findById(wanted, ctx.orgId)) ??
    (await GroupRepository.findByName(ctx.orgId, wanted));
  if (!group) {
    throw new PublicError("GROUP_NOT_FOUND", `No group "${wanted}" here`);
  }
  return { id: group.id, name: group.name };
}

/** The listed shape of an app row: never the manifest or its secret names. */
function listedApp(app: {
  id: string;
  appSlug: string;
  name: string;
  description: string | null;
  hostname: string | null;
  status: string;
  scope: string;
  tier: string;
  isDefault: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: app.id,
    appId: app.appSlug,
    name: app.name,
    description: app.description,
    hostname: app.hostname,
    status: app.status,
    scope: app.scope,
    tier: app.tier,
    everyone: app.isDefault === true,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * The activity page's cursor as the schema bounds it, read again here so
 * the bound is this code's own: an integer time inside the Date range
 * (past it the query would bind NaN) and the row's id.
 */
function activityCursor(
  value: unknown,
): { createdAt: number; id: string } | undefined {
  if (value === undefined) return undefined;
  const cursor =
    value && typeof value === "object"
      ? (value as { createdAt?: unknown; id?: unknown })
      : {};
  const { createdAt, id } = cursor;
  if (
    typeof createdAt !== "number" ||
    !Number.isInteger(createdAt) ||
    createdAt < 0 ||
    createdAt > ACTIVITY_TIME_MAX_MS ||
    typeof id !== "string" ||
    !id
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      "before must be the previous answer's nextBefore",
    );
  }
  return { createdAt, id };
}

/** The audit log's cursor, bounded like the activity one: `{ time, id }`. */
function auditCursor(value: unknown): { time: number; id: string } | undefined {
  if (value === undefined) return undefined;
  const cursor =
    value && typeof value === "object"
      ? (value as { time?: unknown; id?: unknown })
      : {};
  const { time, id } = cursor;
  if (
    typeof time !== "number" ||
    !Number.isInteger(time) ||
    time < 0 ||
    time > ACTIVITY_TIME_MAX_MS ||
    typeof id !== "string" ||
    !id
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      "before must be the previous answer's nextBefore",
    );
  }
  return { time, id };
}

/**
 * Which rows the activity tool's `app` names: an app the organization
 * calls (by manifest id or row id), a removed one by its manifest id (its
 * rows outlive it, and the UI's filter offers it too), the gateway's own
 * tools as `everyapp` (rows on no app row), or a row id taken as given.
 * The rows are the organization's own either way.
 */
async function activityAppFilter(
  ctx: OrgContext,
  ref: string,
): Promise<{ appRowId?: string; appSlug?: string }> {
  const wanted = ref.trim();
  if (wanted === BUILTIN_APP_ID) return { appSlug: wanted };
  const app = await resolveApp(ctx, wanted, { callable: true }).catch(
    () => null,
  );
  if (app) return { appRowId: app.id };
  const removed = await AppRepository.findByAppSlug(wanted, ctx.orgId);
  return { appRowId: removed?.id ?? wanted };
}

type EventSubscription = Awaited<
  ReturnType<typeof EventSubscriptionService.list>
>["subscriptions"][number];
type EventDelivery = NonNullable<
  Awaited<ReturnType<typeof EventSubscriptionService.test>>["delivery"]
>;

/** The rows a delivery page holds when the call names no limit. */
const EVENT_DELIVERIES_LIMIT_DEFAULT = 20;

/** The organization's event subscriptions, as the resolver reads them. */
async function subscriptionsOf(ctx: OrgContext): Promise<EventSubscription[]> {
  return (await EventSubscriptionService.list(ctx)).subscriptions;
}

/**
 * An event subscription by `sub_` id or by name: the id first, then the
 * name as written, then the name letter case aside. Names are not unique,
 * so a name several subscriptions share is refused, as a token's is.
 */
function findSubscription(
  subscriptions: EventSubscription[],
  ref: string,
): EventSubscription {
  const wanted = ref.trim();
  const byId = subscriptions.find((candidate) => candidate.id === wanted);
  if (byId) return byId;
  const name = wanted.replace(/\s+/g, " ");
  const exact = subscriptions.filter((candidate) => candidate.name === name);
  const named =
    exact.length > 0
      ? exact
      : subscriptions.filter(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        );
  if (named.length > 1) {
    throw new PublicError(
      "INVALID_INPUT",
      `${named.length} subscriptions are named "${name}"; give the id`,
    );
  }
  const [found] = named;
  if (!found) {
    throw new PublicError(
      "EVENT_SUBSCRIPTION_NOT_FOUND",
      `No event subscription "${wanted}" here`,
    );
  }
  return found;
}

/**
 * Where a webhook delivers, as the tools show it: the host (with a port
 * that isn't the default) and the path, never a user name, password or
 * query, since a query often carries the receiver's own token. The CLI's
 * `events list` shows the same.
 */
function shownTarget(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const scheme = parsed.protocol === "http:" ? "http://" : "";
    return `${scheme}${parsed.host}${path}`;
  } catch {
    return "(unreadable URL)";
  }
}

/** A subscription as the events tools answer it: never its secret, never a URL's query. */
function listedSubscription(subscription: EventSubscription) {
  const email = subscription.sink === "email";
  let target: string;
  if (email) {
    target =
      subscription.recipients === "owners"
        ? "email to the owners"
        : "email to the owners and admins";
  } else {
    target = subscription.url ? shownTarget(subscription.url) : "(no URL)";
  }
  return {
    id: subscription.id,
    name: subscription.name,
    sink: subscription.sink,
    target,
    ...(email ? { recipients: subscription.recipients } : {}),
    events: subscription.events,
    enabled: subscription.enabled,
    builtin: subscription.builtin,
    description: subscription.description,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    lastDeliveryAt: subscription.lastDeliveryAt,
    lastDeliveryStatus: subscription.lastDeliveryStatus,
    consecutiveFailures: subscription.consecutiveFailures,
  };
}

/**
 * Where a delivery stands: delivered; dead (out of attempts, or refused
 * for good); failed (its last attempt failed and the Gateway retries it);
 * or pending (not attempted yet).
 */
function deliveryState(
  delivery: EventDelivery,
): "pending" | "delivered" | "failed" | "dead" {
  if (delivery.status !== "pending") return delivery.status;
  return delivery.attempts > 0 && delivery.lastError !== null
    ? "failed"
    : "pending";
}

/**
 * A delivery as the events tools answer it: the event by id, type and
 * summary (never its data, never the request body), the subscription by
 * id and name, and the last attempt's answer.
 */
function listedDelivery(
  delivery: EventDelivery,
  subscription: EventSubscription | undefined,
) {
  return {
    id: delivery.id,
    event: delivery.event
      ? {
          id: delivery.event.id,
          type: delivery.event.type,
          summary: delivery.event.summary,
          time: delivery.event.time,
        }
      : null,
    subscription: {
      id: delivery.subscriptionId,
      name: subscription?.name ?? null,
    },
    state: deliveryState(delivery),
    attempts: delivery.attempts,
    // The email sink stores how many it mailed where a webhook's HTTP
    // status goes.
    ...(subscription?.sink === "email"
      ? { mailed: delivery.lastStatusCode }
      : { statusCode: delivery.lastStatusCode }),
    error: delivery.lastError,
    nextAttemptAt: delivery.nextAttemptAt,
    lastAttemptAt: delivery.lastAttemptAt,
    deliveredAt: delivery.deliveredAt,
    redeliveredAt: delivery.redeliveredAt,
    createdAt: delivery.createdAt,
  };
}

/**
 * The delivery page's cursor as the previous answer's `nextBefore` gives
 * it, `<created_at ms>:<dlv_ id>`, read here so a cursor that isn't one is
 * refused rather than read as the first page: a time inside the Date
 * range and a delivery id.
 */
function deliveriesCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const cursor = typeof value === "string" ? value : "";
  const separator = cursor.indexOf(":");
  const time = cursor.slice(0, separator);
  if (
    separator < 1 ||
    !/^\d{1,16}$/.test(time) ||
    Number(time) > ACTIVITY_TIME_MAX_MS ||
    !DELIVERY_ID_PATTERN.test(cursor.slice(separator + 1))
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      "before must be the previous answer's nextBefore",
    );
  }
  return cursor;
}

const HANDLERS: Record<string, Handler> = {
  // The provider tools (provider-tools.ts), the sign-in provider tools
  // (signin-tools.ts) and the model-provider tools (ai-tools.ts), run the
  // same way.
  ...PROVIDER_HANDLERS,
  ...PROVIDER_CONNECTION_HANDLERS,
  ...SIGNIN_HANDLERS,
  ...AI_HANDLERS,

  async workspace_show(ctx) {
    const [organization, { users }, { groups }, apps] = await Promise.all([
      OrganizationRepository.findSummaryById(ctx.orgId),
      AdminService.listMembers(ctx),
      GroupService.listGroups(ctx),
      AppRepository.findAll(ctx.orgId),
    ]);
    return {
      organization,
      role: ctx.role,
      email: { configured: isEmailConfigured() },
      counts: {
        members: users.filter((user) => !user.invitationId).length,
        pendingInvitations: users.filter((user) => user.invitationId).length,
        groups: groups.length,
        apps: apps.length,
      },
    };
  },

  async workspace_users(ctx) {
    const { users } = await AdminService.listMembers(ctx);
    return {
      members: users
        .filter((user) => !user.invitationId)
        .map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          deactivated: user.banned === true,
          // The account's creation, and when they joined this organization.
          createdAt: user.createdAt,
          joinedAt: user.joinedAt ?? null,
        })),
      invitations: users
        .filter((user) => user.invitationId)
        .map((user) => ({
          id: user.invitationId,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          expiresAt: user.expiresAt ?? null,
        })),
    };
  },

  async workspace_invite(ctx, args) {
    const role = text(args["role"]) === "admin" ? "admin" : "member";
    const invited = await InvitationService.inviteWithoutSession(ctx, {
      email: requireText(args, "email"),
      role,
    });
    return {
      invitationId: invited.invitationId,
      email: invited.email,
      role: invited.role,
      expiresAt: invited.expiresAt,
      emailed: invited.emailSent,
      ...(invited.emailSent
        ? {}
        : {
            next: invited.emailConfigured
              ? "The email could not be sent. An admin copies the invitation link from Admin → Users, or runs everyapp workspace invite-link."
              : "This Gateway sends no email. An admin copies the invitation link from Admin → Users, or runs everyapp workspace invite-link.",
          }),
    };
  },

  async workspace_uninvite(ctx, args) {
    const ref = requireText(args, "invitation");
    // An expired invitation is still listed and counted, and the UI
    // cancels it; so does this.
    const pending = await InvitationService.findPending(ctx, ref, {
      includeExpired: true,
    });
    if (!pending) {
      throw new PublicError(
        "INVITATION_NOT_FOUND",
        `No pending invitation "${ref.trim()}" here`,
      );
    }
    const { invitation } = await AdminService.cancelInvitationWithoutSession(
      ctx,
      pending.id,
    );
    return { canceled: invitation };
  },

  async workspace_role(ctx, args) {
    const user = await resolveUser(ctx, requireText(args, "user"));
    const role = requireText(args, "role");
    if (role !== "member" && role !== "admin" && role !== "owner") {
      throw new PublicError("INVALID_INPUT", "role is member, admin or owner");
    }
    // The service's rules: only an owner makes or demotes an owner, never
    // yourself, never the last owner (OWNER_REQUIRED, CANNOT_MANAGE_SELF,
    // LAST_OWNER).
    const changed = await MembershipService.changeRole(ctx, user.id, role);
    return { user: { id: user.id, email: user.email }, role: changed.role };
  },

  async workspace_deactivate(ctx, args) {
    const user = await resolveUser(ctx, requireText(args, "user"));
    await MembershipService.deactivate(ctx, user.id);
    return { user: { id: user.id, email: user.email }, deactivated: true };
  },

  async workspace_reactivate(ctx, args) {
    const user = await resolveUser(ctx, requireText(args, "user"));
    await MembershipService.reactivate(ctx, user.id);
    return { user: { id: user.id, email: user.email }, deactivated: false };
  },

  async workspace_remove(ctx, args) {
    requireConfirm(args);
    const user = await resolveUser(ctx, requireText(args, "user"));
    const { deactivatedInstead } = await AdminService.deleteUser(ctx, user.id);
    return {
      user: { id: user.id, email: user.email },
      removed: !deactivatedInstead,
      deactivatedInstead,
      ...(deactivatedInstead
        ? {
            note: "Cloudflare Access would let this person straight back in, so they were deactivated instead and stay listed.",
          }
        : {}),
    };
  },

  async workspace_reset_email(ctx, args) {
    const user = await resolveUser(ctx, requireText(args, "user"));
    await MembershipService.sendPasswordResetEmail(ctx, user.id);
    return { user: { id: user.id, email: user.email }, sent: true };
  },

  async workspace_groups(ctx) {
    return GroupService.listGroups(ctx);
  },

  async workspace_group_create(ctx, args) {
    const group = await GroupService.createGroup(ctx, {
      name: requireText(args, "name"),
      description: text(args["description"]) ?? null,
    });
    return { group };
  },

  async workspace_group_set(ctx, args) {
    const found = await resolveGroup(ctx, requireText(args, "group"));
    const current = await GroupRepository.findById(found.id, ctx.orgId);
    if (!current) throw new PublicError("GROUP_NOT_FOUND", "Group not found");
    const description = text(args["description"]);
    const group = await GroupService.updateGroup(ctx, found.id, {
      name: text(args["name"]) ?? current.name,
      description:
        description === undefined ? current.description : description,
    });
    return { group };
  },

  async workspace_group_delete(ctx, args) {
    const group = await resolveGroup(ctx, requireText(args, "group"));
    await GroupService.deleteGroup(ctx, group.id);
    return { deleted: group };
  },

  async workspace_group_members(ctx, args) {
    const group = await resolveGroup(ctx, requireText(args, "group"));
    const { users } = await GroupService.getGroupMembers(ctx, group.id);
    return { group, users };
  },

  async workspace_group_members_set(ctx, args) {
    const group = await resolveGroup(ctx, requireText(args, "group"));
    const change = listChange(args, "users");
    const { users } = await GroupService.getGroupMembers(ctx, group.id);
    const current = users.filter((user) => user.inGroup).map((user) => user.id);
    const wanted =
      "full" in change
        ? await resolveUsers(ctx, change.full)
        : applyChange(current, {
            add: await resolveUsers(ctx, change.add),
            remove: await resolveUsers(ctx, change.remove),
          });
    const result = await GroupService.setGroupMembers(ctx, group.id, wanted);
    return { group, ...result, members: wanted.length };
  },

  async workspace_group_apps(ctx, args) {
    const group = await resolveGroup(ctx, requireText(args, "group"));
    const { apps } = await GroupService.getGroupApps(ctx, group.id);
    return { group, apps };
  },

  async workspace_group_apps_set(ctx, args) {
    const group = await resolveGroup(ctx, requireText(args, "group"));
    const change = listChange(args, "apps");
    const { apps } = await GroupService.getGroupApps(ctx, group.id);
    const current = apps.filter((app) => app.granted).map((app) => app.id);
    const wanted =
      "full" in change
        ? await resolveApps(ctx, change.full)
        : applyChange(current, {
            add: await resolveApps(ctx, change.add),
            remove: await resolveApps(ctx, change.remove),
          });
    const result = await GroupService.setGroupApps(ctx, group.id, wanted);
    return { group, ...result, apps: wanted.length };
  },

  async workspace_apps(ctx) {
    const { apps } = await AppService.getAllWithAccessCounts(ctx);
    return {
      apps: apps.map((app) => ({
        ...listedApp({ ...app, appSlug: app.appId }),
        accessCount: app.accessCount,
        readOnly: app.readOnly,
        setup: app.setup,
      })),
    };
  },

  async workspace_app_set(ctx, args) {
    const app = await resolveApp(ctx, requireText(args, "app"));
    const everyone = args["everyone"];
    await AppService.update(ctx, {
      id: app.id,
      ...(text(args["name"]) !== undefined ? { name: text(args["name"]) } : {}),
      ...(text(args["description"]) !== undefined
        ? { description: text(args["description"]) }
        : {}),
      ...(typeof everyone === "boolean" ? { isDefault: everyone } : {}),
    });
    const updated = await AppRepository.findById(app.id, ctx.orgId);
    return { app: listedApp(updated ?? app) };
  },

  async workspace_app_access(ctx, args) {
    const app = await resolveApp(ctx, requireText(args, "app"));
    const { users } = await AppAccessService.getAccessStateForApp(ctx, app.id);
    return { app: { id: app.id, appId: app.appSlug, name: app.name }, users };
  },

  async workspace_app_access_set(ctx, args) {
    const app = await resolveApp(ctx, requireText(args, "app"));
    const change = listChange(args, "users");
    const { users } = await AppAccessService.getAccessStateForApp(ctx, app.id);
    const current = users
      .filter((user) => user.hasAccess)
      .map((user) => user.id);
    const wanted =
      "full" in change
        ? await resolveUsers(ctx, change.full)
        : applyChange(current, {
            add: await resolveUsers(ctx, change.add),
            remove: await resolveUsers(ctx, change.remove),
          });
    const result = await AppAccessService.updateAccessForApp(
      ctx,
      app.id,
      wanted,
    );
    return {
      app: { id: app.id, appId: app.appSlug, name: app.name },
      ...result,
    };
  },

  async workspace_app_cap(ctx, args) {
    const app = await resolveApp(ctx, requireText(args, "app"), {
      callable: true,
    });
    const unlimited = args["unlimited"];
    // A cap left out keeps what the app has; the service refuses a cap
    // and unlimited together, and a call that names neither cap nor
    // unlimited, and answers the app's own settings with the caps that
    // bind it now (AppCapState).
    const set = await AppCapService.setMonthlyCap(ctx, {
      appRowId: app.id,
      ...capArgs(args),
      ...(typeof unlimited === "boolean" ? { unlimited } : {}),
    });
    return {
      app: { id: app.id, appId: app.appSlug, name: app.name },
      monthlyCallCap: set.monthlyCallCap,
      monthlyCostCapMicros: set.monthlyCostCapMicros,
      capUnlimited: set.capUnlimited,
      effectiveMonthlyCallCap: set.effectiveMonthlyCallCap,
      capSource: set.capSource,
      effectiveMonthlyCostCapMicros: set.effectiveMonthlyCostCapMicros,
      costCapSource: set.costCapSource,
    };
  },

  async workspace_cap_default(ctx, args) {
    const set = await AppCapService.setDefaultMonthlyCap(ctx, capArgs(args));
    return {
      defaultMonthlyCallCap: set.defaultMonthlyCallCap,
      defaultMonthlyCostCapMicros: set.defaultMonthlyCostCapMicros,
    };
  },

  async workspace_app_delete(ctx, args) {
    requireConfirm(args);
    const app = await resolveApp(ctx, requireText(args, "app"));
    await AppService.delete(ctx, app.id);
    return {
      deleted: { id: app.id, appId: app.appSlug, name: app.name },
      note: "The catalog row is gone; the Worker stays until everyapp delete.",
    };
  },

  async workspace_usage(ctx, args) {
    const month = text(args["month"]) ?? currentMonth();
    if (!MONTH.test(month)) {
      throw new PublicError("INVALID_INPUT", "month must be YYYY-MM");
    }
    const summary = await UsageRepository.summarize({
      organizationId: ctx.orgId,
      month,
    });
    return { ...summary };
  },

  async workspace_activity(ctx, args) {
    const appRef = text(args["app"]);
    const userRef = text(args["user"]);
    const sinceRef = text(args["since"]);
    const since = sinceRef === undefined ? undefined : new Date(sinceRef);
    if (since && Number.isNaN(since.getTime())) {
      throw new PublicError("INVALID_INPUT", "since must be an ISO 8601 time");
    }
    // A person since gone can't be resolved by email; an id is taken as
    // given, and the rows are the organization's own anyway.
    let userId: string | undefined;
    if (userRef !== undefined) {
      userId = userRef.includes("@")
        ? (await resolveUser(ctx, userRef)).id
        : userRef.trim();
    }
    const limit = args["limit"];
    const page = await McpToolCallRepository.listForOrganization({
      organizationId: ctx.orgId,
      limit: typeof limit === "number" ? limit : 50,
      before: activityCursor(args["before"]),
      ...(appRef === undefined ? {} : await activityAppFilter(ctx, appRef)),
      userId,
      decision: text(args["decision"]) as "allowed" | "blocked" | undefined,
      risk: text(args["risk"]),
      since,
    });
    return { ...page };
  },

  async workspace_audit(ctx, args) {
    const actorRef = text(args["actor"]);
    const sinceRef = text(args["since"]);
    const since = sinceRef === undefined ? undefined : new Date(sinceRef);
    if (since && Number.isNaN(since.getTime())) {
      throw new PublicError("INVALID_INPUT", "since must be an ISO 8601 time");
    }
    // A member by email resolves to their user id; any other id (a
    // connection's, a token's, an app's, an operator's, someone gone) is
    // taken as given, and the rows are the organization's own anyway.
    let actorId: string | undefined;
    if (actorRef !== undefined) {
      actorId = actorRef.includes("@")
        ? (await resolveUser(ctx, actorRef)).id
        : actorRef.trim();
    }
    const limit = args["limit"];
    const page = await listAudit(ctx.orgId, {
      limit: typeof limit === "number" ? limit : undefined,
      before: auditCursor(args["before"]),
      actorId,
      type: text(args["type"]),
      since,
    });
    return { ...page };
  },

  async workspace_rename(ctx, args) {
    const renamed = await OrganizationService.rename(
      ctx,
      requireText(args, "name"),
    );
    const summary = await OrganizationRepository.findSummaryById(ctx.orgId);
    return { organization: { ...renamed, slug: summary?.slug ?? null } };
  },

  async workspace_events(ctx) {
    return {
      subscriptions: (await subscriptionsOf(ctx)).map(listedSubscription),
    };
  },

  async workspace_events_add(ctx, args, principal) {
    const recipients = text(args["email"]);
    const email =
      recipients === "owners" || recipients === "admins"
        ? recipients
        : undefined;
    if (recipients !== undefined && !email) {
      throw new PublicError("INVALID_INPUT", "email is owners or admins");
    }
    const added = await EventSubscriptionService.add(
      ctx,
      {
        url: text(args["url"]),
        email,
        events: strings(args["events"]),
        name: text(args["name"]),
        secret: text(args["secret"]),
      },
      // Who made it, as the table records an agent: the credential's id
      // (a connection, a token), never a secret.
      `agent:${principal.credential.id}`,
    );
    const subscription = listedSubscription(added.subscription);
    return {
      subscription,
      // Only when the Gateway generated it: once, here, and never again.
      ...(added.secret
        ? {
            secret: added.secret,
            next: "Store this secret in the receiver now: it signs every delivery to this URL (the X-EveryApp-Signature header) and no tool, page or command shows it again. It opens nothing on the Gateway.",
          }
        : {}),
      ...(subscription.sink === "email" && !isEmailConfigured()
        ? {
            next: "This Gateway sends no email yet (EMAIL_FROM is not set), so deliveries to it fail until it does.",
          }
        : {}),
    };
  },

  async workspace_events_set(ctx, args) {
    const subscription = findSubscription(
      await subscriptionsOf(ctx),
      requireText(args, "subscription"),
    );
    const enabled = args["enabled"];
    const events = strings(args["events"]);
    const name = text(args["name"]);
    if (
      typeof enabled !== "boolean" &&
      events === undefined &&
      name === undefined
    ) {
      throw new PublicError(
        "INVALID_INPUT",
        "Give enabled, events or name: there is nothing to change",
      );
    }
    const updated = await EventSubscriptionService.update(
      ctx,
      subscription.id,
      {
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(events !== undefined ? { events } : {}),
        ...(name !== undefined ? { name } : {}),
      },
    );
    return { subscription: listedSubscription(updated.subscription) };
  },

  async workspace_events_remove(ctx, args) {
    requireConfirm(args);
    const subscription = findSubscription(
      await subscriptionsOf(ctx),
      requireText(args, "subscription"),
    );
    const { removed, disabled } = await EventSubscriptionService.remove(
      ctx,
      subscription.id,
    );
    return {
      subscription: { id: subscription.id, name: subscription.name },
      removed,
      disabled,
      ...(disabled
        ? {
            note: `${subscription.name} is built in, so it was turned off instead of removed, and the Gateway never recreates it. everyapp_workspace_events_set with enabled: true turns it back on.`,
          }
        : {}),
    };
  },

  async workspace_events_test(ctx, args) {
    const subscription = findSubscription(
      await subscriptionsOf(ctx),
      requireText(args, "subscription"),
    );
    // A ping to this one subscription, paused or not, and its first
    // attempt awaited.
    const { delivery } = await EventSubscriptionService.test(
      ctx,
      subscription.id,
    );
    if (!delivery) {
      throw new PublicError(
        "EVENT_SUBSCRIPTION_NOT_FOUND",
        "That subscription doesn't exist or was removed.",
      );
    }
    const listed = listedDelivery(delivery, subscription);
    return {
      subscription: {
        id: subscription.id,
        name: subscription.name,
        enabled: subscription.enabled,
      },
      delivered: listed.state === "delivered",
      delivery: listed,
    };
  },

  async workspace_event_deliveries(ctx, args) {
    const subscriptions = await subscriptionsOf(ctx);
    const ref = text(args["subscription"]);
    const only =
      ref === undefined ? undefined : findSubscription(subscriptions, ref);
    const limit = args["limit"];
    const page = await EventSubscriptionService.deliveries(ctx, {
      subscriptionId: only?.id,
      status: args["dead"] === true ? "dead" : undefined,
      before: deliveriesCursor(args["before"]),
      limit: typeof limit === "number" ? limit : EVENT_DELIVERIES_LIMIT_DEFAULT,
    });
    const byId = new Map(subscriptions.map((row) => [row.id, row]));
    return {
      deliveries: page.deliveries.map((delivery) =>
        listedDelivery(delivery, byId.get(delivery.subscriptionId)),
      ),
      nextBefore: page.nextCursor,
    };
  },

  async workspace_event_redeliver(ctx, args) {
    const id = requireText(args, "delivery").trim();
    const existing = await EventDeliveryRepository.findById(id, ctx.orgId);
    if (!existing) {
      throw new PublicError(
        "EVENT_DELIVERY_NOT_FOUND",
        "That delivery doesn't exist any more.",
      );
    }
    // A delivered row is left alone by the service; say so rather than
    // answer as if it went again.
    const alreadyDelivered = existing.status === "delivered";
    const { delivery } = await EventSubscriptionService.redeliver(
      ctx,
      existing.id,
    );
    if (!delivery) {
      throw new PublicError(
        "EVENT_DELIVERY_NOT_FOUND",
        "That delivery doesn't exist any more.",
      );
    }
    const subscription = (await subscriptionsOf(ctx)).find(
      (row) => row.id === delivery.subscriptionId,
    );
    return {
      redelivered: !alreadyDelivered,
      delivery: listedDelivery(delivery, subscription),
      ...(alreadyDelivered
        ? { note: "It was delivered already, so nothing was sent again." }
        : {}),
    };
  },

  async my_tokens(ctx, _args, principal) {
    const { tokens } = await UserPatService.listForUser(
      principal.userId,
      ctx.orgId,
    );
    return {
      tokens: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        tokenPrefix: token.tokenPrefix,
        scopes: token.scopes,
        app: token.appSlug,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt,
      })),
    };
  },

  async revoke_token(ctx, args, principal) {
    const ref = requireText(args, "token").trim();
    const { tokens } = await UserPatService.listForUser(
      principal.userId,
      ctx.orgId,
    );
    let token = tokens.find((candidate) => candidate.id === ref);
    if (!token) {
      const named = tokens.filter(
        (candidate) => candidate.name === ref && !candidate.revokedAt,
      );
      if (named.length > 1) {
        throw new PublicError(
          "INVALID_INPUT",
          `${named.length} tokens are named "${ref}"; give the id`,
        );
      }
      token = named[0];
    }
    if (!token) throw new PublicError("TOKEN_NOT_FOUND", "Token not found");
    const { alreadyRevoked } = await UserPatService.revoke(
      token.id,
      principal.userId,
    );
    return { token: { id: token.id, name: token.name }, alreadyRevoked };
  },

  async my_connections(_ctx, _args, principal) {
    return McpConnectionService.listForUser(principal.userId);
  },

  async revoke_connection(_ctx, args, principal) {
    const id = requireText(args, "connection").trim();
    await McpConnectionService.revokeForUser(principal.userId, id);
    return {
      revoked: id,
      // The row is what every request checks, so this very connection ends
      // on its next request.
      endsThisConnection:
        principal.credential.kind === "oauth" && principal.credential.id === id,
    };
  },

  ...MCP_APP_HANDLERS,
};

/**
 * The events a tool's write emits name the agent as their cause: the
 * credential's id, the connection's client name when it has one, and the
 * member it acts for (docs/design/2026-10-events-out.md, the actor).
 */
function agentActor(principal: McpPrincipal): EventActor {
  return {
    kind: "agent",
    id: principal.credential.id,
    ...(principal.credential.clientName
      ? { name: principal.credential.clientName }
      : {}),
    email: principal.email,
  };
}

function toolError(message: string): ToolCallResultV1 {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The data as JSON text and structured content; dates as ISO strings. */
function toolResult(data: JsonObject): ToolCallResultV1 {
  const plain = JSON.parse(JSON.stringify(data)) as JsonObject;
  return {
    content: [{ type: "text", text: JSON.stringify(plain, null, 2) }],
    structuredContent: plain,
  };
}

/**
 * Run one workspace tool for the caller: `ToolBusDeps.workspace.run`. A
 * `PublicError` is the tool's error result, `CODE: message`; a handler's
 * own refusal (`error` in its answer) likewise; anything else is logged
 * and thrown for the ToolBus to answer as a plain failure.
 */
export async function runWorkspaceTool(
  name: string,
  args: JsonObject,
  principal: McpPrincipal,
): Promise<ToolCallResultV1> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`no workspace tool "${name}"`);
  const role = resolvePrimaryOrganizationRole(principal.orgRole);
  if (!role) {
    return toolError("AUTH_UNAUTHORIZED: this connection has no role here");
  }
  const ctx: OrgContext = {
    orgId: principal.organizationId,
    userId: principal.userId,
    role,
    actor: agentActor(principal),
  };
  try {
    const answer = await handler(ctx, args, principal);
    const refusal = answer["error"];
    if (typeof refusal === "string") return toolError(refusal);
    return toolResult(answer);
  } catch (error) {
    if (error instanceof PublicError) {
      return toolError(`${error.code}: ${error.message}`);
    }
    logEvent(
      "mcp.workspace_tool.failed",
      {
        tool: name,
        org: ctx.orgId,
        user_id: ctx.userId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    throw error;
  }
}
