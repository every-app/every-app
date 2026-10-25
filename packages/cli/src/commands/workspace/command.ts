import { buildCommand, buildRouteMap } from "@stricli/core";
import { ACTIVITY_PAGE_MAX, MONTH, MONTHLY_CALL_CAP_MAX, appName } from "@/lib/gateway/workspace";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, orgFlag, verboseFlag } from "../flags";

/** Every workspace command: where the Gateway is, which organization, and how to print. */
const workspaceFlags = {
  org: orgFlag,
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

/**
 * The flags of `rename` and `role`, which act on the install organization
 * (the UI review thread's commands): the Gateway's, and the output's.
 */
const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

/** A member's role in the workspace, as `workspace role` sets it. */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function parseWorkspaceRole(value: string): WorkspaceRole {
  const role = WORKSPACE_ROLES.find((name) => name === value.trim().toLowerCase());
  if (!role) throw new Error("Use owner, admin or member.");
  return role;
}

const yesFlag = (what: string) =>
  ({ kind: "boolean", brief: `${what} without asking (needed where nobody is at a terminal)`, optional: true }) as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email address, trimmed and lowercased; anything else is refused before the command runs. */
function parseEmail(input: string): string {
  const value = input.trim().toLowerCase();
  if (!EMAIL.test(value)) throw new Error(`${input} isn't an email address`);
  return value;
}

const userParameter = {
  placeholder: "email",
  brief: "The member, by email or user id (workspace users lists them)",
  parse: String,
} as const;

const appParameter = {
  placeholder: "app",
  brief: "The app, by id (crm) or row id (workspace apps lists them)",
  parse: String,
} as const;

const groupParameter = {
  placeholder: "group",
  brief: "The group, by name or grp_ id (workspace groups lists them)",
  parse: String,
} as const;

const invitationParameter = {
  placeholder: "email|id",
  brief: "The pending invitation, by invited email or id (workspace users lists them)",
  parse: String,
} as const;

/** `--add`, `--remove` and `--set`: how a list of members or apps changes. */
const listChangeFlags = (what: string, placeholder: string) =>
  ({
    add: {
      kind: "parsed",
      parse: String,
      variadic: true,
      optional: true,
      placeholder,
      brief: `Add ${what} (repeat for several)`,
    },
    remove: {
      kind: "parsed",
      parse: String,
      variadic: true,
      optional: true,
      placeholder,
      brief: `Remove ${what} (repeat for several)`,
    },
    set: {
      kind: "parsed",
      parse: String,
      variadic: true,
      optional: true,
      placeholder,
      brief: `Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)`,
    },
  }) as const;

const showCommand = buildCommand({
  loader: async () => (await import(".")).show,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: workspaceFlags },
  docs: {
    brief: "The organization: its owners, whether it can send mail, and how many members, invitations, groups and apps it has",
    fullDescription: [
      "Nothing is changed. Email counts as configured when the Gateway settings EMAIL_FROM and a",
      "provider key are set, which is what invitations need to be mailed from the Gateway (this",
      "command prints links instead either way).",
      "",
      `Example:\n  ${CLI} workspace show --json`,
    ].join("\n"),
  },
});

const usersCommand = buildCommand({
  loader: async () => (await import(".")).users,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: workspaceFlags },
  docs: {
    brief: "The members with their role and state, then the pending invitations",
    fullDescription: [
      "Nothing is changed. A deactivated member is listed as such; a pending invitation with when",
      "it expires.",
      "",
      `Example:\n  ${CLI} workspace users`,
    ].join("\n"),
  },
});

const inviteCommand = buildCommand({
  loader: async () => (await import(".")).invite,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ placeholder: "email", brief: "The address to invite", parse: parseEmail }],
    },
    flags: {
      role: {
        kind: "enum",
        values: ["member", "admin"],
        default: "member",
        brief: "The role they join with",
      },
      ...workspaceFlags,
    },
  },
  docs: {
    brief: "Invite someone by email and print the link to send them (the Gateway mails nothing from here)",
    fullDescription: [
      "Makes a pending invitation (72 hours, single use, only for an account with that email) in",
      "your name: your Cloudflare login's email must be a member of the organization. Prints",
      "<gateway>/accept-invitation?token=einv_…, which is the invitation's only secret: hand it to",
      "the person yourself. The Gateway mails invitations only from Admin → Users.",
      "",
      "Examples:",
      `  ${CLI} workspace invite ann@example.com`,
      `  ${CLI} workspace invite ann@example.com --role admin --json`,
    ].join("\n"),
  },
});

const inviteLinkCommand = buildCommand({
  loader: async () => (await import(".")).inviteLink,
  parameters: { positional: { kind: "tuple", parameters: [invitationParameter] }, flags: workspaceFlags },
  docs: {
    brief: "Print a new link for a pending invitation (earlier links keep working until it is used)",
    fullDescription: [
      "The link's token is new each time and stored only as its hash. Every link of an invitation",
      "stops working once it is accepted, canceled or expired.",
      "",
      `Example:\n  ${CLI} workspace invite-link ann@example.com`,
    ].join("\n"),
  },
});

const uninviteCommand = buildCommand({
  loader: async () => (await import(".")).uninvite,
  parameters: { positional: { kind: "tuple", parameters: [invitationParameter] }, flags: workspaceFlags },
  docs: {
    brief: "Cancel a pending invitation: its links stop working",
    fullDescription: `Example:\n  ${CLI} workspace uninvite ann@example.com`,
  },
});

const deactivateCommand = buildCommand({
  loader: async () => (await import(".")).deactivate,
  parameters: { positional: { kind: "tuple", parameters: [userParameter] }, flags: workspaceFlags },
  docs: {
    brief: "Lock a member out everywhere: no sign-in, every session ended, their tokens and AI connections revoked",
    fullDescription: [
      "The account stays, listed as deactivated, and the ban holds in every organization it belongs",
      "to; workspace reactivate lifts it (revoked tokens and connections stay revoked). An",
      "organization always keeps an owner who can act, and the ban is account-wide, so the last",
      "live owner of this organization, or of any other they own, can't be deactivated",
      "(LAST_OWNER, naming the organization): a deactivated owner doesn't count.",
      "",
      `Example:\n  ${CLI} workspace deactivate ann@example.com`,
    ].join("\n"),
  },
});

const reactivateCommand = buildCommand({
  loader: async () => (await import(".")).reactivate,
  parameters: { positional: { kind: "tuple", parameters: [userParameter] }, flags: workspaceFlags },
  docs: {
    brief: "Lift a deactivation: they can sign in again (revoked tokens and connections stay revoked)",
    fullDescription: `Example:\n  ${CLI} workspace reactivate ann@example.com`,
  },
});

const removeCommand = buildCommand({
  loader: async () => (await import(".")).remove,
  parameters: {
    positional: { kind: "tuple", parameters: [userParameter] },
    flags: { yes: yesFlag("Remove"), ...workspaceFlags },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Remove a member from the organization, and their account when it belongs to no other",
    fullDescription: [
      "Deletes the membership, their app grants and places in groups, and revokes their personal",
      "access tokens for the organization and AI connections to it, in one write. The account goes",
      "too when it belongs to no other organization (a hosted Gateway keeps accounts). Someone",
      "Cloudflare Access would let straight back in (the Gateway has CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS",
      "or CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN set) is deactivated and kept listed instead, as the",
      "Gateway's own Delete does. Owners are peers, and the organization always keeps one who can",
      "act: the last owner who isn't deactivated can't be removed (LAST_OWNER). Asks first at a",
      "terminal; elsewhere it needs --yes.",
      "",
      `Example:\n  ${CLI} workspace remove ann@example.com --yes --json`,
    ].join("\n"),
  },
});

const resetLinkCommand = buildCommand({
  loader: async () => (await import(".")).resetLink,
  parameters: { positional: { kind: "tuple", parameters: [userParameter] }, flags: workspaceFlags },
  docs: {
    brief: "Print a one-hour, single-use password-reset link to hand to a member",
    fullDescription: [
      "Better Auth's own reset token, consumed by the Gateway's /reset-password page: whoever opens",
      "it sets the account's password, so hand it to the person yourself. Only for an active",
      "account (PASSWORD_RESET_REQUIRES_ACTIVE_USER) that belongs to this organization alone",
      "(USER_IN_OTHER_ORGANIZATION: a password is account-wide, so the Gateway's rule holds here",
      "too). Password sign-in must be on (EMAIL_PASSWORD_SIGN_IN) for the page to take it. An",
      "owner's too: the operator is root (the Gateway refuses that to admins and other owners),",
      "which is the way back in for a sole owner who lost their password.",
      "",
      `Example:\n  ${CLI} workspace reset-link ann@example.com`,
    ].join("\n"),
  },
});

const groupsCommand = buildCommand({
  loader: async () => (await import("./groups")).groups,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: workspaceFlags },
  docs: {
    brief: "The groups, with how many members and apps each has",
    fullDescription: `Nothing is changed.\n\nExample:\n  ${CLI} workspace groups`,
  },
});

const descriptionFlag = {
  kind: "parsed",
  parse: String,
  optional: true,
  placeholder: "text",
  brief: "What the group is for (empty text clears it)",
} as const;

const groupCreateCommand = buildCommand({
  loader: async () => (await import("./groups")).groupCreate,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ placeholder: "name", brief: "The group's name, 1 to 60 characters, unique in the organization", parse: String }],
    },
    flags: { description: descriptionFlag, ...workspaceFlags },
  },
  docs: {
    brief: "Make a group: a named set of members that apps are granted to as one",
    fullDescription: [
      "A member opens an app when they hold a grant to it, or belong to a group that does.",
      "",
      `Example:\n  ${CLI} workspace group create Sales --description "The sales team"`,
    ].join("\n"),
  },
});

const groupSetCommand = buildCommand({
  loader: async () => (await import("./groups")).groupSet,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: {
      name: { kind: "parsed", parse: String, optional: true, placeholder: "name", brief: "A new name" },
      description: descriptionFlag,
      ...workspaceFlags,
    },
  },
  docs: {
    brief: "Rename or describe a group",
    fullDescription: `Example:\n  ${CLI} workspace group set Sales --name "Sales and marketing"`,
  },
});

const groupDeleteCommand = buildCommand({
  loader: async () => (await import("./groups")).groupDelete,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: { yes: yesFlag("Delete"), ...workspaceFlags },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Delete a group: what it granted ends with it",
    fullDescription: [
      "Its members keep their direct grants and their other groups. Asks first at a terminal;",
      "elsewhere it needs --yes.",
      "",
      `Example:\n  ${CLI} workspace group delete Sales --yes`,
    ].join("\n"),
  },
});

const groupMembersCommand = buildCommand({
  loader: async () => (await import("./groups")).groupMembers,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: { ...listChangeFlags("a member, by email or user id", "email"), ...workspaceFlags },
  },
  docs: {
    brief: "Who is in a group; --add, --remove or --set change it",
    fullDescription: [
      "Without a change flag, lists every member of the organization and whether they are in the",
      "group. Only members of the organization can be in its groups.",
      "",
      "Examples:",
      `  ${CLI} workspace group members Sales`,
      `  ${CLI} workspace group members Sales --add ann@example.com --add bob@example.com`,
      `  ${CLI} workspace group members Sales --set ann@example.com`,
    ].join("\n"),
  },
});

const groupAppsCommand = buildCommand({
  loader: async () => (await import("./groups")).groupApps,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: { ...listChangeFlags("an app, by id", "app"), ...workspaceFlags },
  },
  docs: {
    brief: "Which apps a group opens; --add, --remove or --set change it",
    fullDescription: [
      "Without a change flag, lists the organization's own apps and whether the group opens each.",
      "A shared app opens for everyone already and is never granted to a group.",
      "",
      "Examples:",
      `  ${CLI} workspace group apps Sales`,
      `  ${CLI} workspace group apps Sales --add crm`,
    ].join("\n"),
  },
});

const appsCommand = buildCommand({
  loader: async () => (await import("./apps")).apps,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: workspaceFlags },
  docs: {
    brief: "Every app with who can open it, whether everyone can, its state and what it still needs set",
    fullDescription: [
      "The admin's view (Admin → Apps); everyapp status has the operator's. Nothing is changed.",
      "",
      `Example:\n  ${CLI} workspace apps --json`,
    ].join("\n"),
  },
});

const appSetCommand = buildCommand({
  loader: async () => (await import("./apps")).appSet,
  parameters: {
    positional: { kind: "tuple", parameters: [appParameter] },
    flags: {
      name: { kind: "parsed", parse: appName, optional: true, placeholder: "name", brief: "The name the app library shows (1 to 255 characters)" },
      description: { kind: "parsed", parse: String, optional: true, placeholder: "text", brief: "The description under it" },
      everyone: {
        kind: "enum",
        values: ["on", "off"],
        optional: true,
        brief: "Available to everyone: on grants every member now and every future member on joining; off keeps existing access",
      },
      ...workspaceFlags,
    },
  },
  docs: {
    brief: "Change an app's name, description or whether everyone can open it",
    fullDescription: [
      "Catalog metadata only: the next deploy sets the name and description again from",
      "everyapp.config.ts.",
      "",
      "Examples:",
      `  ${CLI} workspace app set crm --everyone on`,
      `  ${CLI} workspace app set crm --name "Open CRM" --description "Contacts and deals"`,
    ].join("\n"),
  },
});

const appAccessCommand = buildCommand({
  loader: async () => (await import("./apps")).appAccess,
  parameters: {
    positional: { kind: "tuple", parameters: [appParameter] },
    flags: { ...listChangeFlags("a member's direct grant, by email or user id", "email"), ...workspaceFlags },
  },
  docs: {
    brief: "Who can open an app; --add, --remove or --set change the direct grants",
    fullDescription: [
      "Without a change flag, lists every member with whether they hold a direct grant and which",
      "groups open the app for them. A change touches direct grants only; what a group grants",
      "stays (workspace group apps). A shared app's access can't be changed.",
      "",
      "Examples:",
      `  ${CLI} workspace app access crm`,
      `  ${CLI} workspace app access crm --add ann@example.com`,
      `  ${CLI} workspace app access crm --set ann@example.com --set bob@example.com --json`,
    ].join("\n"),
  },
});

/**
 * `<n|off>`: a whole number of calls, or `off` (never null: an optional
 * positional's type drops null along with undefined).
 */
function parseCap(input: string): number | "off" {
  const value = input.trim().toLowerCase();
  if (value === "off" || value === "none") return "off";
  if (!/^\d+$/.test(value)) throw new Error(`a cap is a whole number of calls per month, or off (not ${input})`);
  const cap = Number(value);
  if (cap < 1 || cap > MONTHLY_CALL_CAP_MAX) {
    throw new Error(`a cap is from 1 to ${MONTHLY_CALL_CAP_MAX.toLocaleString("en-US")} calls per month`);
  }
  return cap;
}

const appCapCommand = buildCommand({
  loader: async () => (await import("./apps")).appCap,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { ...appParameter, brief: "The app, by id or row id: the organization's own, or a shared one" },
        {
          placeholder: "n|off",
          brief: "Provider calls per UTC month (1 to 1,000,000,000), or off for no cap of its own (the workspace default applies); left out with --unlimited",
          parse: parseCap,
          optional: true,
        },
      ],
    },
    flags: {
      unlimited: {
        kind: "boolean",
        optional: true,
        brief: "No cap at all, even with a workspace default (instead of a number or off)",
      },
      ...workspaceFlags,
    },
  },
  docs: {
    brief: "Cap an app's provider calls per month, lift its own cap, or exempt it from the workspace default",
    fullDescription: [
      "An app has a cap of its own (a number), no cap whatever the workspace default",
      "(--unlimited), or neither (off): the default set with workspace cap default binds it,",
      "and without one it is uncapped. Past the cap that binds it, a provider tool answers a",
      "tool error naming it and an app's brokered call gets 429 app_monthly_cap_exceeded until",
      "the next UTC month. Binds within seconds. --unlimited and a number or off together are",
      "refused (INVALID_VALUE); on a Gateway from before the workspace default, --unlimited is",
      "refused (GATEWAY_PREDATES_DEFAULT_CAPS) and a number or off still work.",
      "",
      "Examples:",
      `  ${CLI} workspace app cap crm 5000`,
      `  ${CLI} workspace app cap crm off`,
      `  ${CLI} workspace app cap crm --unlimited`,
    ].join("\n"),
  },
});

const capDefaultCommand = buildCommand({
  loader: async () => (await import("./apps")).capDefault,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { placeholder: "n|off", brief: "Provider calls per UTC month (1 to 1,000,000,000) for every app without its own cap, or off for no default", parse: parseCap },
      ],
    },
    flags: workspaceFlags,
  },
  docs: {
    brief: "Set or clear the workspace default cap: what binds every app without a cap or --unlimited of its own",
    fullDescription: [
      "The same setting as Manage workspace → Usage → Default monthly cap. An app's own cap, or",
      "its --unlimited, stays. The Gateway holds every app without one to it within 30 seconds;",
      "past it, a provider tool answers a tool error naming the cap and an app's brokered call",
      "gets 429 app_monthly_cap_exceeded until the next UTC month. As in the Gateway, the",
      "workspace's first cap makes the built-in Cap alerts subscription, and a default set,",
      "raised or removed queues cap.raised (a lowered one doesn't). Refused on a Gateway from",
      "before the workspace default (GATEWAY_PREDATES_DEFAULT_CAPS): run update first.",
      "",
      "Examples:",
      `  ${CLI} workspace cap default 1000`,
      `  ${CLI} workspace cap default off --json`,
    ].join("\n"),
  },
});

/** `--month YYYY-MM`, checked before the command runs. */
function parseMonth(input: string): string {
  const value = input.trim();
  if (!MONTH.test(value)) throw new Error(`a month is written YYYY-MM (not ${input})`);
  return value;
}

const usageCommand = buildCommand({
  loader: async () => (await import("./activity")).usage,
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      month: {
        kind: "parsed",
        parse: parseMonth,
        optional: true,
        placeholder: "YYYY-MM",
        brief: "The UTC month (default: this one)",
      },
      ...workspaceFlags,
    },
  },
  docs: {
    brief: "What the apps spent in a month: per app (with the cap that binds it), per member and per provider",
    fullDescription: [
      "Provider calls, failures, tokens and provider-reported cost, counted at the Gateway after a",
      "provider answered, and allowed MCP tool calls from the audit trail. Every callable app is",
      "listed, with zeros in a month it made no call, its own cap, the cap that binds it and where",
      "it comes from (its own, or the workspace default), whether it is exempt (--unlimited) and",
      "whether it is paused this month; the workspace default cap comes with it. Nothing is",
      "changed. Refused on a Gateway from before the workspace default",
      "(GATEWAY_PREDATES_DEFAULT_CAPS): run update first.",
      "",
      `Example:\n  ${CLI} workspace usage --month 2026-10 --json`,
    ].join("\n"),
  },
});

/** `--since <time>`: an ISO 8601 time, or a date, to milliseconds. */
function parseSince(input: string): number {
  const ms = Date.parse(input.trim());
  if (Number.isNaN(ms)) throw new Error(`a time is written like 2026-10-24 or 2026-10-24T09:00:00Z (not ${input})`);
  return ms;
}

/** `--limit <n>`: 1 to the page the Gateway lists. */
function parseLimit(input: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < 1 || value > ACTIVITY_PAGE_MAX) {
    throw new Error(`a limit is a whole number from 1 to ${ACTIVITY_PAGE_MAX}`);
  }
  return value;
}

/** `--before <cursor>`: the previous page's `nextBefore`, as `<ms>:<id>`. */
function parseCursor(input: string): { createdAt: number; id: string } {
  const match = /^(\d+):(.+)$/.exec(input.trim());
  if (!match) throw new Error("a cursor is the previous page's nextBefore, written <createdAt>:<id>");
  return { createdAt: Number(match[1]), id: match[2]! };
}

const activityCommand = buildCommand({
  loader: async () => (await import("./activity")).activity,
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      app: { kind: "parsed", parse: String, optional: true, placeholder: "app", brief: "Calls on this app only, by id or row id" },
      user: { kind: "parsed", parse: String, optional: true, placeholder: "email", brief: "Calls by this member only, by email or user id" },
      decision: { kind: "enum", values: ["allowed", "blocked"], optional: true, brief: "Allowed or blocked calls only" },
      risk: { kind: "enum", values: ["read", "write", "destructive"], optional: true, brief: "Tools of this risk only" },
      since: { kind: "parsed", parse: parseSince, optional: true, placeholder: "time", brief: "Calls at or after this time (ISO 8601, UTC)" },
      limit: { kind: "parsed", parse: parseLimit, optional: true, placeholder: "n", brief: `Rows per page, 1 to ${ACTIVITY_PAGE_MAX} (default 50)` },
      before: { kind: "parsed", parse: parseCursor, optional: true, placeholder: "cursor", brief: "The next page: the previous page's nextBefore, as <createdAt>:<id>" },
      ...workspaceFlags,
    },
  },
  docs: {
    brief: "The tool-call audit trail, newest first: who called which tool on which app, and what came of it",
    fullDescription: [
      "Never the arguments or the result: the trail holds neither. One page at a time; --json",
      "carries data.nextBefore for the next page. Nothing is changed.",
      "",
      "Examples:",
      `  ${CLI} workspace activity --limit 20`,
      `  ${CLI} workspace activity --app crm --decision blocked --since 2026-10-24 --json`,
    ].join("\n"),
  },
});

const userFlag = {
  kind: "parsed",
  parse: String,
  optional: true,
  placeholder: "email",
  brief: "One member's only, by email or user id",
} as const;

const tokensCommand = buildCommand({
  loader: async () => (await import("./activity")).tokens,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: { user: userFlag, all: { kind: "boolean", optional: true, brief: "Revoked and expired tokens too" }, ...workspaceFlags } },
  docs: {
    brief: "Every member's personal access tokens for the organization (never a token's value)",
    fullDescription: [
      "Tokens are created in Admin → Tokens only: their hash is keyed by a Gateway secret the CLI",
      "never holds. Nothing is changed.",
      "",
      `Example:\n  ${CLI} workspace tokens --user ann@example.com`,
    ].join("\n"),
  },
});

const tokenRevokeCommand = buildCommand({
  loader: async () => (await import("./activity")).tokenRevoke,
  parameters: {
    positional: { kind: "tuple", parameters: [{ placeholder: "id", brief: "The token's id (workspace tokens lists them)", parse: String }] },
    flags: workspaceFlags,
  },
  docs: {
    brief: "Revoke a personal access token: it stops working on its next request",
    fullDescription: `Example:\n  ${CLI} workspace token revoke 3f2a…`,
  },
});

const connectionsCommand = buildCommand({
  loader: async () => (await import("./activity")).connections,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: { user: userFlag, ...workspaceFlags } },
  docs: {
    brief: "Every member's AI connections to the organization: which AI app, which apps it may use, read or write",
    fullDescription: [
      "A connection is an OAuth client (Claude, Cursor, …) a member connected to the Gateway's /mcp.",
      "Nothing is changed.",
      "",
      `Example:\n  ${CLI} workspace connections`,
    ].join("\n"),
  },
});

const connectionRevokeCommand = buildCommand({
  loader: async () => (await import("./activity")).connectionRevoke,
  parameters: {
    positional: { kind: "tuple", parameters: [{ placeholder: "id", brief: "The connection's id (workspace connections lists them)", parse: String }] },
    flags: workspaceFlags,
  },
  docs: {
    brief: "Revoke an AI connection: the client is out on its next request",
    fullDescription: `Example:\n  ${CLI} workspace connection revoke mcpc_…`,
  },
});

const groupRoutes = buildRouteMap({
  routes: {
    create: groupCreateCommand,
    set: groupSetCommand,
    delete: groupDeleteCommand,
    members: groupMembersCommand,
    apps: groupAppsCommand,
  },
  docs: { brief: "Make, change or delete a group, and set its members and apps" },
});

const appRoutes = buildRouteMap({
  routes: { set: appSetCommand, access: appAccessCommand, cap: appCapCommand },
  docs: { brief: "Change an app's listing, who can open it, and its monthly cap" },
});

const capRoutes = buildRouteMap({
  routes: { default: capDefaultCommand },
  docs: { brief: "The workspace default cap on every app's provider calls" },
});

const tokenRoutes = buildRouteMap({
  routes: { revoke: tokenRevokeCommand },
  docs: { brief: "Revoke a personal access token" },
});

const connectionRoutes = buildRouteMap({
  routes: { revoke: connectionRevokeCommand },
  docs: { brief: "Revoke an AI connection" },
});

const renameCommand = buildCommand({
  loader: async () => {
    const { rename } = await import(".");
    return rename;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "name",
          brief: "The new name: 1 to 64 characters, no line breaks (quote one with spaces)",
          parse: String,
        },
      ],
    },
    flags: connectFlags,
  },
  docs: {
    brief: "Rename the workspace: the name members see in the organization switcher and in invitations",
    fullDescription: [
      "The workspace is the Gateway's organization: the one the setup claim made, named after",
      "its owner. This gives it the name you want; the same rename is under Manage workspace in",
      "the Gateway, for owners and admins. Nothing is built or deployed: the Gateway reads the",
      "name live, and each member sees it on their next page.",
      "",
      "Before the Gateway is claimed there is no workspace to rename (WORKSPACE_NOT_CLAIMED):",
      "claim it in a browser first.",
      "",
      "Examples:",
      `  ${CLI} workspace rename 'Acme Corp'`,
      `  ${CLI} workspace rename 'Acme Corp' --json`,
    ].join("\n"),
  },
});

const roleCommand = buildCommand({
  loader: async () => {
    const { role } = await import(".");
    return role;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "email",
          brief: "The member's email address, as Manage workspace → Users lists it",
          parse: String,
        },
        {
          placeholder: "owner|admin|member",
          brief: "The role to give them",
          parse: parseWorkspaceRole,
        },
      ],
    },
    flags: connectFlags,
  },
  docs: {
    brief: "Set a member's role: owner, admin or member",
    fullDescription: [
      "The workspace is the Gateway's own organization, the one its owner claimed. Owners are",
      "peers: any owner can make a member or an admin an owner, and change another owner's",
      "role, from Manage workspace → Users or with this command under the Cloudflare login.",
      "The workspace always keeps at least one owner, so the last owner's role is never",
      "changed (LAST_OWNER): make someone else an owner first. Deactivated owners don't",
      "count here, so this command can't leave a workspace whose only owner is locked out",
      "(the Gateway's own Users page needs no such rule: a deactivated owner can't act, and",
      "only an owner acts on an owner). Only a member can be given a role; someone still",
      "invited isn't one yet (MEMBER_NOT_FOUND). The Gateway picks up the change within 30",
      "seconds.",
      "",
      "Examples:",
      `  ${CLI} workspace role sam@example.com owner`,
      `  ${CLI} workspace role sam@example.com member --json`,
    ].join("\n"),
  },
});

export const workspaceRoutes = buildRouteMap({
  routes: {
    show: showCommand,
    rename: renameCommand,
    users: usersCommand,
    role: roleCommand,
    invite: inviteCommand,
    "invite-link": inviteLinkCommand,
    uninvite: uninviteCommand,
    deactivate: deactivateCommand,
    reactivate: reactivateCommand,
    remove: removeCommand,
    "reset-link": resetLinkCommand,
    groups: groupsCommand,
    group: groupRoutes,
    apps: appsCommand,
    app: appRoutes,
    cap: capRoutes,
    usage: usageCommand,
    activity: activityCommand,
    tokens: tokensCommand,
    token: tokenRoutes,
    connections: connectionsCommand,
    connection: connectionRoutes,
  },
  docs: {
    brief: "Manage the workspace from the terminal: members, invitations, groups, app access, caps, usage, activity, tokens and AI connections",
  },
});
