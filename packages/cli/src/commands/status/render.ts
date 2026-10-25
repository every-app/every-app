/**
 * `everyapp status` for a person: the Gateway's facts, its apps, their
 * mail and their settings as tables, then each problem as a block (a
 * glyph-led headline, why, dim, and what to run). Problems one command
 * fixes share one block; those that settle by themselves show only in the
 * rows.
 */
import chalk from "chalk";
import type { AccessState } from "@/lib/access/settings";
import type { EmailRouteProblem } from "@/lib/app/emailRoutes";
import { describeMcp, listPublicRoutes } from "@/lib/app/publicRoutes";
import { renderSettingsTable, settingsRows } from "@/lib/app/settings";
import type { InstallRecord } from "@/lib/gateway/install";
import { describeLeaseHolder, type LeaseHolder } from "@/lib/gateway/lease";
import type { GatewayOwner } from "@/lib/gateway/setup-link";
import { formatFacts, formatTable, type Fact } from "@/lib/output/table";
import { capitalize, plural } from "@/lib/output/text";
import {
  needsSetup,
  Severity,
  type AppState,
  type CheckoutState,
  type Problem,
  type Unread,
} from "./problems";

const GLYPHS: Readonly<Record<Exclude<Severity, Severity.Settling>, string>> = {
  [Severity.Error]: chalk.red("✗"),
  [Severity.Warning]: chalk.yellow("!"),
  [Severity.Info]: chalk.dim("i"),
};

/** The report of a Gateway database with no install row. */
export function renderNotInstalled(accountName: string, problem: Problem): string {
  return [
    ...formatFacts([
      { label: "Cloudflare", value: accountName },
      { label: "Gateway", value: chalk.yellow("install not finished") },
    ]),
    ...renderProblems([problem]),
  ].join("\n");
}

export function renderStatus({
  install,
  accountName,
  owner,
  servingRecorded,
  checkout,
  certificates,
  waitingCertificates,
  access,
  leases,
  apps,
  missingWorkers,
  skippedWorkers,
  emailProblems,
  problems,
}: {
  install: InstallRecord;
  accountName: string;
  owner: GatewayOwner | null;
  /** The Gateway Worker serves the version the install row names. */
  servingRecorded: boolean;
  checkout: CheckoutState;
  /** Null when cf couldn't list them. */
  certificates: Array<{ host: string; ready: boolean }> | null;
  waitingCertificates: string[];
  /** Whether Cloudflare Access is on; why cf couldn't say; null when it doesn't apply (hosted, or no Worker yet). */
  access: AccessState | Unread | null;
  leases: LeaseHolder[];
  apps: AppState[];
  missingWorkers: Set<string>;
  skippedWorkers: Set<string>;
  emailProblems: EmailRouteProblem[];
  problems: Problem[];
}): string {
  const uploaded = install.liveVersionId !== null;
  const facts: Fact[] = [
    {
      label: "Gateway",
      // The mode is a secret nothing reads back: the install row has it when
      // the first upload recorded it.
      value: `${chalk.cyan(`https://${install.gatewayHost}`)}${install.deploymentMode ? chalk.dim(` · ${install.deploymentMode.replace("_", "-")}`) : ""}`,
    },
    { label: "Cloudflare", value: accountName },
    {
      label: "Owner",
      value: owner
        ? `${owner.email}${owner.organizationName ? chalk.dim(` · ${owner.organizationName}`) : ""}`
        : chalk.yellow("none yet"),
    },
    ...(access ? [{ label: "Access", value: accessRow(access) }] : []),
    { label: "Release", value: release(install, servingRecorded, checkout) },
    { label: "TLS", value: tls(certificates, waitingCertificates) },
    ...leases.map((lease, index) => ({
      label: index === 0 ? "Deploys" : "",
      value: capitalize(describeLeaseHolder(lease)),
    })),
  ];
  const deploying = new Set(leases.flatMap((lease) => (lease.app ? [lease.app] : [])));
  const waiting = new Set(waitingCertificates);
  const appCell = (app: AppState) =>
    appStatus(app, {
      missing: missingWorkers.has(app.workerName),
      skipped: skippedWorkers.has(app.workerName),
      waitingCertificate: waiting.has(app.hostname),
      deploying: deploying.has(app.id),
    });
  const mailing = apps.filter(
    (app) => app.email.senders.length > 0 || app.email.inbound.length > 0 || app.email.routed.length > 0,
  );
  // Each app's settings, for the apps that declare any.
  const settings = apps.flatMap((app) => (app.setup ? settingsRows(app.id, app.setup.settings) : []));
  return [
    ...formatFacts(facts),
    "",
    ...(apps.length > 0
      ? formatTable(
          ["APP", "STATUS", "URL", "DEPLOYED BY", "PUBLIC"],
          apps.map((app) => [
            app.id,
            appCell(app),
            chalk.cyan(`https://${app.hostname}`),
            deployer(app.deployedBy),
            publicCell(app),
          ]),
          // Most apps open nothing: no blanks trail their rows.
        ).map((line) => line.trimEnd())
      // What to do about it is the Next block's (`create my-app`, next.ts).
      : [chalk.dim("No apps yet.")]),
    ...(mailing.length > 0 ? ["", ...emailTable(mailing, emailProblems)] : []),
    ...(settings.length > 0 ? ["", ...renderSettingsTable(settings)] : []),
    ...renderProblems(problems),
  ].join("\n");
}

/** The Release row: the version, and how it stands against the Worker and this checkout. */
function release(install: InstallRecord, servingRecorded: boolean, checkout: CheckoutState): string {
  const version = install.releaseVersion;
  const flagged = (note: string) => `${version} ${chalk.dim("·")} ${chalk.yellow(note)}`;
  if (install.liveVersionId === null) return chalk.yellow(`${version}, never uploaded`);
  if (!servingRecorded) return flagged("changed outside everyapp");
  if (checkout.behind) return flagged("this checkout is behind");
  // An update to take or leave, not something off: dim, as the block under the report says.
  if (checkout.upToDate === false) return `${version}${chalk.dim(" · this checkout has newer Gateway changes")}`;
  if (checkout.upToDate === true) return `${version}${chalk.dim(" · matches this checkout")}`;
  return version;
}

/** The Access row: on, off, or what cf couldn't say. What to do about off is the Next block's (`access on`, next.ts). */
function accessRow(access: AccessState | Unread): string {
  if ("error" in access) return chalk.yellow("! couldn't check");
  if (access.on) return `${chalk.green("on")}${chalk.dim(" · everyone signs in through Cloudflare Access first")}`;
  return chalk.dim("off");
}

function tls(
  certificates: Array<{ host: string; ready: boolean }> | null,
  waiting: string[],
): string {
  if (certificates === null) return chalk.yellow("! couldn't check");
  if (certificates.length === 0) return chalk.dim("no hostnames yet");
  if (waiting.length > 0) {
    return `waiting for ${waiting.join(", ")}${chalk.dim(" · usually a few minutes")}`;
  }
  return `ready on ${plural(certificates.length, "hostname")}`;
}

/** Who deployed an app last, as a person reads it. */
function deployer(deployedBy: string | null): string {
  if (!deployedBy) return "";
  return deployedBy.startsWith("api-token:") ? "API token" : deployedBy;
}

/** How many public routes the PUBLIC cell names before counting the rest. */
const SHOWN_PUBLIC_ROUTES = 3;

/**
 * The PUBLIC cell: what the deployed manifest opens without a sign-in. Its
 * routes (`GET /t/*, POST /t/e, GET /health +2 more`) and, where the
 * manifest asks for `/mcp` on the app's host, `MCP /mcp (gateway)`;
 * nothing when neither.
 */
function publicCell(app: AppState): string {
  const parts: string[] = [];
  if (app.publicRoutes.length > 0) {
    const { shown, more } = listPublicRoutes(app.publicRoutes, SHOWN_PUBLIC_ROUTES);
    parts.push(`${shown}${more > 0 ? chalk.dim(` +${more} more`) : ""}`);
  }
  if (app.mcp) parts.push(describeMcp(app.mcp));
  return parts.join(chalk.dim(" · "));
}

/**
 * An app's STATUS cell: a glyph (✓ live, ! to do, ✗ broken, ○ settling by
 * itself) and a few words. A served app whose required settings aren't
 * set says so instead of live: it doesn't open until they are.
 */
function appStatus(
  app: AppState,
  {
    missing,
    skipped,
    waitingCertificate,
    deploying,
  }: { missing: boolean; skipped: boolean; waitingCertificate: boolean; deploying: boolean },
): string {
  const state = missing
    ? `${chalk.red("✗")} Worker missing`
    : skipped
      ? `${chalk.red("✗")} can't be bound`
      : app.status === "pending"
        ? `${chalk.yellow("!")} never deployed`
        : !app.bound
          ? `${chalk.yellow("!")} not bound`
          : needsSetup(app)
            ? `${chalk.yellow("!")} needs setup`
            : app.status === "active"
              ? `${chalk.green("✓")} live`
              : app.status === "binding"
                ? `${chalk.dim("○")} ${waitingCertificate ? "waiting for certificate" : "live on first visit"}`
                : chalk.dim(app.status === "disabled" ? "switched off" : app.status);
  return deploying ? `${state} · deploying` : state;
}

/** Each app's mail: what it sends as and receives at, an address a line, broken ones flagged. */
function emailTable(apps: AppState[], emailProblems: EmailRouteProblem[]): string[] {
  const rows = apps.flatMap((app) => {
    const { senders, inbound, routed, declaresInbound } = app.email;
    const undelivered = new Set(
      emailProblems
        .filter((problem) => problem.workerName === app.workerName)
        .map((problem) => problem.address),
    );
    const receives =
      inbound.length > 0 && !declaresInbound
        ? inbound.map((address) => `${chalk.yellow("!")} ${address} ${chalk.dim("(inbound off)")}`)
        : [
            ...inbound.map((address) =>
              undelivered.has(address)
                ? `${address} ${chalk.yellow("! not delivered")}`
                : routed.includes(address)
                  ? address
                  : `${address} ${chalk.yellow("! not routed yet")}`,
            ),
            ...routed
              .filter((address) => !inbound.includes(address))
              .map((address) => `${address} ${chalk.yellow("! still routed, no longer listed")}`),
          ];
    const sends = senders.length > 0 ? senders : [chalk.dim("the Gateway's sender")];
    const lines = Math.max(sends.length, receives.length, 1);
    return Array.from({ length: lines }, (_, line) => [
      line === 0 ? app.id : "",
      sends[line] ?? "",
      receives[line] ?? (line === 0 ? chalk.dim("nothing") : ""),
    ]);
  });
  return formatTable(["EMAIL", "SENDS AS", "RECEIVES"], rows);
}

/**
 * The problems as blocks, after a blank line: those one command fixes in
 * one block (the first one's words, the others' headlines under them),
 * none for those that settle by themselves. What is only good to know
 * (an update to take or leave) gets a block too, led by a dim i.
 */
function renderProblems(problems: Problem[]): string[] {
  const groups: Problem[][] = [];
  for (const problem of problems) {
    if (problem.severity === Severity.Settling) continue;
    const same = problem.run
      ? groups.find((group) => group[0]!.run?.text === problem.run!.text)
      : undefined;
    if (same) same.push(problem);
    else groups.push([problem]);
  }
  if (groups.length === 0) return [];
  return ["", ...groups.flatMap(renderBlock)];
}

function renderBlock([first, ...rest]: Problem[]): string[] {
  const problem = first!;
  const severities = [problem, ...rest].map((one) => one.severity);
  const worst = severities.includes(Severity.Error)
    ? Severity.Error
    : severities.includes(Severity.Warning)
      ? Severity.Warning
      : Severity.Info;
  return [
    `${GLYPHS[worst]} ${problem.headline}`,
    ...[...problem.detail, ...rest.map((other) => `${other.headline}.`)].map((line) =>
      chalk.dim(`  ${line}`),
    ),
    ...(problem.fix ? [`  Fix: ${problem.fix.human}`] : []),
    ...(problem.run
      ? [`  Run: ${problem.run.human}${problem.runNote ? `  ${chalk.dim(problem.runNote)}` : ""}`]
      : []),
    ...(problem.where ? [chalk.dim(`  ${problem.where}`)] : []),
  ];
}
