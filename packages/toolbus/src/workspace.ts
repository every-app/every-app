/**
 * The workspace tools: every admin action of the gateway's UI (Admin →
 * Users, Groups, Apps, Usage, Activity, and the organization's name) as a
 * built-in on the gateway's own /mcp, under `everyapp_workspace_*`, plus
 * the four member-level ones a person has on their own account
 * (`everyapp_my_tokens`, `everyapp_revoke_token`, `everyapp_my_connections`,
 * `everyapp_revoke_connection`).
 *
 * Only the definitions live here (name, title, a description written for
 * an AI client, risk, the lowest role that sees the tool, the input
 * schema), so the policy, the listing and the docs' drift test read one
 * source. The gateway supplies the handlers (`ToolBusDeps.workspace`,
 * apps/every-app-gateway/src/server/toolbus/workspace-tools.ts); without
 * them no workspace tool is listed.
 *
 * The schemas are the gateway's own and are checked whatever the value
 * count (execute.ts `ownSchema`), so they stay small: no regular
 * expressions, references or unions, `additionalProperties: false`, every
 * field described. Identifiers are what a person would type: a user by
 * email or id, an app by its manifest id or row id, a group by name or
 * `grp_` id, an invitation by id or email, a token by id or name.
 *
 * No workspace tool returns a credential that opens the Gateway:
 * `everyapp_workspace_invite` says whether the invitation was mailed and
 * never carries the link, password resets go to the user's inbox, and
 * tokens are listed and revoked, never created
 * (docs/design/2026-10-agent-parity.md, decision 2). The one secret a
 * tool returns is the webhook signing secret `everyapp_workspace_events_add`
 * generates, once, in its answer: it signs deliveries to the URL the
 * caller chose and opens nothing on the Gateway
 * (docs/design/2026-10-events-out.md, section 9).
 *
 * The MCP app tools (`everyapp_mcp_*`) are defined in mcpApps.ts and listed
 * here after these.
 */
import {
  EVENT_EMAIL_RECIPIENTS,
  EVENT_SECRET_MAX_LENGTH,
  EVENT_SECRET_MIN_LENGTH,
  EVENT_SUBSCRIPTIONS_MAX,
  EVENT_SUBSCRIPTION_NAME_MAX,
  EVENT_TYPES,
  EVENT_URL_MAX_LENGTH,
} from "@every-app/sdk/internal";
import { MCP_APP_TOOLS } from "./mcpApps";
import type { JsonObject, WorkspaceRole } from "./types";

export interface WorkspaceToolDefinition {
  /** Local name, after `everyapp_`: `workspace_users`, `my_tokens`. */
  name: string;
  title: string;
  description: string;
  risk: "read" | "write";
  /** The lowest organization role that sees and runs the tool. */
  minRole: WorkspaceRole;
  inputSchema: JsonObject;
  /**
   * The tool cannot be undone and asks for `confirm: true`; it is listed
   * with `destructiveHint: true` so a client can ask its user first.
   */
  irreversible?: true;
  /**
   * What the host must offer beyond the handlers: `providers` for a tool
   * that writes the provider registry (`WorkspaceHost.providers`, a
   * self-hosted gateway). Without it the tool is hidden and a call answers
   * Unknown tool, like one without a host.
   */
  needs?: "providers";
}

/**
 * The most rows `everyapp_workspace_activity` returns per page: the
 * gateway's `TOOL_CALL_PAGE_MAX` (McpToolCallRepository), which its test
 * pins to this.
 */
export const WORKSPACE_ACTIVITY_PAGE_MAX = 200;
const ACTIVITY_LIMIT_DEFAULT = 50;
/**
 * The largest time a cursor may name, in milliseconds since the epoch: the
 * JavaScript Date range (8.64e15), which the gateway's own filter bounds
 * the same way; past it the cursor would bind NaN.
 */
export const ACTIVITY_TIME_MAX_MS = 8_640_000_000_000_000;
/**
 * The most deliveries `everyapp_workspace_event_deliveries` returns per
 * page: the gateway's `DELIVERIES_PAGE_MAX` (server/events/subscriptions.ts),
 * which its test pins to this.
 */
export const WORKSPACE_EVENT_DELIVERIES_PAGE_MAX = 100;
const EVENT_DELIVERIES_LIMIT_DEFAULT = 20;
/**
 * Event types or patterns one subscription names, and the length of one:
 * the bounds of the server functions' schema (schemas/event-subscription.ts
 * in the gateway); the catalogue's own rule refuses a longer pattern anyway.
 */
const EVENT_PATTERNS_MAX = 50;
const EVENT_PATTERN_MAX = 80;
/** A delivery page's cursor: `<created_at ms>:<dlv_ id>`. */
const EVENT_CURSOR_MAX = 80;

/** Longest identifier a tool takes: an email, an id, a name. */
const ID_MAX = 254;
/** How many users or apps one set/add/remove names at most. */
const LIST_MAX = 500;
const ORGANIZATION_NAME_MAX = 64;
const GROUP_NAME_MAX = 60;
const GROUP_DESCRIPTION_MAX = 500;
const APP_NAME_MAX = 255;
const APP_DESCRIPTION_MAX = 1000;
const MONTHLY_CAP_MAX = 1_000_000_000;

const NO_INPUT: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const id = (description: string) => ({
  type: "string",
  description,
  minLength: 1,
  maxLength: ID_MAX,
});

const USER = id(
  "The member: their email address, or their user id (from everyapp_workspace_users).",
);
const APP = id(
  "The app: its manifest id (as everyapp_list_apps lists it, e.g. `crm`), or its row id (from everyapp_workspace_apps).",
);
const GROUP = id(
  "The group: its name, or its id (`grp_…`, from everyapp_workspace_groups).",
);
const SUBSCRIPTION = id(
  "The event subscription: its id (`sub_…`, from everyapp_workspace_events), or its name. A name several subscriptions share is refused; use the id.",
);

/**
 * The catalogue as the add tool's description lists it, from the one list
 * the gateway emits by (EVENT_TYPES), so the two never drift. `ping` is
 * left out: only everyapp_workspace_events_test sends it, to one
 * subscription.
 */
const EVENT_TYPE_NAMES = EVENT_TYPES.map((info) => info.type)
  .filter((type) => type !== "ping")
  .join(", ");

const eventPatterns = (description: string) => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1, maxLength: EVENT_PATTERN_MAX },
  maxItems: EVENT_PATTERNS_MAX,
});

const CONFIRM = {
  type: "boolean",
  description:
    "Must be true. The action cannot be undone; ask the person before calling.",
  const: true,
};

const list = (description: string) => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1, maxLength: ID_MAX },
  maxItems: LIST_MAX,
});

function objectWith(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonObject {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * The input of a tool that sets a list of members: the target (a group or
 * an app), then `users` (the full list) or `add` and/or `remove`.
 */
function membersChange(
  target: Record<string, unknown>,
  what: string,
): JsonObject {
  const [key] = Object.keys(target);
  return objectWith(
    {
      ...target,
      users: list(
        `The full list of ${what}, by email or user id. Replaces the current list; give this or add/remove, not both.`,
      ),
      add: list("Members to add (email or user id), keeping the rest."),
      remove: list("Members to take out (email or user id), keeping the rest."),
    },
    key ? [key] : [],
  );
}

const ADMIN_READ = { risk: "read", minRole: "admin" } as const;
const ADMIN_WRITE = { risk: "write", minRole: "admin" } as const;
const OWNER_WRITE = { risk: "write", minRole: "owner" } as const;

/**
 * Every workspace tool, in the order tools/list shows them. Role `admin`
 * means owner or admin; `owner` means the owner alone; `member` is every
 * member, on their own account only.
 */
export const WORKSPACE_TOOLS: readonly WorkspaceToolDefinition[] = [
  {
    ...ADMIN_READ,
    name: "workspace_show",
    title: "Show the workspace",
    description:
      "Show this organization: its id, name and slug, your role, whether the Gateway can send email, and how many members, pending invitations, groups and apps it has. Owners and admins.",
    inputSchema: NO_INPUT,
  },
  {
    ...ADMIN_READ,
    name: "workspace_users",
    title: "List members",
    description:
      "List the organization's members (id, name, email, role, whether deactivated, when the account was created and when they joined) and its pending invitations (id, email, role, when they expire; an expired one stays listed until canceled). Owners and admins.",
    inputSchema: NO_INPUT,
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_invite",
    title: "Invite someone",
    description:
      "Invite an email address to the organization as a member or an admin. Creates the invitation and mails it when the Gateway can send email; the answer says whether it was mailed and never carries the invitation link (an admin copies it from Admin → Users). Refused for an address that is a member or already invited, and once the organization holds 100 pending invitations. Owners and admins.",
    inputSchema: objectWith(
      {
        email: {
          type: "string",
          description: "The email address to invite.",
          minLength: 3,
          maxLength: ID_MAX,
        },
        role: {
          type: "string",
          description: "The role they join with. Default member.",
          enum: ["member", "admin"],
          default: "member",
        },
      },
      ["email"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_uninvite",
    title: "Cancel an invitation",
    description:
      "Cancel a pending invitation (an expired one too), by its id or the invited email address. Owners and admins.",
    inputSchema: objectWith(
      {
        invitation: id(
          "The invitation: its id (from everyapp_workspace_users), or the invited email address.",
        ),
      },
      ["invitation"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_role",
    title: "Change a member's role",
    description:
      "Make a member an admin, an admin a member, or make or demote an owner. Only an owner changes an admin or an owner, or makes one; nobody changes their own role; the last owner is never demoted. Owners and admins.",
    inputSchema: objectWith(
      {
        user: USER,
        role: {
          type: "string",
          description: "The role to give.",
          enum: ["member", "admin", "owner"],
        },
      },
      ["user", "role"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_deactivate",
    title: "Deactivate a member",
    description:
      "Lock a member out everywhere: no sign-in, every session ended, their personal access tokens and AI connections revoked. They stay listed and can be reactivated. Only an owner deactivates an admin; never yourself or an owner. Owners and admins.",
    inputSchema: objectWith({ user: USER }, ["user"]),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_reactivate",
    title: "Reactivate a member",
    description:
      "Let a deactivated member sign in again. Tokens and connections revoked at deactivation stay revoked. Owners and admins.",
    inputSchema: objectWith({ user: USER }, ["user"]),
  },
  {
    ...OWNER_WRITE,
    name: "workspace_remove",
    title: "Remove a member",
    description:
      "Remove a member from the organization: their membership, app access, group places, tokens and AI connections go, and their account when it belongs to no other organization. Where Cloudflare Access would let them straight back in they are deactivated instead, and the answer says so. Cannot be undone: needs confirm: true. Owners only.",
    inputSchema: objectWith({ user: USER, confirm: CONFIRM }, [
      "user",
      "confirm",
    ]),
    irreversible: true,
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_reset_email",
    title: "Send a password-reset email",
    description:
      "Mail a member a password-reset link. The link goes to their inbox, never to you. Refused where the Gateway sends no email (an admin copies a reset link from Admin → Users instead) or password sign-in is off; only for active members of this organization alone, never yourself or an owner. Owners and admins.",
    inputSchema: objectWith({ user: USER }, ["user"]),
  },
  {
    ...ADMIN_READ,
    name: "workspace_groups",
    title: "List groups",
    description:
      "List the organization's groups with their id (`grp_…`), name, description, and how many members and apps each has. Owners and admins.",
    inputSchema: NO_INPUT,
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_group_create",
    title: "Create a group",
    description:
      "Create a group. Names are unique in the organization, letter case aside. Owners and admins.",
    inputSchema: objectWith(
      {
        name: {
          type: "string",
          description: "The group's name, 1 to 60 characters.",
          minLength: 1,
          maxLength: GROUP_NAME_MAX,
        },
        description: {
          type: "string",
          description: "What the group is for. Optional.",
          maxLength: GROUP_DESCRIPTION_MAX,
        },
      },
      ["name"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_group_set",
    title: "Rename or describe a group",
    description:
      "Change a group's name or description. A field left out keeps its value. Owners and admins.",
    inputSchema: objectWith(
      {
        group: GROUP,
        name: {
          type: "string",
          description: "The new name, 1 to 60 characters.",
          minLength: 1,
          maxLength: GROUP_NAME_MAX,
        },
        description: {
          type: "string",
          description: "The new description; an empty string clears it.",
          maxLength: GROUP_DESCRIPTION_MAX,
        },
      },
      ["group"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_group_delete",
    title: "Delete a group",
    description:
      "Delete a group. The app access it granted its members ends with it. Owners and admins.",
    inputSchema: objectWith({ group: GROUP }, ["group"]),
  },
  {
    ...ADMIN_READ,
    name: "workspace_group_members",
    title: "List a group's members",
    description:
      "List every member of the organization with whether they are in the group. Owners and admins.",
    inputSchema: objectWith({ group: GROUP }, ["group"]),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_group_members_set",
    title: "Set a group's members",
    description:
      "Set who is in a group: give `users` (the full list) or `add` and/or `remove` (changes to the current list). Only members of the organization. Owners and admins.",
    inputSchema: membersChange({ group: GROUP }, "the group's members"),
  },
  {
    ...ADMIN_READ,
    name: "workspace_group_apps",
    title: "List a group's apps",
    description:
      "List the organization's own apps with whether the group opens each. Owners and admins.",
    inputSchema: objectWith({ group: GROUP }, ["group"]),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_group_apps_set",
    title: "Set a group's apps",
    description:
      "Set which apps a group opens: give `apps` (the full list) or `add` and/or `remove` (changes to the current list), each app by manifest id or row id. Only the organization's own apps; a shared app is everyone's already. Owners and admins.",
    inputSchema: objectWith(
      {
        group: GROUP,
        apps: list(
          "The full list of apps the group opens, by manifest id or row id. Replaces the current list; give this or add/remove, not both.",
        ),
        add: list("Apps to grant (manifest id or row id), keeping the rest."),
        remove: list(
          "Apps to revoke (manifest id or row id), keeping the rest.",
        ),
      },
      ["group"],
    ),
  },
  {
    ...ADMIN_READ,
    name: "workspace_apps",
    title: "List apps",
    description:
      "List every app of the organization (and the shared apps on a hosted Gateway): row id, manifest id, name, description, status, whether everyone can open it, how many members have direct access, and what it still needs before it opens (setup). Owners and admins.",
    inputSchema: NO_INPUT,
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_app_set",
    title: "Edit an app",
    description:
      "Change an app's name, description, or whether it is available to everyone (every current and future member gets access; turning it off keeps existing access). A field left out keeps its value. Owners and admins.",
    inputSchema: objectWith(
      {
        app: APP,
        name: {
          type: "string",
          description: "The new name.",
          minLength: 1,
          maxLength: APP_NAME_MAX,
        },
        description: {
          type: "string",
          description: "The new description.",
          minLength: 1,
          maxLength: APP_DESCRIPTION_MAX,
        },
        everyone: {
          type: "boolean",
          description: "Whether the app is available to every member.",
        },
      },
      ["app"],
    ),
  },
  {
    ...ADMIN_READ,
    name: "workspace_app_access",
    title: "Who can open an app",
    description:
      "List every member of the organization with whether they hold direct access to the app, and the groups that grant it to them. Owners and admins.",
    inputSchema: objectWith({ app: APP }, ["app"]),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_app_access_set",
    title: "Set who can open an app",
    description:
      "Set which members hold direct access to an app: give `users` (the full list) or `add` and/or `remove` (changes to the current list). Access a group grants is not touched here; your own access is never revoked. Owners and admins.",
    inputSchema: membersChange({ app: APP }, "members with direct access"),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_app_cap",
    title: "Cap an app's monthly calls",
    description:
      "Set the organization's monthly cap on an app's provider calls (Admin → Usage), say the app has no cap whatever the workspace default (`cap: null, unlimited: true`), or neither (`cap: null` alone): the app inherits the workspace default, and without one it is uncapped. Answers the app's own cap, `capUnlimited`, and the cap that binds it now with its source (`app`, `default`, or null). Owners and admins.",
    inputSchema: objectWith(
      {
        app: APP,
        cap: {
          type: ["integer", "null"],
          description:
            "Calls per month, 1 to 1,000,000,000; null for no cap of its own (the workspace default applies unless `unlimited`).",
          minimum: 1,
          maximum: MONTHLY_CAP_MAX,
        },
        unlimited: {
          type: "boolean",
          description:
            "No cap at all, even with a workspace default. Only with cap null: a cap and unlimited together are refused.",
        },
      },
      ["app", "cap"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_cap_default",
    title: "The workspace default cap",
    description:
      "Set or clear the organization's default monthly cap on provider calls (Admin → Usage → Default monthly cap): what binds every app without a cap or `unlimited` of its own. A whole number of calls, or null for no default. Owners and admins.",
    inputSchema: objectWith(
      {
        cap: {
          type: ["integer", "null"],
          description:
            "Calls per month for every app without its own cap, 1 to 1,000,000,000; null for no default.",
          minimum: 1,
          maximum: MONTHLY_CAP_MAX,
        },
      },
      ["cap"],
    ),
  },
  {
    ...OWNER_WRITE,
    name: "workspace_app_delete",
    title: "Delete an app",
    description:
      "Delete an app from the catalog: it stops being served and leaves every list. Its Worker stays until `everyapp delete`. Cannot be undone: needs confirm: true. Owners only.",
    inputSchema: objectWith({ app: APP, confirm: CONFIRM }, ["app", "confirm"]),
    irreversible: true,
  },
  {
    ...ADMIN_READ,
    name: "workspace_usage",
    title: "Usage for a month",
    description:
      "What the organization's apps spent in a UTC month: per app, per member and per provider or capability, with the workspace default cap (`defaultMonthlyCallCap`) and for each app its own cap, `capUnlimited`, the cap that binds it (`effectiveMonthlyCallCap`, `capSource`: app or default) and whether it is `paused` this month. Owners and admins.",
    inputSchema: objectWith({
      month: {
        type: "string",
        description: "The month as YYYY-MM (UTC). Default: the current month.",
        minLength: 7,
        maxLength: 7,
      },
    }),
  },
  {
    ...ADMIN_READ,
    name: "workspace_activity",
    title: "Agent activity",
    description:
      "One page of the organization's MCP tool calls (the audit trail), newest first: who, through which credential and client, which tool, the decision and outcome. Never the arguments or results. Filter by app, member, decision, risk or time; page with `before` from the previous answer's `nextBefore`. Owners and admins.",
    inputSchema: objectWith({
      app: id(
        "Only calls to this app: its manifest id (a removed app's too, or `everyapp` for the Gateway's own tools) or its row id.",
      ),
      user: USER,
      decision: {
        type: "string",
        description: "Only calls that were allowed, or only blocked ones.",
        enum: ["allowed", "blocked"],
      },
      risk: {
        type: "string",
        description: "Only calls to tools of this risk.",
        enum: ["read", "write", "destructive"],
      },
      since: {
        type: "string",
        description:
          "Only calls at or after this time, as an ISO 8601 date-time.",
        minLength: 4,
        maxLength: 40,
      },
      limit: {
        type: "integer",
        description: `Rows per page, 1 to ${WORKSPACE_ACTIVITY_PAGE_MAX}. Default ${ACTIVITY_LIMIT_DEFAULT}.`,
        minimum: 1,
        maximum: WORKSPACE_ACTIVITY_PAGE_MAX,
        default: ACTIVITY_LIMIT_DEFAULT,
      },
      before: {
        type: "object",
        description:
          "The previous page's `nextBefore`: the page continues before this row.",
        properties: {
          createdAt: {
            type: "integer",
            description: "The row's time in milliseconds since the epoch.",
            minimum: 0,
            // Past this `new Date(n)` is invalid, as the UI's filter bounds it.
            maximum: ACTIVITY_TIME_MAX_MS,
          },
          id: {
            type: "string",
            description: "The row's id.",
            minLength: 1,
            maxLength: 128,
          },
        },
        required: ["createdAt", "id"],
        additionalProperties: false,
      },
    }),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_rename",
    title: "Rename the workspace",
    description:
      "Rename the organization. The slug (its address) stays as it is. Owners and admins.",
    inputSchema: objectWith(
      {
        name: {
          type: "string",
          description: "The new name, 1 to 64 characters.",
          minLength: 1,
          maxLength: ORGANIZATION_NAME_MAX,
        },
      },
      ["name"],
    ),
  },
  // Events out (docs/design/2026-10-events-out.md, section 9): the
  // organization's event subscriptions, a test ping, the delivery log and
  // a redeliver, through the same service as Admin → Events.
  {
    ...ADMIN_READ,
    name: "workspace_events",
    title: "List event subscriptions",
    description:
      "List the organization's event subscriptions: id (`sub_…`), name, where it delivers (a webhook URL's host and path, never its query; or email to the owners, or to the owners and admins), the event types and patterns it takes, whether it is on, whether it is built in (Cap alerts), and its last delivery (when, and delivered, failed or dead) with the failures in a row. Never a signing secret. Owners and admins.",
    inputSchema: NO_INPUT,
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_events_add",
    title: "Add an event subscription",
    description: `Subscribe a webhook URL (Slack's workflow webhook, Zapier, n8n, your own endpoint), or the organization's owners or owners and admins by email, to the Gateway's events. Give \`url\` or \`email\`, not both. A webhook URL is https on a public hostname, never the Gateway's own host or an app's. \`events\` takes types or patterns; none means every event. The types: ${EVENT_TYPE_NAMES}; patterns: a group (\`member.*\`, \`cap.*\`), an app's own events (\`app.crm.*\`, or \`app.crm.invoice.paid\`), or \`*\`. Every webhook delivery is signed with the subscription's secret (HMAC-SHA256 over the timestamp and the body, in the X-EveryApp-Signature header). Give \`secret\` when the receiver already has one; leave it out and the Gateway generates one and returns it once, in this answer, and never again. That secret only signs deliveries to this URL and opens nothing on the Gateway; the person must store it in their receiver now. At most ${EVENT_SUBSCRIPTIONS_MAX} subscriptions per organization. Owners and admins.`,
    inputSchema: objectWith({
      url: {
        type: "string",
        description:
          "The webhook URL every matching event is POSTed to, signed. Give this or email, not both.",
        minLength: 1,
        maxLength: EVENT_URL_MAX_LENGTH,
      },
      email: {
        type: "string",
        description:
          "Mail each event to the organization's owners (`owners`) or its owners and admins (`admins`) instead of a webhook. Give this or url, not both.",
        enum: [...EVENT_EMAIL_RECIPIENTS],
      },
      events: eventPatterns(
        "Event types (`member.joined`) or patterns (`member.*`, `app.crm.*`, `*`) to deliver. Leave it out for every event.",
      ),
      name: {
        type: "string",
        description: `What to call it, like "Slack #ops", up to ${EVENT_SUBSCRIPTION_NAME_MAX} characters. Default: the URL's host, or "Email owners and admins".`,
        minLength: 1,
        maxLength: EVENT_SUBSCRIPTION_NAME_MAX,
      },
      secret: {
        type: "string",
        description: `A webhook's signing secret the receiver already has, ${EVENT_SECRET_MIN_LENGTH} to ${EVENT_SECRET_MAX_LENGTH} characters with no spaces. Leave it out to have one generated and returned once.`,
        minLength: EVENT_SECRET_MIN_LENGTH,
        maxLength: EVENT_SECRET_MAX_LENGTH,
      },
    }),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_events_set",
    title: "Change an event subscription",
    description:
      "Change an event subscription: turn it off or on (`enabled`; a paused one is sent no events, though everyapp_workspace_events_test still reaches it), replace the event types and patterns it takes (`events`; an empty list means every event), or rename it. A field left out keeps its value. Owners and admins.",
    inputSchema: objectWith(
      {
        subscription: SUBSCRIPTION,
        enabled: {
          type: "boolean",
          description: "false pauses it; true turns it back on.",
        },
        events: eventPatterns(
          "The event types and patterns it takes from now on, replacing the current list.",
        ),
        name: {
          type: "string",
          description: `The new name, 1 to ${EVENT_SUBSCRIPTION_NAME_MAX} characters.`,
          minLength: 1,
          maxLength: EVENT_SUBSCRIPTION_NAME_MAX,
        },
      },
      ["subscription"],
    ),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_events_remove",
    title: "Remove an event subscription",
    description:
      "Remove an event subscription: events stop going to it at once, and its signing secret goes with it. A built-in one (Cap alerts) is turned off instead, so the Gateway never recreates it behind the person's back, and the answer says so. Cannot be undone: needs confirm: true. Owners and admins.",
    inputSchema: objectWith({ subscription: SUBSCRIPTION, confirm: CONFIRM }, [
      "subscription",
      "confirm",
    ]),
    irreversible: true,
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_events_test",
    title: "Send a test event",
    description:
      "Send a test event (type `ping`) to one subscription, a paused one too, and wait for the first attempt. The answer says where the delivery stands: delivered, with the receiver's HTTP status (for an email subscription, how many owners and admins were mailed); or failed, with the status or the error and when the Gateway retries; or dead. Nothing goes to any other subscription. Owners and admins.",
    inputSchema: objectWith({ subscription: SUBSCRIPTION }, ["subscription"]),
  },
  {
    ...ADMIN_READ,
    name: "workspace_event_deliveries",
    title: "List event deliveries",
    description:
      "One page of the organization's event deliveries from the last 30 days, newest first: the event (id, type, its one-line summary, when), the subscription, the attempts, where it stands (pending, delivered, failed and retrying, or dead), the last HTTP status or error, and the next attempt. Never the request body. Only one subscription's with `subscription`, only dead ones with `dead: true`; page with `before` from the previous answer's `nextBefore`. Owners and admins.",
    inputSchema: objectWith({
      subscription: id(
        "Only this subscription's deliveries: its id (`sub_…`) or its name.",
      ),
      dead: {
        type: "boolean",
        description:
          "true for dead deliveries only: out of attempts, or refused for good (everyapp_workspace_event_redeliver sends one again).",
      },
      limit: {
        type: "integer",
        description: `Deliveries per page, 1 to ${WORKSPACE_EVENT_DELIVERIES_PAGE_MAX}. Default ${EVENT_DELIVERIES_LIMIT_DEFAULT}.`,
        minimum: 1,
        maximum: WORKSPACE_EVENT_DELIVERIES_PAGE_MAX,
        default: EVENT_DELIVERIES_LIMIT_DEFAULT,
      },
      before: {
        type: "string",
        description:
          "The previous page's `nextBefore`: the page continues with the deliveries older than that one.",
        minLength: 1,
        maxLength: EVENT_CURSOR_MAX,
      },
    }),
  },
  {
    ...ADMIN_WRITE,
    name: "workspace_event_redeliver",
    title: "Redeliver an event",
    description:
      "Send one failed or dead delivery again now, its retry schedule starting over, and answer where it stands after that attempt. A delivered one is left alone and the answer says so. Owners and admins.",
    inputSchema: objectWith(
      {
        delivery: id(
          "The delivery's id (`dlv_…`, from everyapp_workspace_event_deliveries).",
        ),
      },
      ["delivery"],
    ),
  },
  {
    risk: "read",
    minRole: "member",
    name: "my_tokens",
    title: "My personal access tokens",
    description:
      "List your own personal access tokens in this organization: id, name, prefix, scopes, the app it is bound to, when it was made, expires, was last used, and whether it is revoked. Never the token value. Any member.",
    inputSchema: NO_INPUT,
  },
  {
    risk: "write",
    minRole: "member",
    name: "revoke_token",
    title: "Revoke one of my tokens",
    description:
      "Revoke one of your own personal access tokens, by its id or its name. Any member.",
    inputSchema: objectWith(
      {
        token: id(
          "The token: its id or its name (from everyapp_my_tokens). A name several tokens share is refused; use the id.",
        ),
      },
      ["token"],
    ),
  },
  {
    risk: "read",
    minRole: "member",
    name: "my_connections",
    title: "My AI connections",
    description:
      "List the AI apps you connected to this Gateway over OAuth, in every organization: id, organization, client, which apps, read only or read & write, when made and last used. Any member.",
    inputSchema: NO_INPUT,
  },
  {
    risk: "write",
    minRole: "member",
    name: "revoke_connection",
    title: "Revoke one of my AI connections",
    description:
      "Revoke one of your own AI connections by its id (from everyapp_my_connections). Revoking the connection this call came through ends it on the next request. Any member.",
    inputSchema: objectWith({ connection: id("The connection's id.") }, [
      "connection",
    ]),
  },
  ...MCP_APP_TOOLS,
];
