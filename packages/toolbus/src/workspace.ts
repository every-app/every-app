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
 * No workspace tool returns a credential: `everyapp_workspace_invite`
 * says whether the invitation was mailed and never carries the link,
 * password resets go to the user's inbox, and tokens are listed and
 * revoked, never created (docs/design/2026-10-agent-parity.md, decision 2).
 */
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
      "Set or clear the organization's monthly cap on an app's provider calls (Admin → Usage): a whole number of calls, or null for unlimited. Owners and admins.",
    inputSchema: objectWith(
      {
        app: APP,
        cap: {
          type: ["integer", "null"],
          description:
            "Calls per month, 1 to 1,000,000,000; null for unlimited.",
          minimum: 1,
          maximum: MONTHLY_CAP_MAX,
        },
      },
      ["app", "cap"],
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
      "What the organization's apps spent in a UTC month: per app, per member and per provider or capability, with each app's monthly cap. Owners and admins.",
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
];
