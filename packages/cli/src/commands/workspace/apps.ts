/**
 * `everyapp workspace apps` and `workspace app set|access|cap`: the
 * organization's apps as an admin sees them (Admin → Apps and Usage),
 * who can open each, and the monthly cap on its provider calls
 * (lib/gateway/workspace.ts does the reading and writing).
 */
import chalk from "chalk";
import { parseSecretNames } from "@every-app/perimeter/registry";
import type { AppSetup } from "@every-app/sdk/internal";
import { appSetupFrom, declaresSettings, listGatewaySecretNames } from "@/lib/app/settings";
import { errorMessage } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import * as workspace from "@/lib/gateway/workspace";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";
import { connect, listChange, memberData, memberState, type WorkspaceFlags, type WorkspaceOptions } from "./shared";

const STEP = "workspace.update";

type ChangeFlags = WorkspaceFlags & { add?: string[]; remove?: string[]; set?: string[] };

export async function apps(flags: WorkspaceFlags): Promise<void> {
  await runCommand(flags, (out) => listApps({ flags, out }));
}

export async function appSet(
  flags: WorkspaceFlags & { name?: string; description?: string; everyone?: "on" | "off" },
  app: string,
): Promise<void> {
  await runCommand(flags, (out) => updateApp({ flags, out }, app));
}

export async function appAccess(flags: ChangeFlags, app: string): Promise<void> {
  await runCommand(flags, (out) => appAccessCommand({ flags, out }, app));
}

export async function appCap(flags: WorkspaceFlags, app: string, cap: number | null): Promise<void> {
  await runCommand(flags, (out) => setCap({ flags, out }, app, cap));
}

/** The stored manifest's JSON as an object, or null when it isn't one. */
function parsedManifest(stored: string | null): Record<string, unknown> | null {
  if (!stored) return null;
  try {
    const manifest: unknown = JSON.parse(stored);
    return manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Each app's setup state as the Gateway's app lists carry it: the stored
 * manifest's settings against the Gateway's setting names and the secret
 * names the CLI recorded on the row. Null for an app with nothing to set,
 * and for one whose manifest the model can't read.
 */
function setupOf(app: workspace.WorkspaceApp, gatewayNames: readonly string[] | null): AppSetup | null {
  const manifest = parsedManifest(app.manifest);
  if (!manifest || app.tier === "dispatch" || app.status === "pending") return null;
  try {
    if (!declaresSettings(manifest)) return null;
    return appSetupFrom({
      manifest,
      appId: app.appSlug,
      gatewayNames,
      secretNames: parseSecretNames(app.secretNames),
    }).setup;
  } catch {
    return null;
  }
}

const appData = (app: workspace.WorkspaceApp, setup?: AppSetup | null) => ({
  id: app.id,
  appId: app.appSlug,
  name: app.name,
  description: app.description,
  status: app.status,
  scope: app.scope,
  tier: app.tier,
  hostname: app.hostname,
  everyone: app.everyone,
  accessCount: app.accessCount,
  ...(setup === undefined ? {} : { setup }),
});

export async function listApps(options: WorkspaceOptions): Promise<void> {
  const { out } = options;
  const { gateway, ws } = await connect(options);
  const rows = await workspace.listApps(ws);
  let gatewayNames: string[] | null = null;
  try {
    gatewayNames = await listGatewaySecretNames(gateway.cf);
  } catch (error) {
    out.emit({
      type: "warning",
      code: "SETTINGS_UNKNOWN",
      message: `Couldn't list the Gateway's settings, so what each app needs set is unknown\n${errorMessage(error)}`,
    });
  }
  const listed = rows.map((app) => ({ app, setup: setupOf(app, gatewayNames) }));
  const table = formatTable(
    ["APP", "NAME", "STATUS", "WHO CAN OPEN", "SETUP"],
    listed.map(({ app, setup }) => [
      app.appSlug,
      app.name,
      app.status === "active" ? chalk.green(app.status) : chalk.yellow(app.status),
      app.scope === "shared"
        ? "everyone, every organization"
        : app.everyone
          ? `everyone ${chalk.dim(`(${app.accessCount})`)}`
          : plural(app.accessCount, "member"),
      setup === null ? chalk.dim("–") : setup.ready ? chalk.green("ready") : chalk.yellow(`needs ${setup.unmet.map((setting) => setting.names.join(" or ")).join(", ")}`),
    ]),
  );
  const needing = listed.filter(({ setup }) => setup && !setup.ready);
  out.emit({
    type: "done",
    message: `${plural(rows.length, "app")} in ${ws.organization.name}${needing.length > 0 ? `, ${needing.length} needing setup` : ""}`,
    display: rows.length > 0 ? table.join("\n") : chalk.dim(`No apps in ${ws.organization.name} yet.`),
    data: {
      organization: ws.organization,
      apps: listed.map(({ app, setup }) => appData(app, setup)),
      ...(needing.length > 0
        ? {
            next: needing.flatMap(({ app, setup }) =>
              setup?.command ? [{ command: setup.command.command, note: app.appSlug }] : [],
            ),
          }
        : {}),
    },
  });
}

export async function updateApp(
  options: WorkspaceOptions<WorkspaceFlags & { name?: string; description?: string; everyone?: "on" | "off" }>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Updating ${identifier}...` });
  const { app, granted } = await workspace.updateApp(ws, identifier, {
    name: flags.name,
    description: flags.description,
    everyone: flags.everyone === undefined ? undefined : flags.everyone === "on",
  });
  out.emit({ type: "step", step: STEP, status: "ok", message: `Updated ${app.appSlug}`, data: { appRowId: app.id, granted } });
  const lines = [
    `${app.appSlug} is "${app.name}"${app.description ? `: ${app.description}` : ""}.`,
    app.scope === "shared"
      ? "A shared app: every member of every organization can open it."
      : app.everyone
        ? `Available to everyone in ${ws.organization.name}${granted > 0 ? ` (${plural(granted, "member")} granted now)` : ""}; new members get it on joining.`
        : `Private: ${plural(app.accessCount, "member")} can open it (workspace app access ${app.appSlug}).`,
  ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], chalk.dim(lines[1]!)].join("\n"),
    data: { organization: ws.organization, app: appData(app), granted },
  });
}

export async function appAccessCommand(
  options: WorkspaceOptions<ChangeFlags>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  const { change } = listChange(flags);
  const { ws } = await connect(options);
  const app = await workspace.findApp(ws, identifier);
  let granted: workspace.WorkspaceMember[] = [];
  let revoked: workspace.WorkspaceMember[] = [];
  let users: workspace.AppAccessState[];
  if (change) {
    out.emit({ type: "step", step: STEP, status: "start", message: `Changing who can open ${app.appSlug}...` });
    ({ granted, revoked, users } = await workspace.setAppAccess(ws, app, change));
    out.emit({
      type: "step",
      step: STEP,
      status: "ok",
      message: `${app.appSlug}: ${plural(granted.length, "grant")} added, ${revoked.length} revoked`,
      data: { appRowId: app.id, granted: granted.length, revoked: revoked.length },
    });
  } else {
    users = await workspace.appAccess(ws, app);
  }
  const canOpen = users.filter((user) => user.direct || user.viaGroups.length > 0);
  const table = formatTable(
    ["EMAIL", "ROLE", "STATUS", "DIRECT", "VIA GROUPS"],
    users.map((user) => [
      user.email,
      user.primaryRole ?? user.role,
      memberState(user),
      user.direct ? chalk.green("yes") : chalk.dim("no"),
      user.viaGroups.length > 0 ? user.viaGroups.join(", ") : chalk.dim("–"),
    ]),
  );
  const headline = change
    ? `${app.appSlug}: granted ${granted.length > 0 ? granted.map((user) => user.email).join(", ") : "nobody"}, revoked ${revoked.length > 0 ? revoked.map((user) => user.email).join(", ") : "nobody"}; ${plural(canOpen.length, "member")} can open it now.`
    : `${plural(canOpen.length, "member")} of ${users.length} can open ${app.appSlug}${app.everyone ? " (available to everyone)" : ""}.`;
  out.emit({
    type: "done",
    message: headline,
    display: [headline, table.join("\n")].join("\n"),
    data: {
      organization: ws.organization,
      app: appData({ ...app, accessCount: canOpen.length }),
      users: users.map((user) => ({ ...memberData(user), direct: user.direct, viaGroups: user.viaGroups })),
      ...(change ? { granted: granted.map(memberData), revoked: revoked.map(memberData) } : {}),
    },
  });
}

export async function setCap(options: WorkspaceOptions, identifier: string, cap: number | null): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Setting ${identifier}'s cap...` });
  const result = await workspace.setMonthlyCap(ws, identifier, cap);
  const { app, was, capAlertsId } = result;
  const says = (value: number | null) => (value === null ? "no cap" : `${value.toLocaleString("en-US")} calls a month`);
  out.emit({ type: "step", step: STEP, status: "ok", message: `${app.appSlug}: ${says(cap)}`, data: { appRowId: app.id, cap, was } });
  const lines = [
    cap === was
      ? `${app.appSlug} had ${says(cap)} already. Nothing changed.`
      : `${app.appSlug}: ${says(cap)} for ${ws.organization.name} (was ${says(was)}).`,
    cap === null
      ? "Its provider calls are no longer capped."
      : "Past it, a provider tool answers a tool error naming the cap, and an app's brokered call gets 429 app_monthly_cap_exceeded until the next UTC month.",
  ];
  // The organization's first cap made the Gateway's built-in email subscription.
  const capAlerts =
    capAlertsId === null
      ? null
      : {
          subscriptionId: capAlertsId,
          message: `Owners and admins are emailed at 80% and at the cap (the built-in Cap alerts subscription; ${CLI} events list shows it).`,
        };
  if (capAlerts) lines.push(capAlerts.message);
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, app: appData(app), cap, was, capAlerts },
  });
}
