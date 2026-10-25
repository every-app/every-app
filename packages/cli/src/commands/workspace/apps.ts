/**
 * `everyapp workspace apps`, `workspace app set|access|cap` and
 * `workspace cap default`: the organization's apps as an admin sees them
 * (Admin → Apps and Usage), who can open each, the monthly cap on its
 * provider calls and the workspace default (lib/gateway/workspace.ts does
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

/** The command line's `<n|off>` as the library takes it: a number, or null for off. */
const capOf = (cap: number | "off"): number | null => (cap === "off" ? null : cap);

export async function appCap(
  flags: WorkspaceFlags & { unlimited?: boolean; usd?: number | "off" },
  app: string,
  cap?: number | "off",
): Promise<void> {
  await runCommand(flags, (out) =>
    setCap({ flags, out }, app, cap === undefined ? undefined : capOf(cap), flags.unlimited ?? false, flags.usd),
  );
}

export async function capDefault(flags: WorkspaceFlags & { usd?: number | "off" }, cap?: number | "off"): Promise<void> {
  await runCommand(flags, (out) => setDefaultCap({ flags, out }, cap === undefined ? undefined : capOf(cap), flags.usd));
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

/** A cap as a person reads it: "5,000 calls a month". */
const calls = (value: number) => `${value.toLocaleString("en-US")} calls a month`;

/** A dollar cap as a person reads it: "$20.00 a month". */
const dollars = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a month`;

/** Both caps of one setting as a person reads them: "5,000 calls a month or $20.00 a month"; null for neither. */
function capsWords(cap: number | null, costMicros: number | null): string | null {
  const parts = [cap === null ? null : calls(cap), costMicros === null ? null : dollars(costMicros)].filter(
    (part): part is string => part !== null,
  );
  return parts.length ? parts.join(" or ") : null;
}

/** An app's own setting as a person reads it. */
function ownCap(cap: number | null, unlimited: boolean, costMicros: number | null = null): string {
  if (unlimited) return "no cap at all";
  return capsWords(cap, costMicros) ?? "no cap of its own";
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

/** Said wherever a dollar cap binds: which calls move it at all. */
const DOLLARS_COUNTED =
  "A dollar cap counts only the cost a provider reports (OpenRouter, DataForSEO); other calls count toward the call cap alone.";

/** Parse `--usd`: dollars with cents, or off. */
type Usd = number | "off";
const usdOf = (usd: Usd | undefined): number | null | undefined => (usd === undefined ? undefined : usd === "off" ? null : usd);

/**
 * `workspace app cap <app> [<n|off>] [--usd <dollars|off>] [--unlimited]`:
 * a number or `off`, `--usd`, or both; or `--unlimited` alone. A kind
 * left out keeps the app's own. Checked before anything connects.
 */
export async function setCap(
  options: WorkspaceOptions,
  identifier: string,
  cap: number | null | undefined,
  unlimited = false,
  usd?: Usd,
): Promise<void> {
  const { out } = options;
  const costUsd = usdOf(usd);
  if (unlimited && (cap !== undefined || costUsd !== undefined)) {
    throw new EveryAppError(
      "INVALID_VALUE",
      "--unlimited takes no number, no off and no --usd\nAn app has caps of its own (a number of calls, --usd, or both), no cap whatever the workspace defaults (--unlimited), or neither (off).",
      { fix: `give --unlimited alone: ${CLI} workspace app cap ${identifier} --unlimited` },
    );
  }
  if (!unlimited && cap === undefined && costUsd === undefined) {
    throw new EveryAppError(
      "MISSING_ARGUMENT",
      "Missing the cap\nGive a number of calls per month, --usd with dollars per month, off for no cap of its own, or --unlimited.",
      { data: { usage: `${CLI} workspace app cap <app> [<n|off>] [--usd <dollars|off>] [--unlimited] [flags]` } },
    );
  }
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Setting ${identifier}'s cap...` });
  const result = await workspace.setMonthlyCap(ws, identifier, cap, { unlimited, costUsd });
  const { app, was, wasUnlimited, wasCostCapMicros, effective, before, effectiveCost, beforeCost, capAlertsId } = result;
  const same = result.cap === was && result.costCapMicros === wasCostCapMicros && unlimited === wasUnlimited;
  const own = ownCap(result.cap, unlimited, result.costCapMicros);
  const fields = {
    cap: result.cap,
    costCapMicros: result.costCapMicros,
    unlimited,
    was,
    wasCostCapMicros,
    wasUnlimited,
    effectiveCap: effective.cap,
    capSource: effective.source,
    effectiveCostCapMicros: effectiveCost.cap,
    costCapSource: effectiveCost.source,
  };
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `${app.appSlug}: ${own}`,
    data: { appRowId: app.id, ...fields },
  });
  // What binds the app now, each kind with where it comes from.
  const binding = [
    effective.cap === null
      ? null
      : effective.source === "default"
        ? `The workspace default of ${calls(effective.cap)}`
        : calls(effective.cap),
    effectiveCost.cap === null
      ? null
      : effectiveCost.source === "default"
        ? `the workspace default of ${dollars(effectiveCost.cap)}`
        : dollars(effectiveCost.cap),
  ].filter((part): part is string => part !== null);
  const bindsLine =
    binding.length === 0
      ? before.cap === null && beforeCost.cap === null
        ? "Its provider calls are not capped."
        : "Its provider calls are no longer capped."
      : effectiveCost.cap === null
        ? effective.source === "default"
          ? `The workspace default of ${calls(effective.cap!)} binds it; past it, ${PAST_THE_CAP}`
          : `Past it, ${PAST_THE_CAP}`
        : `${binding.join(" and ")} ${binding.length > 1 ? "bind" : "binds"} it; past ${binding.length > 1 ? "either" : "it"}, ${PAST_THE_CAP}`;
  const lines = [
    same
      ? `${app.appSlug} had ${own} already. Nothing changed.`
      : `${app.appSlug}: ${own} for ${ws.organization.name} (was ${ownCap(was, wasUnlimited, wasCostCapMicros)}).`,
    bindsLine.charAt(0).toUpperCase() + bindsLine.slice(1),
    ...(effectiveCost.cap === null ? [] : [DOLLARS_COUNTED]),
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
 * `workspace cap default [<n|off>] [--usd <dollars|off>]`: the
 * organization's default caps, as Manage workspace → Usage sets them; a
 * kind left out is kept. The Gateway reads them within 30 seconds (its
 * cap cache).
 */
export async function setDefaultCap(options: WorkspaceOptions, cap: number | null | undefined, usd?: Usd): Promise<void> {
  const { out } = options;
  const costUsd = usdOf(usd);
  if (cap === undefined && costUsd === undefined) {
    throw new EveryAppError(
      "MISSING_ARGUMENT",
      "Missing the default\nGive a number of calls per month, --usd with dollars per month, or off.",
      { data: { usage: `${CLI} workspace cap default [<n|off>] [--usd <dollars|off>] [flags]` } },
    );
  }
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: "Setting the workspace default cap..." });
  const result = await workspace.setDefaultMonthlyCap(ws, cap, costUsd);
  const { was, wasCostCapMicros, capAlertsId } = result;
  const now = { cap: result.cap, costCapMicros: result.costCapMicros };
  const says = (value: number | null, cost: number | null) => {
    const words = capsWords(value, cost);
    return words === null ? "no default cap" : `a default cap of ${words}`;
  };
  const fields = { cap: now.cap, was, costCapMicros: now.costCapMicros, wasCostCapMicros };
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `${ws.organization.name}: ${says(now.cap, now.costCapMicros)}`,
    data: fields,
  });
  const none = now.cap === null && now.costCapMicros === null;
  const both = now.cap !== null && now.costCapMicros !== null;
  const lines = [
    now.cap === was && now.costCapMicros === wasCostCapMicros
      ? `${ws.organization.name} had ${says(now.cap, now.costCapMicros)} already. Nothing changed.`
      : `${ws.organization.name}: ${says(now.cap, now.costCapMicros)} (was ${says(was, wasCostCapMicros)}).`,
    none
      ? "Every app without a cap of its own is uncapped on the Gateway within 30 seconds; an app's own cap or --unlimited stays."
      : `Every app without a cap or --unlimited of its own is held to ${both ? "them" : "it"} on the Gateway within 30 seconds; past ${both ? "either" : "it"}, ${PAST_THE_CAP}`,
    ...(now.costCapMicros === null ? [] : [DOLLARS_COUNTED]),
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
