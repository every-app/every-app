/**
 * `everyapp workspace …`: Manage workspace from the terminal. Each command
 * but `reset-link` and `invite-link` is one of the Gateway's own tools
 * (`everyapp_workspace_*`, `everyapp_my_*`, `everyapp_revoke_*`), run as you
 * through its admin API (lib/gatewayApi; `everyapp call` reaches the same
 * tools by name), so the Gateway's services decide every rule. Those two
 * print a link, which the tools never return: the operator's way back in
 * for a locked-out owner, and an invite link for a Gateway that sends no
 * email, written into the Gateway's D1 under the Cloudflare login (ADR-0003,
 * "What the CLI writes").
 */
import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, apiFlags, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

/** A member's role in the workspace, as `workspace role` sets it. */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

function parseWorkspaceRole(value: string): WorkspaceRole {
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
    add: { kind: "parsed", parse: String, variadic: true, optional: true, placeholder, brief: `Add ${what} (repeat for several)` },
    remove: { kind: "parsed", parse: String, variadic: true, optional: true, placeholder, brief: `Remove ${what} (repeat for several)` },
    set: {
      kind: "parsed",
      parse: String,
      variadic: true,
      optional: true,
      placeholder,
      brief: "Replace the whole list with these (repeat for several; alone, with neither --add nor --remove)",
    },
  }) as const;

/** A command's help: its lines, then the Gateway tool (or tools) it is. */
const docs = (tool: string, lines: readonly string[]) => {
  const tools = tool.split(", ");
  return [
    ...lines,
    ...(lines.length ? [""] : []),
    tools.length === 1
      ? `The Gateway tool: ${tool} (${CLI} call ${tool}).`
      : `The Gateway tools: ${tools.join(" to read, ")} to change.`,
  ].join("\n");
};

const noArgs = { kind: "tuple", parameters: [] } as const;

const showCommand = buildCommand({
  loader: async () => (await import(".")).show,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "The organization: your role, whether it can send mail, and how many members, invitations, groups and apps it has",
    fullDescription: docs("everyapp_workspace_show", [`Example:\n  ${CLI} workspace show --json`]),
  },
});

const usersCommand = buildCommand({
  loader: async () => (await import(".")).users,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "The members with their role and state, then the pending invitations",
    fullDescription: docs("everyapp_workspace_users", [`Example:\n  ${CLI} workspace users`]),
  },
});

const inviteCommand = buildCommand({
  loader: async () => (await import(".")).invite,
  parameters: {
    positional: { kind: "tuple", parameters: [{ placeholder: "email", brief: "The address to invite", parse: parseEmail }] },
    flags: {
      role: { kind: "enum", values: ["member", "admin"], default: "member", brief: "The role they join with" },
      ...apiFlags,
    },
  },
  docs: {
    brief: "Invite someone by email: the Gateway mails the invitation when it can send email",
    fullDescription: docs("everyapp_workspace_invite", [
      "The answer says whether it was mailed. The tool never returns the link: where the Gateway",
      `sends no email, ${CLI} workspace invite-link <email> prints one (under your Cloudflare login),`,
      "or copy it from Admin → Users.",
      "",
      "Examples:",
      `  ${CLI} workspace invite ann@example.com`,
      `  ${CLI} workspace invite ann@example.com --role admin --json`,
    ]),
  },
});

const inviteLinkCommand = buildCommand({
  loader: async () => (await import("./links")).inviteLink,
  parameters: {
    positional: { kind: "tuple", parameters: [invitationParameter] },
    flags: { gateway: gatewayFlag, "account-id": accountFlag, json: jsonFlag, verbose: verboseFlag },
  },
  docs: {
    brief: "Print a new link for a pending invitation, under the Cloudflare login (for a Gateway that sends no email)",
    fullDescription: [
      "The CLI twin of Admin → Users → Copy invite link: a new invite link for a pending, unexpired",
      "invitation of the install organization, written into the Gateway's D1 with your Cloudflare",
      "login. The Gateway's tools never return a link to their caller, so this is one of the two",
      "workspace commands that write D1 (ADR-0003). Earlier links keep working until the invitation",
      "is accepted or canceled. Hand the link to the person yourself.",
      "",
      "Examples:",
      `  ${CLI} workspace invite ann@example.com`,
      `  ${CLI} workspace invite-link ann@example.com`,
    ].join("\n"),
  },
});

const uninviteCommand = buildCommand({
  loader: async () => (await import(".")).uninvite,
  parameters: { positional: { kind: "tuple", parameters: [invitationParameter] }, flags: apiFlags },
  docs: {
    brief: "Cancel a pending invitation: its links stop working",
    fullDescription: docs("everyapp_workspace_uninvite", [`Example:\n  ${CLI} workspace uninvite ann@example.com`]),
  },
});

const roleCommand = buildCommand({
  loader: async () => (await import(".")).role,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { ...userParameter, brief: "The member, by email or user id" },
        { placeholder: "owner|admin|member", brief: "The role to give them", parse: parseWorkspaceRole },
      ],
    },
    flags: apiFlags,
  },
  docs: {
    brief: "Set a member's role: owner, admin or member",
    fullDescription: docs("everyapp_workspace_role", [
      "The Gateway's rules: only an owner changes an admin or an owner, or makes one; nobody",
      "changes their own role; the last owner is never demoted.",
      "",
      "Examples:",
      `  ${CLI} workspace role sam@example.com owner`,
      `  ${CLI} workspace role sam@example.com member --json`,
    ]),
  },
});

const deactivateCommand = buildCommand({
  loader: async () => (await import(".")).deactivate,
  parameters: { positional: { kind: "tuple", parameters: [userParameter] }, flags: apiFlags },
  docs: {
    brief: "Lock a member out everywhere: no sign-in, every session ended, their tokens and AI connections revoked",
    fullDescription: docs("everyapp_workspace_deactivate", [`Example:\n  ${CLI} workspace deactivate ann@example.com`]),
  },
});

const reactivateCommand = buildCommand({
  loader: async () => (await import(".")).reactivate,
  parameters: { positional: { kind: "tuple", parameters: [userParameter] }, flags: apiFlags },
  docs: {
    brief: "Lift a deactivation: they can sign in again (revoked tokens and connections stay revoked)",
    fullDescription: docs("everyapp_workspace_reactivate", [`Example:\n  ${CLI} workspace reactivate ann@example.com`]),
  },
});

const removeCommand = buildCommand({
  loader: async () => (await import(".")).remove,
  parameters: {
    positional: { kind: "tuple", parameters: [userParameter] },
    flags: { yes: yesFlag("Remove"), ...apiFlags },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Remove a member from the organization, and their account when it belongs to no other",
    fullDescription: docs("everyapp_workspace_remove", [
      "Asks first at a terminal; elsewhere it needs --yes.",
      "",
      `Example:\n  ${CLI} workspace remove ann@example.com --yes --json`,
    ]),
  },
});

const resetEmailCommand = buildCommand({
  loader: async () => (await import(".")).resetEmail,
  parameters: { positional: { kind: "tuple", parameters: [userParameter] }, flags: apiFlags },
  docs: {
    brief: "Mail a member a password-reset link (the link goes to their inbox, never to you)",
    fullDescription: docs("everyapp_workspace_reset_email", [`Example:\n  ${CLI} workspace reset-email ann@example.com`]),
  },
});

const resetLinkCommand = buildCommand({
  loader: async () => (await import("./links")).resetLink,
  parameters: {
    positional: { kind: "tuple", parameters: [{ ...userParameter, brief: "The member of the install organization, by email" }] },
    flags: { gateway: gatewayFlag, "account-id": accountFlag, json: jsonFlag, verbose: verboseFlag },
  },
  docs: {
    brief: "The way back in: print a one-hour, single-use password-reset link for a member, under the Cloudflare login",
    fullDescription: [
      "For an owner locked out of the Gateway (a lost password, no email sending): Better Auth's",
      "own reset token, written into the Gateway's D1 with your Cloudflare login, consumed by the",
      "Gateway's /reset-password page. Whoever opens it sets the account's password, so hand it",
      "to the person yourself. Only for an active member of the install organization that belongs",
      "to no other (USER_IN_OTHER_ORGANIZATION: a password is account-wide). Password sign-in must",
      "be on (EMAIL_PASSWORD_SIGN_IN). Everything else here but invite-link goes through the Gateway",
      `as you; this is the recovery path that can't (ADR-0003). A member who can sign in uses ${CLI} workspace reset-email.`,
      "",
      `Example:\n  ${CLI} workspace reset-link owner@example.com`,
    ].join("\n"),
  },
});

const groupsCommand = buildCommand({
  loader: async () => (await import(".")).groups,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "The groups, with how many members and apps each has",
    fullDescription: docs("everyapp_workspace_groups", [`Example:\n  ${CLI} workspace groups`]),
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
  loader: async () => (await import(".")).groupCreate,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ placeholder: "name", brief: "The group's name, 1 to 60 characters, unique in the organization", parse: String }],
    },
    flags: { description: descriptionFlag, ...apiFlags },
  },
  docs: {
    brief: "Make a group: a named set of members that apps are granted to as one",
    fullDescription: docs("everyapp_workspace_group_create", [
      `Example:\n  ${CLI} workspace group create Sales --description "The sales team"`,
    ]),
  },
});

const groupSetCommand = buildCommand({
  loader: async () => (await import(".")).groupSet,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: {
      name: { kind: "parsed", parse: String, optional: true, placeholder: "name", brief: "A new name" },
      description: descriptionFlag,
      ...apiFlags,
    },
  },
  docs: {
    brief: "Rename or describe a group",
    fullDescription: docs("everyapp_workspace_group_set", [`Example:\n  ${CLI} workspace group set Sales --name "Sales and marketing"`]),
  },
});

const groupDeleteCommand = buildCommand({
  loader: async () => (await import(".")).groupDelete,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: { yes: yesFlag("Delete"), ...apiFlags },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Delete a group: what it granted ends with it",
    fullDescription: docs("everyapp_workspace_group_delete", [
      "Asks first at a terminal; elsewhere it needs --yes.",
      "",
      `Example:\n  ${CLI} workspace group delete Sales --yes`,
    ]),
  },
});

const groupMembersCommand = buildCommand({
  loader: async () => (await import(".")).groupMembers,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: { ...listChangeFlags("a member, by email or user id", "email"), ...apiFlags },
  },
  docs: {
    brief: "Who is in a group; --add, --remove or --set change it",
    fullDescription: docs("everyapp_workspace_group_members, everyapp_workspace_group_members_set", [
      "Examples:",
      `  ${CLI} workspace group members Sales`,
      `  ${CLI} workspace group members Sales --add ann@example.com --add bob@example.com`,
      `  ${CLI} workspace group members Sales --set ann@example.com`,
    ]),
  },
});

const groupAppsCommand = buildCommand({
  loader: async () => (await import(".")).groupApps,
  parameters: {
    positional: { kind: "tuple", parameters: [groupParameter] },
    flags: { ...listChangeFlags("an app, by id", "app"), ...apiFlags },
  },
  docs: {
    brief: "Which apps a group opens; --add, --remove or --set change it",
    fullDescription: docs("everyapp_workspace_group_apps, everyapp_workspace_group_apps_set", [
      "Examples:",
      `  ${CLI} workspace group apps Sales`,
      `  ${CLI} workspace group apps Sales --add crm`,
    ]),
  },
});

const appsCommand = buildCommand({
  loader: async () => (await import(".")).apps,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "Every app with whether everyone can open it, how many members have access, its state and what it still needs set",
    fullDescription: docs("everyapp_workspace_apps", [`Example:\n  ${CLI} workspace apps --json`]),
  },
});

const appSetCommand = buildCommand({
  loader: async () => (await import(".")).appSet,
  parameters: {
    positional: { kind: "tuple", parameters: [appParameter] },
    flags: {
      name: { kind: "parsed", parse: String, optional: true, placeholder: "name", brief: "The name the app library shows (1 to 255 characters)" },
      description: { kind: "parsed", parse: String, optional: true, placeholder: "text", brief: "The description under it" },
      everyone: {
        kind: "enum",
        values: ["on", "off"],
        optional: true,
        brief: "Available to everyone: on, every member opens it, new members too; off, only owners, admins and those granted it",
      },
      ...apiFlags,
    },
  },
  docs: {
    brief: "Change an app's name, description or whether everyone can open it",
    fullDescription: docs("everyapp_workspace_app_set", [
      "Catalog metadata only: the next deploy sets the name and description again from",
      "everyapp.config.ts.",
      "",
      "Examples:",
      `  ${CLI} workspace app set crm --everyone on`,
      `  ${CLI} workspace app set crm --name "Open CRM" --description "Contacts and deals"`,
    ]),
  },
});

const appAccessCommand = buildCommand({
  loader: async () => (await import(".")).appAccess,
  parameters: {
    positional: { kind: "tuple", parameters: [appParameter] },
    flags: { ...listChangeFlags("a member's direct grant, by email or user id", "email"), ...apiFlags },
  },
  docs: {
    brief: "Who can open an app; --add, --remove or --set change the direct grants",
    fullDescription: docs("everyapp_workspace_app_access, everyapp_workspace_app_access_set", [
      "Owners and admins open every app by their role. A change touches direct grants only; what",
      "a group grants stays (workspace group apps), and so does \"available to everyone\"",
      "(workspace app set --everyone).",
      "",
      "Examples:",
      `  ${CLI} workspace app access crm`,
      `  ${CLI} workspace app access crm --add ann@example.com`,
      `  ${CLI} workspace app access crm --set ann@example.com --set bob@example.com --json`,
    ]),
  },
});

/** `<dollars|off>`: US dollars per month (a leading $ is fine), or `off` (the Gateway checks the range). */
function parseUsd(input: string): number | "off" {
  const value = input.trim().toLowerCase().replace(/^\$/, "");
  if (value === "off" || value === "none") return "off";
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(`a cap is dollars with at most two decimals, or off (not ${input})`);
  }
  return Number(value);
}

const appCapCommand = buildCommand({
  loader: async () => (await import(".")).appCap,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        { ...appParameter, brief: "The app, by id or row id: the organization's own, or a shared one" },
        {
          placeholder: "dollars|off",
          brief: "Dollars of provider-reported cost per UTC month (0.01 to 1,000,000), or off for no cap of its own (the workspace default applies); not with --unlimited",
          parse: parseUsd,
          optional: true,
        },
      ],
    },
    flags: {
      unlimited: {
        kind: "boolean",
        optional: true,
        brief: "No cap at all, even with a workspace default (instead of dollars or off)",
      },
      ...apiFlags,
    },
  },
  docs: {
    brief: "Cap an app's provider spend per month in dollars, lift its own cap, or exempt it from the workspace default",
    fullDescription: docs("everyapp_workspace_app_cap", [
      "off clears the app's own cap (the workspace default then binds); --unlimited with dollars",
      "or off is refused.",
      "",
      "Examples:",
      `  ${CLI} workspace app cap crm 20`,
      `  ${CLI} workspace app cap crm off`,
      `  ${CLI} workspace app cap crm --unlimited`,
    ]),
  },
});

const capDefaultCommand = buildCommand({
  loader: async () => (await import(".")).capDefault,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "dollars|off",
          brief: "Dollars of provider-reported cost per UTC month (0.01 to 1,000,000) for every app without its own cap, or off for no default",
          parse: parseUsd,
        },
      ],
    },
    flags: apiFlags,
  },
  docs: {
    brief: "Set or clear the workspace default cap: what binds every app without a cap or --unlimited of its own",
    fullDescription: docs("everyapp_workspace_cap_default", [
      "Examples:",
      `  ${CLI} workspace cap default 20`,
      `  ${CLI} workspace cap default off --json`,
    ]),
  },
});

const usageCommand = buildCommand({
  loader: async () => (await import(".")).usage,
  parameters: {
    positional: noArgs,
    flags: {
      month: { kind: "parsed", parse: String, optional: true, placeholder: "YYYY-MM", brief: "The UTC month (default: this one)" },
      ...apiFlags,
    },
  },
  docs: {
    brief: "What the apps spent in a month: per app (with the cap that binds it), per member and per provider",
    fullDescription: docs("everyapp_workspace_usage", [`Example:\n  ${CLI} workspace usage --month 2026-10 --json`]),
  },
});

/** `--since <time>`: an ISO 8601 time, or a date. */
function parseSince(input: string): string {
  const ms = Date.parse(input.trim());
  if (Number.isNaN(ms)) throw new Error(`a time is written like 2026-10-24 or 2026-10-24T09:00:00Z (not ${input})`);
  return new Date(ms).toISOString();
}

function parseLimit(input: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < 1) throw new Error("a limit is a whole number from 1");
  return value;
}

/** `--before <cursor>`: the previous page's `nextBefore`, as `<ms>:<id>`. */
function parseCursor(input: string): { at: number; id: string } {
  const match = /^(\d+):(.+)$/.exec(input.trim());
  if (!match) throw new Error("a cursor is the previous page's nextBefore, written <time>:<id>");
  return { at: Number(match[1]), id: match[2]! };
}

const pageFlags = {
  since: { kind: "parsed", parse: parseSince, optional: true, placeholder: "time", brief: "At or after this time (ISO 8601, UTC)" },
  limit: { kind: "parsed", parse: parseLimit, optional: true, placeholder: "n", brief: "Rows per page, 1 to 200 (default 50)" },
  before: { kind: "parsed", parse: parseCursor, optional: true, placeholder: "cursor", brief: "The next page: the previous page's nextBefore, as <time>:<id>" },
} as const;

const activityCommand = buildCommand({
  loader: async () => (await import(".")).activity,
  parameters: {
    positional: noArgs,
    flags: {
      app: { kind: "parsed", parse: String, optional: true, placeholder: "app", brief: "Calls on this app only, by id or row id" },
      user: { kind: "parsed", parse: String, optional: true, placeholder: "email", brief: "Calls by this member only, by email or user id" },
      decision: { kind: "enum", values: ["allowed", "blocked"], optional: true, brief: "Allowed or blocked calls only" },
      risk: { kind: "enum", values: ["read", "write"], optional: true, brief: "Tools of this risk only" },
      ...pageFlags,
      ...apiFlags,
    },
  },
  docs: {
    brief: "The tool-call audit trail, newest first: who called which tool on which app, and what came of it",
    fullDescription: docs("everyapp_workspace_activity", [
      "Examples:",
      `  ${CLI} workspace activity --limit 20`,
      `  ${CLI} workspace activity --app crm --decision blocked --since 2026-10-24 --json`,
    ]),
  },
});

const auditCommand = buildCommand({
  loader: async () => (await import(".")).audit,
  parameters: {
    positional: noArgs,
    flags: {
      actor: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "who",
        brief: "Events this actor caused: a member by email or user id, an AI connection's or token's id, an app's id, or an operator's email",
      },
      type: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "type",
        brief: "One event type (member.joined), every type under a prefix (member.*, app.crm.*), or * for everything, pings and tool calls included",
      },
      ...pageFlags,
      ...apiFlags,
    },
  },
  docs: {
    brief: "The audit log, newest first: every event the Gateway recorded, who did it and what it was about",
    fullDescription: docs("everyapp_workspace_audit", [
      "Examples:",
      `  ${CLI} workspace audit --limit 20`,
      `  ${CLI} workspace audit --actor mia@acme.com --type member.* --since 2026-10-24 --json`,
    ]),
  },
});

const tokensCommand = buildCommand({
  loader: async () => (await import(".")).tokens,
  parameters: {
    positional: noArgs,
    flags: { all: { kind: "boolean", optional: true, brief: "Revoked and expired tokens too" }, ...apiFlags },
  },
  docs: {
    brief: "Your personal access tokens for the organization (never a token's value)",
    fullDescription: docs("everyapp_my_tokens", [
      "Tokens are made under Manage workspace → Tokens only.",
      "",
      `Example:\n  ${CLI} workspace tokens --all`,
    ]),
  },
});

const tokenRevokeCommand = buildCommand({
  loader: async () => (await import(".")).tokenRevoke,
  parameters: {
    positional: { kind: "tuple", parameters: [{ placeholder: "id", brief: "The token's id or name (workspace tokens lists them)", parse: String }] },
    flags: apiFlags,
  },
  docs: {
    brief: "Revoke one of your personal access tokens: it stops working on its next request",
    fullDescription: docs("everyapp_revoke_token", [`Example:\n  ${CLI} workspace token revoke 3f2a…`]),
  },
});

const connectionsCommand = buildCommand({
  loader: async () => (await import(".")).connections,
  parameters: { positional: noArgs, flags: apiFlags },
  docs: {
    brief: "Your AI connections to the Gateway: which AI app, which apps it may use, read or write",
    fullDescription: docs("everyapp_my_connections", [`Example:\n  ${CLI} workspace connections`]),
  },
});

const connectionRevokeCommand = buildCommand({
  loader: async () => (await import(".")).connectionRevoke,
  parameters: {
    positional: { kind: "tuple", parameters: [{ placeholder: "id", brief: "The connection's id (workspace connections lists them)", parse: String }] },
    flags: apiFlags,
  },
  docs: {
    brief: "Revoke one of your AI connections: the client is out on its next request",
    fullDescription: docs("everyapp_revoke_connection", [`Example:\n  ${CLI} workspace connection revoke mcpc_…`]),
  },
});

const renameCommand = buildCommand({
  loader: async () => (await import(".")).rename,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ placeholder: "name", brief: "The new name: 1 to 64 characters, no line breaks (quote one with spaces)", parse: String }],
    },
    flags: apiFlags,
  },
  docs: {
    brief: "Rename the workspace: the name members see in the organization switcher and in invitations",
    fullDescription: docs("everyapp_workspace_rename", [
      "Examples:",
      `  ${CLI} workspace rename 'Acme Corp'`,
      `  ${CLI} workspace rename 'Acme Corp' --json`,
    ]),
  },
});

export type LinkedDevSetting = "on" | "off" | "show";

function parseLinkedDevSetting(value: string): LinkedDevSetting {
  const setting = value.trim().toLowerCase();
  if (setting === "on" || setting === "off" || setting === "show") return setting;
  throw new Error("Use on, off or show.");
}

const linkedDevCommand = buildCommand({
  loader: async () => (await import(".")).linkedDev,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "on|off|show",
          brief: "Turn linked dev on or off for the organization, or show it (default)",
          parse: parseLinkedDevSetting,
          optional: true,
        },
      ],
    },
    flags: apiFlags,
  },
  docs: {
    brief: "Let owners and admins run `everyapp dev --gateway` against this Gateway's providers (linked dev), or stop it",
    fullDescription: docs("everyapp_workspace_show, everyapp_workspace_linked_dev", [
      "Off by default: a Gateway that didn't turn it on refuses the sign-in and the route.",
      "Turning it off stops tokens already issued on their next call.",
      "",
      "Examples:",
      `  ${CLI} workspace linked-dev on`,
      `  ${CLI} workspace linked-dev show`,
    ]),
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
  docs: { brief: "Change an app's listing, who can open it, and its monthly cap in dollars" },
});

const capRoutes = buildRouteMap({
  routes: { default: capDefaultCommand },
  docs: { brief: "The workspace default cap in dollars on every app's provider calls" },
});

const tokenRoutes = buildRouteMap({
  routes: { revoke: tokenRevokeCommand },
  docs: { brief: "Revoke one of your personal access tokens" },
});

const connectionRoutes = buildRouteMap({
  routes: { revoke: connectionRevokeCommand },
  docs: { brief: "Revoke one of your AI connections" },
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
    "reset-email": resetEmailCommand,
    "reset-link": resetLinkCommand,
    groups: groupsCommand,
    group: groupRoutes,
    apps: appsCommand,
    app: appRoutes,
    cap: capRoutes,
    usage: usageCommand,
    activity: activityCommand,
    audit: auditCommand,
    tokens: tokensCommand,
    token: tokenRoutes,
    connections: connectionsCommand,
    connection: connectionRoutes,
    "linked-dev": linkedDevCommand,
  },
  docs: {
    brief: "Manage the workspace from the terminal: members, invitations, groups, app access, caps, usage, activity, the audit log, tokens, AI connections and linked dev",
  },
});
