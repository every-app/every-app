/**
 * `everyapp workspace …`: each command is one Gateway tool
 * (lib/gatewayApi/command.ts `runTool`), its flags the tool's arguments.
 * What a member, an invitation, a group, an app or a cap may be is the
 * Gateway's to say; this file only says which tool, with what, and the
 * line a person reads after it. `reset-link` and `invite-link` are in
 * ./links.ts.
 */
import { formatAnswer, formatRows, listChange, runTool, type ToolCommandFlags, type ToolRun } from "@/lib/gatewayApi/command";
import type { JsonObject } from "@/lib/gatewayApi";
import { CLI } from "@/lib/output/command";
import { commandLines } from "@/lib/output/result";
import type { LinkedDevSetting, WorkspaceRole } from "./command";

const W = (name: string) => `everyapp_workspace_${name}`;

type ChangeFlags = ToolCommandFlags & { add?: string[]; remove?: string[]; set?: string[] };

const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {});
const rows = (value: unknown): JsonObject[] => (Array.isArray(value) ? (value as JsonObject[]) : []);
const emailOf = (answer: JsonObject) => str(obj(answer["user"])["email"]);

/** A read: the tool, and its answer drawn as it comes. */
const read = (flags: ToolCommandFlags, tool: string, args: JsonObject, done: (answer: JsonObject) => string) =>
  runTool(flags, { tool, args, done });

export const show = (flags: ToolCommandFlags) =>
  read(flags, W("show"), {}, (answer) => `${str(obj(answer["organization"])["name"], "The workspace")}: you are ${str(answer["role"], "a member")}`);

export const users = (flags: ToolCommandFlags) =>
  read(flags, W("users"), {}, (answer) => `${rows(answer["members"]).length} members, ${rows(answer["invitations"]).length} pending invitations`);

export const rename = (flags: ToolCommandFlags, name: string) =>
  runTool(flags, {
    tool: W("rename"),
    args: { name },
    done: (answer) => `The workspace is now called ${str(obj(answer["organization"])["name"], name)}`,
    display: () => "",
  });

export const role = (flags: ToolCommandFlags, user: string, role: WorkspaceRole) =>
  runTool(flags, {
    tool: W("role"),
    args: { user, role },
    done: (answer) => `${emailOf(answer) || user} is now ${str(answer["role"], role)}`,
    display: () => "",
  });

export const invite = (flags: ToolCommandFlags & { role: "member" | "admin" }, email: string) =>
  runTool(flags, {
    tool: W("invite"),
    args: { email, role: flags.role },
    done: (answer) =>
      answer["emailed"] === true
        ? `Invited ${email} as ${flags.role}: the invitation was mailed`
        : `Invited ${email} as ${flags.role}, not mailed: ${CLI} workspace invite-link ${email} prints the link (under your Cloudflare login), or copy it from Admin → Users`,
    // Not mailed: the one command that gets the link, on a line of its own.
    short: (answer) =>
      answer["emailed"] === true
        ? null
        : {
            headline: `Invited ${email} as ${flags.role}, not mailed`,
            blocks: [commandLines("Get the link", [`${CLI} workspace invite-link ${email}`])],
            detail: ["The command runs under your Cloudflare login. The link is also in Admin → Users."],
          },
  });

export const uninvite = (flags: ToolCommandFlags, invitation: string) =>
  runTool(flags, { tool: W("uninvite"), args: { invitation }, done: () => `Canceled the invitation for ${invitation}`, display: () => "" });

export const deactivate = (flags: ToolCommandFlags, user: string) =>
  runTool(flags, {
    tool: W("deactivate"),
    args: { user },
    done: (answer) => `Deactivated ${emailOf(answer) || user}: signed out everywhere, tokens and AI connections revoked`,
    display: () => "",
  });

export const reactivate = (flags: ToolCommandFlags, user: string) =>
  runTool(flags, {
    tool: W("reactivate"),
    args: { user },
    done: (answer) => `Reactivated ${emailOf(answer) || user}: they can sign in again`,
    display: () => "",
  });

export const remove = (flags: ToolCommandFlags & { yes?: boolean }, user: string) =>
  runTool(flags, {
    tool: W("remove"),
    args: { user, confirm: true },
    confirm: `Remove ${user} from the workspace? This can't be undone.`,
    done: (answer) => `Removed ${emailOf(answer) || user}`,
    display: () => "",
  });

export const resetEmail = (flags: ToolCommandFlags, user: string) =>
  runTool(flags, {
    tool: W("reset_email"),
    args: { user },
    done: (answer) => `Mailed ${emailOf(answer) || user} a password-reset link`,
    display: () => "",
  });

export const groups = (flags: ToolCommandFlags) =>
  read(flags, W("groups"), {}, (answer) => `${rows(answer["groups"]).length} groups`);

export const groupCreate = (flags: ToolCommandFlags & { description?: string }, name: string) =>
  runTool(flags, {
    tool: W("group_create"),
    args: { name, ...(flags.description !== undefined ? { description: flags.description } : {}) },
    done: () => `Made the group ${name}`,
  });

export const groupSet = (flags: ToolCommandFlags & { name?: string; description?: string }, group: string) =>
  runTool(flags, {
    tool: W("group_set"),
    args: {
      group,
      ...(flags.name !== undefined ? { name: flags.name } : {}),
      ...(flags.description !== undefined ? { description: flags.description } : {}),
    },
    done: () => `Changed the group ${group}`,
  });

export const groupDelete = (flags: ToolCommandFlags & { yes?: boolean }, group: string) =>
  runTool(flags, {
    tool: W("group_delete"),
    args: { group },
    confirm: `Delete the group ${group}? What it granted ends with it.`,
    done: () => `Deleted the group ${group}`,
    display: () => "",
  });

/** A list read, or its `_set` twin when a change flag is given. */
function listOrSet(
  flags: ChangeFlags,
  tool: string,
  target: JsonObject,
  fullKey: "users" | "apps",
  what: string,
): Promise<void> {
  const change = listChange(flags, fullKey);
  const run: ToolRun = change
    ? { tool: `${tool}_set`, args: { ...target, ...change }, done: () => `Changed ${what}` }
    : { tool, args: target, done: () => what.charAt(0).toUpperCase() + what.slice(1) };
  return runTool(flags, run);
}

export const groupMembers = (flags: ChangeFlags, group: string) =>
  listOrSet(flags, W("group_members"), { group }, "users", `the members of ${group}`);

export const groupApps = (flags: ChangeFlags, group: string) =>
  listOrSet(flags, W("group_apps"), { group }, "apps", `the apps ${group} opens`);

export const apps = (flags: ToolCommandFlags) => read(flags, W("apps"), {}, (answer) => `${rows(answer["apps"]).length} apps`);

export const appSet = (
  flags: ToolCommandFlags & { name?: string; description?: string; everyone?: "on" | "off" },
  app: string,
) =>
  runTool(flags, {
    tool: W("app_set"),
    args: {
      app,
      ...(flags.name !== undefined ? { name: flags.name } : {}),
      ...(flags.description !== undefined ? { description: flags.description } : {}),
      ...(flags.everyone !== undefined ? { everyone: flags.everyone === "on" } : {}),
    },
    done: () => `Changed ${app}`,
  });

export const appAccess = (flags: ChangeFlags, app: string) =>
  listOrSet(flags, W("app_access"), { app }, "users", `who can open ${app}`);

/** A cap argument: dollars, null for `off`, nothing when left out. */
const capArg = (value: number | "off" | undefined): JsonObject =>
  value === undefined ? {} : { costUsd: value === "off" ? null : value };

export const appCap = (flags: ToolCommandFlags & { unlimited?: boolean }, app: string, usd?: number | "off") =>
  runTool(flags, {
    tool: W("app_cap"),
    args: { app, ...capArg(usd), ...(flags.unlimited ? { unlimited: true } : {}) },
    done: () => `Set ${app}'s monthly cap`,
  });

export const capDefault = (flags: ToolCommandFlags, usd: number | "off") =>
  runTool(flags, {
    tool: W("cap_default"),
    args: capArg(usd),
    done: () => "Set the workspace default cap",
  });

export const usage = (flags: ToolCommandFlags & { month?: string }) =>
  read(flags, W("usage"), flags.month ? { month: flags.month } : {}, (answer) => `Usage for ${str(answer["month"], flags.month ?? "this month")}`);

interface PageFlags extends ToolCommandFlags {
  since?: string;
  limit?: number;
  before?: { at: number; id: string };
}

const pageArgs = (flags: PageFlags, cursorTime: "createdAt" | "time"): JsonObject => ({
  ...(flags.since ? { since: flags.since } : {}),
  ...(flags.limit ? { limit: flags.limit } : {}),
  ...(flags.before ? { before: { [cursorTime]: flags.before.at, id: flags.before.id } } : {}),
});

/** A page's `nextBefore` as `--before` takes it, for the line after the table. */
function nextPage(answer: JsonObject, cursorTime: "createdAt" | "time"): string {
  const next = obj(answer["nextBefore"]);
  return next["id"] ? `More: --before ${String(next[cursorTime])}:${String(next["id"])}` : "";
}

export const activity = (
  flags: PageFlags & { app?: string; user?: string; decision?: "allowed" | "blocked"; risk?: "read" | "write" },
) =>
  runTool(flags, {
    tool: W("activity"),
    args: {
      ...(flags.app ? { app: flags.app } : {}),
      ...(flags.user ? { user: flags.user } : {}),
      ...(flags.decision ? { decision: flags.decision } : {}),
      ...(flags.risk ? { risk: flags.risk } : {}),
      ...pageArgs(flags, "createdAt"),
    },
    done: (answer) => `${rows(answer["calls"] ?? answer["rows"]).length} tool calls, newest first`,
    display: (answer) => [formatAnswer({ ...answer, nextBefore: undefined }), nextPage(answer, "createdAt")].filter(Boolean).join("\n\n"),
  });

export const audit = (flags: PageFlags & { actor?: string; type?: string }) =>
  runTool(flags, {
    tool: W("audit"),
    args: {
      ...(flags.actor ? { actor: flags.actor } : {}),
      ...(flags.type ? { type: flags.type } : {}),
      ...pageArgs(flags, "time"),
    },
    done: (answer) => `${rows(answer["events"] ?? answer["rows"]).length} audit events, newest first`,
    display: (answer) => [formatAnswer({ ...answer, nextBefore: undefined }), nextPage(answer, "time")].filter(Boolean).join("\n\n"),
  });

export const tokens = (flags: ToolCommandFlags & { all?: boolean }) =>
  runTool(flags, {
    tool: "everyapp_my_tokens",
    done: (answer) => `${shownTokens(answer, flags.all).length} personal access tokens`,
    display: (answer) => formatRows(shownTokens(answer, flags.all)),
  });

/** Live tokens only, unless `--all`. */
function shownTokens(answer: JsonObject, all?: boolean): JsonObject[] {
  const listed = rows(answer["tokens"]);
  if (all) return listed;
  const now = Date.now();
  return listed.filter((token) => !token["revokedAt"] && !token["revoked"] && !(typeof token["expiresAt"] === "string" && Date.parse(token["expiresAt"]) <= now));
}

export const tokenRevoke = (flags: ToolCommandFlags, token: string) =>
  runTool(flags, { tool: "everyapp_revoke_token", args: { token }, done: () => `Revoked the token ${token}`, display: () => "" });

export const connections = (flags: ToolCommandFlags) =>
  read(flags, "everyapp_my_connections", {}, (answer) => `${rows(answer["connections"]).length} AI connections`);

export const connectionRevoke = (flags: ToolCommandFlags, connection: string) =>
  runTool(flags, {
    tool: "everyapp_revoke_connection",
    args: { connection },
    done: () => `Revoked the AI connection ${connection}`,
    display: () => "",
  });

/** `show` reads it from everyapp_workspace_show (a read-only credential can); on and off are the write. */
export const linkedDev = (flags: ToolCommandFlags, setting: LinkedDevSetting = "show") =>
  runTool(flags, {
    tool: setting === "show" ? W("show") : W("linked_dev"),
    args: setting === "show" ? {} : { on: setting === "on" },
    done: (answer) => `Linked dev is ${str(answer["linkedDev"])}${answer["changed"] === true ? " now" : ""}`,
    display: () => "",
  });
