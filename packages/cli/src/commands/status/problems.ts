/**
 * What `everyapp status` finds off, from the registry, the install row and
 * cf disagreeing, and what to do about each: a headline, why, and the
 * command (`run`) or remedy (`fix`). Each has a stable code for scripts
 * (`data.fixes`); people see them as blocks under the report.
 */
import type { AppSetup } from "@every-app/sdk/internal";
import chalk from "chalk";
import type { EmailRouteProblem } from "@/lib/app/emailRoutes";
import type { PublicRouteSummary } from "@/lib/app/publicRoutes";
import { describeUnmetSettings } from "@/lib/app/settings";
import type { DesiredState } from "@/lib/gateway/desiredState";
import type { InstallRecord } from "@/lib/gateway/install";
import { describeLeaseHolder, type LeaseHolder } from "@/lib/gateway/lease";
import type { GatewayOwner } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import { capitalize, listed } from "@/lib/output/text";

export enum ProblemCode {
  CheckoutBehind = "CHECKOUT_BEHIND",
  GatewayOutdated = "GATEWAY_OUTDATED",
  NoOwner = "NO_OWNER",
  GatewayNotInstalled = "GATEWAY_NOT_INSTALLED",
  GatewayNotUploaded = "GATEWAY_NOT_UPLOADED",
  GatewayChanged = "GATEWAY_CHANGED",
  BindingsDiffer = "BINDINGS_DIFFER",
  AppWorkerMissing = "APP_WORKER_MISSING",
  AppNotBound = "APP_NOT_BOUND",
  AppNotUploaded = "APP_NOT_UPLOADED",
  AppBinding = "APP_BINDING",
  AppNeedsSetup = "APP_NEEDS_SETUP",
  SettingsUnknown = "SETTINGS_UNKNOWN",
  EmailRoutesUnknown = "EMAIL_ROUTES_UNKNOWN",
  EmailInboundUndeclared = "EMAIL_INBOUND_UNDECLARED",
  EmailRoutePending = "EMAIL_ROUTE_PENDING",
  EmailRouteMissing = "EMAIL_ROUTE_MISSING",
  CertificatesUnknown = "CERTIFICATES_UNKNOWN",
  CertPending = "CERT_PENDING",
  AccessUnknown = "ACCESS_UNKNOWN",
  DeployRunning = "DEPLOY_RUNNING",
}

/** How a problem reads: its glyph, or none when the report's rows show it already. */
export enum Severity {
  /** Broken: ✗. */
  Error = "error",
  /** Something to do, or something the report couldn't check: !. */
  Warning = "warning",
  /** Good to know, nothing to fix (an update to take or leave): a dim i. */
  Info = "info",
  /** It settles by itself (a certificate, a first visit, a running deploy): the rows show it. */
  Settling = "settling",
}

/** Whether a person has to do something about it: errors and warnings count as problems to fix. */
export function needsFixing(problem: Problem): boolean {
  return problem.severity === Severity.Error || problem.severity === Severity.Warning;
}

/** Words with commands in them: plain for scripts, the commands bold for a person. */
interface Instruction {
  text: string;
  human: string;
}

/** `` command`Run ${`${CLI} setup`} now` ``: the interpolated commands bold for a person. */
function command(parts: TemplateStringsArray, ...commands: string[]): Instruction {
  return {
    text: parts.reduce((all, part, index) => all + part + (commands[index] ?? ""), ""),
    human: parts.reduce(
      (all, part, index) => all + part + (index < commands.length ? chalk.bold(commands[index]) : ""),
      "",
    ),
  };
}

export interface Problem {
  code: ProblemCode;
  severity: Severity;
  headline: string;
  /** Why, a sentence a line. */
  detail: string[];
  /** The command that fixes it, with a note after it. */
  run?: Instruction;
  runNote?: string;
  /** A remedy that isn't one command. */
  fix?: Instruction;
  /** Where to do it, said after the fix. */
  where?: string;
}

/** An app as status shows it: the registry's row, and whether the live Gateway binds it. */
export interface AppState {
  id: string;
  hostname: string;
  workerName: string;
  status: string;
  /** The version the install row names binds its Worker. */
  bound: boolean;
  /** Who deployed it last: an email, or `api-token:<account id>`. */
  deployedBy: string | null;
  /**
   * What its installation sends as and receives at (`everyapp email set`),
   * the addresses its deploys recorded routes for, and whether the manifest
   * it was deployed from declares inbound mail (without it no deploy routes
   * the stored addresses).
   */
  email: { senders: string[]; inbound: string[]; routed: string[]; declaresInbound: boolean };
  /** The routes its deployed manifest opens to anyone on the internet (`public` in everyapp.config.ts). */
  publicRoutes: PublicRouteSummary[];
  /**
   * What its manifest needs set and whether it is (lib/app/settings.ts):
   * null when it declares nothing to set.
   */
  setup: AppSetup | null;
}

/** An app that is up, as far as the registry and the live Gateway know, and so would open if ready. */
function isServed(app: Pick<AppState, "status" | "bound">): boolean {
  return app.bound && (app.status === "active" || app.status === "binding");
}

/** A served app whose required settings aren't all set: it doesn't open. */
export function needsSetup(app: Pick<AppState, "status" | "bound" | "setup">): boolean {
  return isServed(app) && app.setup !== null && !app.setup.ready;
}

/** This checkout against the live release, by the install row. */
export interface CheckoutState {
  /**
   * The live release was built from this checkout's Gateway sources (their
   * tree hash is the row's); null when either tree hash is unknown.
   */
  upToDate: boolean | null;
  /** The checkout's Gateway is older than the live one: `git pull`. */
  behind: boolean;
  checkout: { version: string; treeSha256: string | null } | null;
}

/** What cf couldn't tell: its error, for the problem that says so. */
export interface Unread {
  error: string;
}

const SETUP = `${CLI} setup`;
const DEPLOY = `${CLI} deploy`;
const UPDATE = `${CLI} update`;

/** The problem of a Gateway database with no install row: setup stopped before writing it. */
export function notInstalled(): Problem {
  return {
    code: ProblemCode.GatewayNotInstalled,
    severity: Severity.Warning,
    headline: "Setup stopped before it recorded the Gateway's install",
    detail: ["The Gateway's database exists, but nothing else was recorded."],
    run: command`${SETUP}`,
    runNote: "asks for the hostname again",
  };
}

export function problemsFor({
  install,
  desired,
  apps,
  unboundApps,
  owner,
  servingVersionId,
  inSync,
  waitingCertificates,
  certificates,
  access,
  leases,
  checkout,
  emailProblems,
  settings,
}: {
  install: InstallRecord;
  desired: DesiredState;
  apps: AppState[];
  /** The apps the live Gateway should bind and doesn't. */
  unboundApps: string[];
  owner: GatewayOwner | null;
  servingVersionId: string | null;
  inSync: boolean;
  waitingCertificates: string[];
  certificates: Unread | null;
  /** Why the Gateway Worker's settings couldn't be listed, when they couldn't. */
  access: Unread | null;
  leases: LeaseHolder[];
  checkout: CheckoutState;
  emailProblems: EmailRouteProblem[] | Unread;
  /** Why the Workers' secrets couldn't be listed, when they couldn't. */
  settings: Unread | null;
}): Problem[] {
  const problems: Problem[] = [];
  const live = install.releaseVersion;
  if (checkout.behind) {
    const version = checkout.checkout?.version;
    problems.push({
      code: ProblemCode.CheckoutBehind,
      severity: Severity.Warning,
      headline: "This checkout is behind the live Gateway",
      detail: [
        ...(version && version !== live ? [`This checkout has ${version}; ${live} is live.`] : []),
        "Deploys from here are refused until it catches up.",
      ],
      run: command`${"git pull"}`,
    });
  } else if (checkout.upToDate === false && install.liveVersionId !== null) {
    // Good to know, not a problem: nothing is broken, and the next deploy
    // that rebinds the Gateway brings the update anyway.
    problems.push({
      code: ProblemCode.GatewayOutdated,
      severity: Severity.Info,
      headline: "Your every-app folder has a newer Gateway than the one online",
      detail: ["Run update now, or leave it: the next new app's deploy updates it too."],
      run: command`${UPDATE}`,
      runNote: "updates it now",
    });
  }
  if (install.liveVersionId === null) {
    // Nobody can have claimed a Gateway that never served: setup finishes
    // the install, then prints the owner link.
    problems.push({
      code: ProblemCode.GatewayNotUploaded,
      severity: Severity.Warning,
      headline: "The Gateway's install stopped before its first upload",
      detail: ["Setup finishes it, then prints the link that creates the owner account."],
      run: command`${SETUP}`,
    });
  } else {
    if (servingVersionId !== install.liveVersionId) {
      problems.push({
        code: ProblemCode.GatewayChanged,
        severity: Severity.Warning,
        headline: "The Gateway Worker was changed outside everyapp",
        detail: ["It serves a version from the dashboard or API, not the one setup uploaded."],
        run: command`${SETUP}`,
        runNote: `redeploys ${live}, asking first`,
      });
    } else if (!inSync) {
      problems.push(bindingsDiffer(unboundApps));
    }
    if (!owner) {
      problems.push({
        code: ProblemCode.NoOwner,
        severity: Severity.Warning,
        headline: "No owner yet, so nobody can sign in",
        detail: ["Apps still deploy. Setup prints a one-time link that creates the owner account."],
        run: command`${SETUP}`,
      });
    }
  }
  for (const row of desired.missing) {
    problems.push({
      code: ProblemCode.AppWorkerMissing,
      severity: Severity.Error,
      headline: `${row.appId}'s Worker no longer exists`,
      detail: [],
      run: command`${DEPLOY} from ${row.appId}'s directory, or ${`${CLI} delete ${row.appId}`}`,
    });
  }
  for (const row of desired.skipped) {
    problems.push({
      code: ProblemCode.AppNotBound,
      severity: Severity.Error,
      headline: `The Gateway can't bind ${row.appId}`,
      detail: [`Its Worker isn't named the way the Gateway names ${row.appId}'s.`],
      run: command`${`${CLI} delete ${row.appId}`}`,
    });
  }
  const missing = new Set(desired.missing.map((row) => row.workerName));
  for (const app of apps) {
    if (missing.has(app.workerName)) continue;
    if (app.status === "pending") {
      problems.push({
        code: ProblemCode.AppNotUploaded,
        severity: Severity.Warning,
        headline: `${app.id} was registered, but none of its deploys finished`,
        detail: [],
        run: command`${DEPLOY} from the app's directory, or ${`${CLI} delete ${app.id}`}`,
      });
    } else if (app.status === "binding" && app.bound) {
      problems.push({
        code: ProblemCode.AppBinding,
        severity: Severity.Settling,
        headline: `${app.id} goes live on its first visit to https://${app.hostname}`,
        detail: [],
      });
    }
  }
  if (settings) {
    problems.push({
      code: ProblemCode.SettingsUnknown,
      severity: Severity.Warning,
      headline: "Couldn't list the Workers' secrets",
      detail: [`Cloudflare said: ${settings.error}. Whether the apps' settings are set isn't known.`],
    });
  }
  for (const app of apps) {
    if (needsSetup(app)) problems.push(appNeedsSetup(app.id, app.setup!));
  }
  if ("error" in emailProblems) {
    problems.push({
      code: ProblemCode.EmailRoutesUnknown,
      severity: Severity.Warning,
      headline: "Couldn't check the apps' Email Routing rules",
      detail: [`Cloudflare said: ${emailProblems.error}. Deleted rules won't show above.`],
    });
  }
  for (const app of apps) {
    const problem = emailProblemOf(app, "error" in emailProblems ? [] : emailProblems);
    if (problem) problems.push(problem);
  }
  if (certificates) {
    problems.push({
      code: ProblemCode.CertificatesUnknown,
      severity: Severity.Warning,
      headline: `Couldn't list ${install.zoneName}'s certificates`,
      detail: [`Cloudflare said: ${certificates.error}.`],
    });
  }
  if (waitingCertificates.length > 0) {
    problems.push({
      code: ProblemCode.CertPending,
      severity: Severity.Settling,
      headline: `No certificate yet for ${waitingCertificates.join(", ")}`,
      detail: ["It usually comes within minutes."],
    });
  }
  if (access) {
    problems.push({
      code: ProblemCode.AccessUnknown,
      severity: Severity.Warning,
      headline: "Couldn't check whether Cloudflare Access is on",
      detail: [`Cloudflare said: ${access.error}.`],
    });
  }
  for (const lease of leases) {
    problems.push({
      code: ProblemCode.DeployRunning,
      severity: Severity.Settling,
      headline: `${capitalize(describeLeaseHolder(lease))} is running`,
      detail: [],
    });
  }
  // What a person has to act on first; what is only good to know last.
  return [
    ...problems.filter((problem) => problem.severity !== Severity.Info),
    ...problems.filter((problem) => problem.severity === Severity.Info),
  ];
}

/**
 * An app that doesn't open until something is set: each unmet setting
 * with why it is needed, where its key comes from and the skill's setup
 * guide for it, then the one command that opens it, `everyapp configure
 * <app>`, which asks for each of them.
 */
function appNeedsSetup(appId: string, setup: AppSetup): Problem {
  return {
    code: ProblemCode.AppNeedsSetup,
    severity: Severity.Warning,
    headline: `${appId} needs setup`,
    detail: describeUnmetSettings(setup.unmet),
    ...(setup.command ? { run: command`${setup.command.command}` } : {}),
  };
}

/** The live Gateway binds or publishes other apps than its registry lists. */
function bindingsDiffer(unboundApps: string[]): Problem {
  if (unboundApps.length === 0) {
    return {
      code: ProblemCode.BindingsDiffer,
      severity: Severity.Warning,
      headline: "The live Gateway's apps or hostnames are out of date",
      detail: ["It still serves something that was removed, or not yet what was added."],
      run: command`${SETUP}`,
    };
  }
  const names = listed(unboundApps);
  return {
    code: ProblemCode.BindingsDiffer,
    severity: Severity.Warning,
    headline: `The live Gateway doesn't serve ${names}`,
    detail: [
      unboundApps.length === 1
        ? `${names} is uploaded, but the live Gateway doesn't bind it.`
        : `${names} are uploaded, but the live Gateway doesn't bind them.`,
    ],
    run: command`${SETUP}`,
  };
}

/**
 * An app's mail, against what it stores: addresses its deployed manifest
 * doesn't route (clear them, or deploy a manifest that declares them), or
 * routes that don't match its addresses or don't deliver (a deploy
 * reroutes them), as one problem.
 */
function emailProblemOf(app: AppState, emailProblems: EmailRouteProblem[]): Problem | null {
  const { inbound, routed, declaresInbound } = app.email;
  if (inbound.length > 0 && !declaresInbound) {
    const addresses = listed(inbound);
    return {
      code: ProblemCode.EmailInboundUndeclared,
      severity: Severity.Warning,
      headline: `${app.id} has ${inbound.length === 1 ? "an inbound address" : "inbound addresses"}, but its config doesn't turn inbound mail on`,
      detail: [`${app.id} was deployed without email: { inbound: true }, so nothing routes ${addresses}.`],
      fix: command`declare it in everyapp.config.ts and run ${DEPLOY}, or drop ${inbound.length === 1 ? "the address" : "the addresses"}: ${`${CLI} email unset inbound`}`,
      where: `Run either from ${app.id}'s directory.`,
    };
  }
  // The stored list is the intent, the ledger what exists.
  const notRouted = inbound.filter((address) => !routed.includes(address));
  const stale = routed.filter((address) => !inbound.includes(address));
  const undelivered = emailProblems.filter((problem) => problem.workerName === app.workerName);
  if (notRouted.length + stale.length + undelivered.length === 0) return null;
  const clauses = [
    ...(notRouted.length > 0
      ? [`${listed(notRouted)} ${notRouted.length === 1 ? "isn't" : "aren't"} routed yet`]
      : []),
    ...undelivered.map((problem) => `${problem.address} gets no mail: ${problem.problem}`),
    ...(stale.length > 0
      ? [`${listed(stale)} ${stale.length === 1 ? "is" : "are"} still routed, though no longer listed`]
      : []),
  ];
  const broken = notRouted.length + undelivered.length;
  const headline =
    stale.length > 0
      ? `${app.id}'s mail routes don't match its addresses`
      : undelivered.length === 0
        ? `${app.id} doesn't get mail at ${listed(notRouted)} yet`
        : broken === 1
          ? `${app.id} doesn't get mail at ${undelivered[0]!.address}`
          : `${app.id} doesn't get mail at ${broken} of its addresses`;
  return {
    code: undelivered.length > 0 ? ProblemCode.EmailRouteMissing : ProblemCode.EmailRoutePending,
    severity: Severity.Warning,
    headline,
    detail:
      stale.length === 0 && undelivered.length === 0
        ? []
        : stale.length === 0 && broken === 1
          ? [`${capitalize(undelivered[0]!.problem)}.`]
          : [`${clauses.join("; ")}.`],
    run: command`${DEPLOY} from ${app.id}'s directory`,
  };
}
