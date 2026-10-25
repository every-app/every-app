/**
 * `everyapp workspace usage|activity|tokens|connections` and `workspace
 * token revoke|connection revoke`: the trails an admin reads (Admin →
 * Usage, Activity, Tokens; the account menu's AI connections), every
 * member's at once for the operator, and the two revocations
 * (lib/gateway/workspace.ts does the reading and writing). Never a
 * token's hash or value.
 */
import chalk from "chalk";
import * as workspace from "@/lib/gateway/workspace";
import { CLI } from "@/lib/output/command";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";
import { connect, iso, userFilter, userLabel, when, type WorkspaceFlags, type WorkspaceOptions } from "./shared";

const STEP = "workspace.update";

export async function usage(flags: WorkspaceFlags & { month?: string }): Promise<void> {
  await runCommand(flags, (out) => reportUsage({ flags, out }));
}

interface ActivityFlags extends WorkspaceFlags {
  app?: string;
  user?: string;
  decision?: "allowed" | "blocked";
  risk?: "read" | "write" | "destructive";
  since?: number;
  limit?: number;
  before?: { createdAt: number; id: string };
}

export async function activity(flags: ActivityFlags): Promise<void> {
  await runCommand(flags, (out) => listActivity({ flags, out }));
}

export async function tokens(flags: WorkspaceFlags & { user?: string; all?: boolean }): Promise<void> {
  await runCommand(flags, (out) => listTokens({ flags, out }));
}

export async function tokenRevoke(flags: WorkspaceFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => revokeToken({ flags, out }, id));
}

export async function connections(flags: WorkspaceFlags & { user?: string }): Promise<void> {
  await runCommand(flags, (out) => listConnections({ flags, out }));
}

export async function connectionRevoke(flags: WorkspaceFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => revokeConnection({ flags, out }, id));
}

const n = (value: number) => value.toLocaleString("en-US");
/** Millionths of a US dollar as dollars: "$0.0123". */
const dollars = (micros: number) => (micros === 0 ? chalk.dim("–") : `$${(micros / 1_000_000).toFixed(4)}`);

export async function reportUsage(options: WorkspaceOptions<WorkspaceFlags & { month?: string }>): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  const month = flags.month ?? workspace.utcMonth(new Date(ws.now));
  const summary = await workspace.usage(ws, month);
  // The cap that binds the app, where it comes from, and whether it is paused.
  const capCell = (row: (typeof summary.byApp)[number]): string => {
    if (!row.callable) return chalk.dim("removed");
    if (row.capUnlimited) return chalk.dim("none (unlimited)");
    if (row.effectiveMonthlyCallCap === null) return chalk.dim("none");
    const cap = n(row.effectiveMonthlyCallCap);
    const bound = row.capSource === "default" ? `${cap} ${chalk.dim("(default)")}` : cap;
    return row.paused ? `${bound} ${chalk.yellow("paused")}` : bound;
  };
  const apps = formatTable(
    ["APP", "CALLS", "FAILED", "TOOL CALLS", "TOKENS IN/OUT", "COST", "CAP"],
    summary.byApp.map((row) => [
      row.appSlug ?? row.appRowId,
      n(row.calls),
      row.failures > 0 ? chalk.yellow(n(row.failures)) : chalk.dim("0"),
      n(row.toolCalls),
      `${n(row.inputTokens)}/${n(row.outputTokens)}`,
      dollars(row.costMicros),
      capCell(row),
    ]),
  );
  const members = formatTable(
    ["MEMBER", "CALLS", "FAILED", "TOOL CALLS", "TOKENS IN/OUT", "COST"],
    summary.byMember.map((row) => [
      row.userId === "" ? chalk.dim("the apps themselves") : (row.email ?? chalk.dim(`${row.userId} (no longer a member)`)),
      n(row.calls),
      row.failures > 0 ? chalk.yellow(n(row.failures)) : chalk.dim("0"),
      n(row.toolCalls),
      `${n(row.inputTokens)}/${n(row.outputTokens)}`,
      dollars(row.costMicros),
    ]),
  );
  const targets = formatTable(
    ["PROVIDER", "KIND", "CALLS", "FAILED", "TOKENS IN/OUT", "COST"],
    summary.byTarget.map((row) => [
      row.target,
      row.kind,
      n(row.calls),
      row.failures > 0 ? chalk.yellow(n(row.failures)) : chalk.dim("0"),
      `${n(row.inputTokens)}/${n(row.outputTokens)}`,
      dollars(row.costMicros),
    ]),
  );
  const calls = summary.byApp.reduce((sum, row) => sum + row.calls, 0);
  const toolCalls = summary.byApp.reduce((sum, row) => sum + row.toolCalls, 0);
  const paused = summary.byApp.filter((row) => row.paused).length;
  const headline = `${ws.organization.name}, ${month}: ${plural(calls, "provider call")} and ${plural(toolCalls, "tool call")} across ${plural(summary.byApp.length, "app")}${paused > 0 ? `, ${paused} paused` : ""}`;
  const defaultCap =
    summary.defaultMonthlyCallCap === null
      ? "No workspace default cap."
      : `Workspace default cap: ${n(summary.defaultMonthlyCallCap)} calls a month for every app without its own.`;
  out.emit({
    type: "done",
    message: headline,
    display: [
      headline,
      chalk.dim(defaultCap),
      "",
      chalk.bold("By app"),
      ...(summary.byApp.length > 0 ? apps : [chalk.dim("no apps")]),
      "",
      chalk.bold("By member"),
      ...(summary.byMember.length > 0 ? members : [chalk.dim("no calls")]),
      "",
      chalk.bold("By provider"),
      ...(summary.byTarget.length > 0 ? targets : [chalk.dim("no calls")]),
      "",
      chalk.dim(`Cap an app: ${CLI} workspace app cap <app> <n|off|--unlimited>; the default: ${CLI} workspace cap default <n|off>`),
    ].join("\n"),
    data: { organization: ws.organization, ...summary },
  });
}

export async function listActivity(options: WorkspaceOptions<ActivityFlags>): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  const app = flags.app === undefined ? undefined : await workspace.findApp(ws, flags.app, { callable: true });
  const user = flags.user === undefined ? undefined : await userFilter(ws, flags.user);
  const page = await workspace.activity(ws, {
    limit: flags.limit,
    before: flags.before,
    appRowId: app?.id,
    userId: user?.id,
    decision: flags.decision,
    risk: flags.risk,
    since: flags.since,
  });
  const table = formatTable(
    ["WHEN (UTC)", "WHO", "APP", "TOOL", "RISK", "DECISION", "OUTCOME", "MS", "CLIENT"],
    page.calls.map((call) => [
      when(call.createdAt),
      call.user.email ?? chalk.dim(call.user.id),
      call.app.slug ? `${call.app.slug}${call.app.removed ? chalk.dim(" (removed)") : ""}` : chalk.dim("gateway"),
      call.tool.via ? `${call.tool.name} ${chalk.dim(`via ${call.tool.via}`)}` : call.tool.name,
      call.tool.risk ?? chalk.dim("–"),
      call.decision === "allowed" ? chalk.green("allowed") : chalk.red(`blocked${call.reason ? chalk.dim(` (${call.reason})`) : ""}`),
      call.outcome,
      call.durationMs === null ? chalk.dim("–") : String(call.durationMs),
      call.credential.clientName ?? call.credential.clientInfo ?? chalk.dim(call.credential.kind),
    ]),
  );
  const cursor = page.nextBefore ? `${page.nextBefore.createdAt}:${page.nextBefore.id}` : null;
  const headline = `${plural(page.calls.length, "tool call")} in ${ws.organization.name}${page.nextBefore ? " (more before this page)" : ""}`;
  out.emit({
    type: "done",
    message: headline,
    display: [
      page.calls.length > 0 ? table.join("\n") : chalk.dim("No tool calls match."),
      ...(cursor ? [chalk.dim(`Next page: ${CLI} workspace activity --before ${cursor}`)] : []),
    ].join("\n"),
    data: {
      organization: ws.organization,
      calls: page.calls.map((call) => ({ ...call, createdAt: iso(call.createdAt) })),
      nextBefore: cursor,
      ...(cursor ? { next: [{ command: `${CLI} workspace activity --before ${cursor}`, note: "the next page" }] } : {}),
    },
  });
}

const tokenData = (token: workspace.WorkspaceToken) => ({
  id: token.id,
  user: token.user,
  name: token.name,
  prefix: token.prefix,
  app: token.app.slug,
  scopes: token.scopes,
  active: token.active,
  createdAt: iso(token.createdAt),
  expiresAt: iso(token.expiresAt),
  lastUsedAt: iso(token.lastUsedAt),
  revokedAt: iso(token.revokedAt),
});

export async function listTokens(options: WorkspaceOptions<WorkspaceFlags & { user?: string; all?: boolean }>): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  const user = flags.user === undefined ? undefined : await userFilter(ws, flags.user);
  const every = await workspace.listTokens(ws, user?.id);
  const tokens = flags.all ? every : every.filter((token) => token.active);
  const table = formatTable(
    ["ID", "MEMBER", "NAME", "PREFIX", "APP", "SCOPES", "STATE", "LAST USED", "EXPIRES"],
    tokens.map((token) => [
      token.id,
      token.user.email,
      token.name,
      `${token.prefix}…`,
      token.app.slug ?? chalk.dim("all apps"),
      token.scopes.join(","),
      token.revokedAt !== null ? chalk.dim("revoked") : token.active ? chalk.green("active") : chalk.yellow("expired"),
      when(token.lastUsedAt),
      when(token.expiresAt),
    ]),
  );
  const headline = `${plural(tokens.length, flags.all ? "personal access token" : "active personal access token")}${user ? ` of ${userLabel(user)}` : ""} in ${ws.organization.name}${!flags.all && every.length > tokens.length ? ` (${every.length - tokens.length} revoked or expired: --all)` : ""}`;
  out.emit({
    type: "done",
    message: headline,
    display: [
      tokens.length > 0 ? table.join("\n") : chalk.dim(headline),
      chalk.dim(`Revoke one: ${CLI} workspace token revoke <id>. Tokens are made in Admin → Tokens; a value is never shown again.`),
    ].join("\n"),
    data: { organization: ws.organization, tokens: tokens.map(tokenData) },
  });
}

export async function revokeToken(options: WorkspaceOptions, id: string): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Revoking the token ${id}...` });
  const { token, already } = await workspace.revokeToken(ws, id);
  out.emit({ type: "step", step: STEP, status: "ok", message: `Revoked ${token.name}`, data: { tokenId: token.id, already } });
  const lines = already
    ? [`${token.user.email}'s token ${token.name} (${token.prefix}…) was revoked already, on ${when(token.revokedAt)} UTC.`]
    : [`Revoked ${token.user.email}'s token ${token.name} (${token.prefix}…).`, "It stops working on its next request."];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, token: tokenData(token), already },
  });
}

const connectionData = (connection: workspace.WorkspaceConnection) => ({
  id: connection.id,
  user: connection.user,
  clientName: connection.clientName,
  clientDomain: connection.clientDomain,
  redirectHost: connection.redirectHost,
  apps: connection.apps,
  access: connection.access,
  createdAt: iso(connection.createdAt),
  lastUsedAt: iso(connection.lastUsedAt),
  revokedAt: iso(connection.revokedAt),
  revokedReason: connection.revokedReason,
});

export async function listConnections(options: WorkspaceOptions<WorkspaceFlags & { user?: string }>): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  const user = flags.user === undefined ? undefined : await userFilter(ws, flags.user);
  const rows = await workspace.listConnections(ws, user?.id);
  const table = formatTable(
    ["ID", "MEMBER", "AI APP", "APPS", "ACCESS", "LAST USED", "SINCE"],
    rows.map((connection) => [
      connection.id,
      connection.user.email,
      `${connection.clientName}${connection.clientDomain ? chalk.dim(` (${connection.clientDomain})`) : ""}`,
      connection.apps === "all" ? "all" : connection.apps.join(", ") || chalk.dim("none"),
      connection.access === "write" ? "read & write" : "read",
      when(connection.lastUsedAt),
      when(connection.createdAt),
    ]),
  );
  const headline = `${plural(rows.length, "AI connection")}${user ? ` of ${userLabel(user)}` : ""} in ${ws.organization.name}`;
  out.emit({
    type: "done",
    message: headline,
    display: [
      rows.length > 0 ? table.join("\n") : chalk.dim(headline),
      chalk.dim(`Revoke one: ${CLI} workspace connection revoke <id>`),
    ].join("\n"),
    data: { organization: ws.organization, connections: rows.map(connectionData) },
  });
}

export async function revokeConnection(options: WorkspaceOptions, id: string): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Revoking the connection ${id}...` });
  const { connection, already } = await workspace.revokeConnection(ws, id);
  out.emit({ type: "step", step: STEP, status: "ok", message: `Revoked ${connection.clientName}`, data: { connectionId: connection.id, already } });
  const lines = already
    ? [`${connection.user.email}'s connection from ${connection.clientName} was revoked already${connection.revokedReason ? ` (${connection.revokedReason})` : ""}.`]
    : [
        `Revoked ${connection.user.email}'s connection from ${connection.clientName}.`,
        "The client is out on its next request; its grant in the Gateway's authorization server lapses on its own.",
      ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, connection: connectionData(connection), already },
  });
}
