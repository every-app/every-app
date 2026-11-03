/**
 * `everyapp workspace apps`, `workspace app set|access|cap` and
 * `workspace cap default`: the organization's apps as an admin sees them
 * (Admin → Apps and Usage), who can open each, the monthly dollar cap on
 * its provider calls and the workspace default (lib/gateway/workspace.ts does
 * the reading and writing).
 */
import chalk from "chalk";
import { parseSecretNames } from "@every-app/perimeter/registry";
import type { AppSetup } from "@every-app/sdk/internal";
import { appSetupFrom, declaresSettings, listGatewaySecretNames } from "@/lib/app/settings";
import { EveryAppError, errorMessage } from "@/lib/errors";
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

/** The command line's `<dollars|off>` as the library takes it: dollars, or null for off. */
const dollarsOf = (usd: number | "off"): number | null => (usd === "off" ? null : usd);

export async function appCap(
  flags: WorkspaceFlags & { unlimited?: boolean },
  app: string,
  usd?: number | "off",
): Promise<void> {
  await runCommand(flags, (out) =>
    setCap({ flags, out }, app, usd === undefined ? undefined : dollarsOf(usd), flags.unlimited ?? false),
  );
}

export async function capDefault(flags: WorkspaceFlags, usd: number | "off"): Promise<void> {
  await runCommand(flags, (out) => setDefaultCap({ flags, out }, dollarsOf(usd)));
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
    gatewayNames = await listGatewaySecretNames(gateway.cf, gateway.names);
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
  const { app } = await workspace.updateApp(ws, identifier, {
    name: flags.name,
    description: flags.description,
    everyone: flags.everyone === undefined ? undefined : flags.everyone === "on",
  });
  out.emit({ type: "step", step: STEP, status: "ok", message: `Updated ${app.appSlug}`, data: { appRowId: app.id } });
  const lines = [
    `${app.appSlug} is "${app.name}"${app.description ? `: ${app.description}` : ""}.`,
    app.scope === "shared"
      ? "A shared app: every member of every organization can open it."
      : app.everyone
        ? `Available to everyone in ${ws.organization.name}: every member opens it, new members too.`
        : `Private: ${plural(app.accessCount, "member")} can open it, owners and admins included (workspace app access ${app.appSlug}).`,
  ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], chalk.dim(lines[1]!)].join("\n"),
    data: { organization: ws.organization, app: appData(app) },
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
  // The Gateway's one rule (effective-access.ts): everyone, a role, a grant or a group.
  const canOpen = users.filter((user) => app.everyone || user.admin || user.direct || user.viaGroups.length > 0);
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
      users: users.map((user) => ({ ...memberData(user), direct: user.direct, admin: user.admin, viaGroups: user.viaGroups })),
      ...(change ? { granted: granted.map(memberData), revoked: revoked.map(memberData) } : {}),
    },
  });
}

/** A cap as a person reads it: "$20.00 a month". */
const dollars = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a month`;

/** An app's own setting as a person reads it. */
function ownCap(costMicros: number | null, unlimited: boolean): string {
  if (unlimited) return "no cap at all";
  return costMicros === null ? "no cap of its own" : dollars(costMicros);
}

/** The Cap alerts line and data, when a cap write made the organization's built-in email subscription. */
function capAlertsOf(capAlertsId: string | null): { subscriptionId: string; message: string } | null {
  return capAlertsId === null
    ? null
    : {
        subscriptionId: capAlertsId,
        message: `Owners and admins are emailed at 80% and at the cap (the built-in Cap alerts subscription; ${CLI} events list shows it).`,
      };
}

const PAST_THE_CAP =
  "a provider tool answers a tool error naming the cap, and an app's brokered call gets 429 app_monthly_cap_exceeded until the next UTC month.";

/** Said wherever a cap binds: which calls move it at all. */
const DOLLARS_COUNTED =
  "A cap counts only the cost a provider reports (OpenRouter, DataForSEO); calls to other providers never move it.";

/**
 * `workspace app cap <app> [<dollars|off>] [--unlimited]`: dollars or
 * `off`, or `--unlimited` alone. Checked before anything connects.
 */
export async function setCap(
  options: WorkspaceOptions,
  identifier: string,
  costUsd: number | null | undefined,
  unlimited = false,
): Promise<void> {
  const { out } = options;
  if (unlimited && costUsd !== undefined) {
    throw new EveryAppError(
      "INVALID_VALUE",
      "--unlimited takes no dollars and no off\nAn app has a cap of its own (dollars), no cap whatever the workspace default (--unlimited), or neither (off).",
      { fix: `give --unlimited alone: ${CLI} workspace app cap ${identifier} --unlimited` },
    );
  }
  if (!unlimited && costUsd === undefined) {
    throw new EveryAppError(
      "MISSING_ARGUMENT",
      "Missing the cap\nGive dollars per month, off for no cap of its own, or --unlimited.",
      { data: { usage: `${CLI} workspace app cap <app> [<dollars|off>] [--unlimited] [flags]` } },
    );
  }
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Setting ${identifier}'s cap...` });
  const result = await workspace.setMonthlyCap(ws, identifier, { costUsd, unlimited });
  const { app, costCapMicros, wasCostCapMicros, wasUnlimited, effective, before, capAlertsId } = result;
  const same = costCapMicros === wasCostCapMicros && unlimited === wasUnlimited;
  const own = ownCap(costCapMicros, unlimited);
  const fields = {
    costCapMicros,
    unlimited,
    wasCostCapMicros,
    wasUnlimited,
    effectiveCostCapMicros: effective.cap,
    costCapSource: effective.source,
  };
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `${app.appSlug}: ${own}`,
    data: { appRowId: app.id, ...fields },
  });
  // What binds the app now, and where it comes from.
  const bindsLine =
    effective.cap === null
      ? before.cap === null
        ? "Its provider calls are not capped."
        : "Its provider calls are no longer capped."
      : effective.source === "default"
        ? `The workspace default of ${dollars(effective.cap)} binds it; past it, ${PAST_THE_CAP}`
        : `Past it, ${PAST_THE_CAP}`;
  const lines = [
    same
      ? `${app.appSlug} had ${own} already. Nothing changed.`
      : `${app.appSlug}: ${own} for ${ws.organization.name} (was ${ownCap(wasCostCapMicros, wasUnlimited)}).`,
    bindsLine,
    ...(effective.cap === null ? [] : [DOLLARS_COUNTED]),
  ];
  const capAlerts = capAlertsOf(capAlertsId);
  if (capAlerts) lines.push(capAlerts.message);
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, app: appData(app), ...fields, capAlerts },
  });
}

/**
 * `workspace cap default <dollars|off>`: the organization's default cap,
 * as Manage workspace → Usage sets it. The Gateway reads it within 30
 * seconds (its cap cache).
 */
export async function setDefaultCap(options: WorkspaceOptions, costUsd: number | null): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: "Setting the workspace default cap..." });
  const { costCapMicros, wasCostCapMicros, capAlertsId } = await workspace.setDefaultMonthlyCap(ws, costUsd);
  const says = (cost: number | null) => (cost === null ? "no default cap" : `a default cap of ${dollars(cost)}`);
  const fields = { costCapMicros, wasCostCapMicros };
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `${ws.organization.name}: ${says(costCapMicros)}`,
    data: fields,
  });
  const lines = [
    costCapMicros === wasCostCapMicros
      ? `${ws.organization.name} had ${says(costCapMicros)} already. Nothing changed.`
      : `${ws.organization.name}: ${says(costCapMicros)} (was ${says(wasCostCapMicros)}).`,
    costCapMicros === null
      ? "Every app without a cap of its own is uncapped on the Gateway within 30 seconds; an app's own cap or --unlimited stays."
      : `Every app without a cap or --unlimited of its own is held to it on the Gateway within 30 seconds; past it, ${PAST_THE_CAP}`,
    ...(costCapMicros === null ? [] : [DOLLARS_COUNTED]),
  ];
  const capAlerts = capAlertsOf(capAlertsId);
  if (capAlerts) lines.push(capAlerts.message);
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, ...fields, capAlerts },
  });
}
