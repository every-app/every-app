/**
 * `everyapp email show|set|unset`: the addresses an app sends as and
 * receives at. Two lists, kept on the app's installation (its registry
 * row's `email_senders` and `email_inbound` on the Gateway), never in its
 * manifest: a release carries the manifest, and whoever installs it must
 * not inherit the first deployer's domain. The manifest declares what the
 * app does (`capabilities.email` says it sends, `email: { inbound: true }`
 * says its Worker exports an `email()` handler); the installation
 * configures as whom and at which addresses, with this command, in the
 * app's directory (or with `--manifest <path>`, or `--app <id>` for an app
 * installed without its source, whose deployed manifest the Gateway's row
 * holds) after its first deploy.
 *
 * `set` replaces each list it names and keeps the other; `unset` clears
 * the lists it names. Every check runs before the first write: the lists'
 * patterns (the one validator the deploy's checks share), the manifest's
 * declarations, the Gateway (a hosted one takes no app senders), the app's
 * row, and for inbound addresses the Email Routing plan `deploy` makes
 * (the zone, taken addresses, catch-alls on an apex only, routing off for
 * a domain). Then, under the app's lease, the row is written and the
 * routes are made from it, so the stored list is always the intent and
 * the ledger what exists: a reconcile that stops part-way says the
 * addresses are saved, and `everyapp deploy` (or this command again)
 * finishes from the same row. An app whose Worker isn't uploaded, or whose
 * deployed manifest doesn't declare inbound yet, gets no rule: its
 * addresses are stored, and the deploy that uploads the declaration checks
 * and routes them. Nothing is built or deployed. The Gateway reads a
 * change within 30 seconds (it caches the app's row that long); the CLI
 * says "on the Gateway", never "live".
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { emailListProblems, type AppEmailConfig } from "@every-app/sdk/internal";
import chalk from "chalk";
import {
  applyEmailRoutes,
  emailDeclarations,
  planEmailRoutes,
  unsentDomains,
} from "@/lib/app/emailRoutes";
import { readOwnedResources } from "@/lib/app/ownership";
import type { CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { acquireAppLease, LeasePurpose } from "@/lib/gateway/lease";
import {
  findRegisteredApp,
  listApps,
  readApp,
  readAppEmail,
  writeAppEmail,
} from "@/lib/gateway/registry";
import { loadEveryAppManifestFile, type EveryAppCliManifest } from "@/lib/manifest";
import { CLI, thisCommand } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { canPromptInTerminal, choose, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import type { GatewayCommandFlags } from "../flags";
import { storedManifestOf } from "../secret";
import { EmailList } from "./command";

interface EmailFlags extends GatewayCommandFlags {
  /** The installed app's id: its manifest is read from the Gateway's registry row. */
  app?: string;
  manifest?: string;
}

/** What the handlers take from the command line, and the seams tests use. */
interface EmailOptions {
  flags: EmailFlags;
  out: EventSink;
  /** The directory whose everyapp.config.ts names the app (default: the working directory). */
  cwd?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** Whether a person is at the terminal (default: canPromptInTerminal); tests. */
  interactive?: boolean;
  /** The Email Routing confirm (tests). */
  confirm?: Confirm;
  /** Which of the Gateway's apps, when nothing names one (default: a terminal prompt); tests. */
  chooseApp?: (choices: ReadonlyArray<{ label: string; hint?: string; value: string }>) => Promise<string>;
  /** The Gateway connection `--app` made to read the manifest, reused by the change. */
  connection?: Connection;
}

/** The step a change runs under: its spinner says what it does. */
const EMAIL_STEP = "email.update";

export async function set(
  flags: EmailFlags & {
    sender?: string[];
    inbound?: string[];
    "enable-email-routing"?: boolean;
    "replace-mx"?: boolean;
  },
): Promise<void> {
  await runCommand(flags, (out) =>
    setEmail({
      flags,
      out,
      senders: flags.sender?.length ? flags.sender : undefined,
      inbound: flags.inbound?.length ? flags.inbound : undefined,
      enableRouting: flags["enable-email-routing"],
      replaceMx: flags["replace-mx"],
    }),
  );
}

export async function unset(flags: EmailFlags, ...lists: EmailList[]): Promise<void> {
  await runCommand(flags, (out) => unsetEmail({ flags, out, lists }));
}

export async function show(flags: EmailFlags): Promise<void> {
  await runCommand(flags, (out) => showEmail({ flags, out }));
}

/**
 * Refuse a list with problems, each said once: one is the headline (its
 * rule under it, and the lowercased command when that is all it needs),
 * several are a count and a bullet each.
 */
function assertValidList(kind: "senders" | "inbound", values: readonly string[]): void {
  const problems = [...new Set(emailListProblems(kind, values))];
  if (problems.length === 0) return;
  const flag = kind === "senders" ? "--sender" : "--inbound";
  const code = kind === "senders" ? "EMAIL_SENDER_INVALID" : "EMAIL_INBOUND_INVALID";
  if (problems.length > 1) {
    throw new EveryAppError(
      code,
      [`${problems.length} problems with ${flag}`, ...problems.map((problem) => `• ${problem}`)].join("\n"),
      { data: { problems } },
    );
  }
  const [headline, rule] = problems[0]!.split(": ");
  const lowercased = emailListProblems(kind, values.map((value) => value.toLowerCase())).length === 0;
  throw new EveryAppError(
    code,
    rule ? `${headline}\n${rule.charAt(0).toUpperCase()}${rule.slice(1)}` : headline!,
    {
      ...(lowercased
        ? {
            rerun: thisCommand([], {
              argv: process.argv
                .slice(2)
                .map((arg) => (values.includes(arg) ? arg.toLowerCase() : arg)),
            }),
          }
        : {}),
      data: { problems },
    },
  );
}

/** `email set`: the checks, the lease, the write, the routes, one `done`. */
export async function setEmail(
  options: EmailOptions & {
    senders?: readonly string[];
    inbound?: readonly string[];
    enableRouting?: boolean;
    replaceMx?: boolean;
  },
): Promise<void> {
  const { senders, inbound } = options;
  // The arguments first: no manifest, no network.
  if (senders === undefined && inbound === undefined) {
    throw new EveryAppError("EMAIL_NOTHING_TO_SET", "Name what to set: --sender, --inbound, or both", {
      rerun: `${CLI} email set --help`,
    });
  }
  if (senders !== undefined) assertValidList("senders", senders);
  if (inbound !== undefined) assertValidList("inbound", inbound);

  // The manifest: what the app declares.
  const { manifest, connection, deployed } = await loadManifest(options);
  const declares = emailDeclarations(manifest);
  const declaredIn = deployed ? "Its deployed manifest" : (options.flags.manifest ?? "everyapp.config.ts");
  // From the directory: the fix is the source's, or the app is another one.
  // From the row (`--app`): the deployed release is what it is.
  const remedy = (fix: string) =>
    deployed
      ? { fix: `deploy ${manifest.id} from source with ${fix}; an installed release can't change it` }
      : {
          fix: `${fix} to everyapp.config.ts, or pass --app <id> if you meant another app`,
          rerun: `${CLI} deploy`,
          rerunNote: "then this command again",
        };
  if (senders !== undefined && !declares.sends) {
    throw new EveryAppError(
      "EMAIL_NOT_DECLARED",
      `${manifest.id} can't send mail yet\n${declaredIn} doesn't list email in its capabilities.`,
      remedy('capabilities: { email: { access: "write" } }'),
    );
  }
  if (inbound !== undefined && !declares.receives) {
    throw new EveryAppError(
      "EMAIL_INBOUND_NOT_DECLARED",
      `${manifest.id} can't receive mail yet\n${declaredIn} doesn't declare email: { inbound: true }.`,
      remedy("email: { inbound: true } (and an email() export from the Worker)"),
    );
  }

  await changeEmail({
    ...options,
    manifest,
    connection,
    change: {
      ...(senders !== undefined ? { senders: [...senders] } : {}),
      ...(inbound !== undefined ? { inbound: [...inbound] } : {}),
    },
    spin:
      senders !== undefined && inbound !== undefined
        ? "Updating email..."
        : senders !== undefined
          ? "Updating senders..."
          : `Routing ${inbound!.join(", ")}...`,
    hostedCheck: senders !== undefined,
  });
}

/** `email unset`: the same pipeline with a list emptied. */
export async function unsetEmail(options: EmailOptions & { lists: readonly EmailList[] }): Promise<void> {
  // The manifest names the app; a declaration it dropped may still need clearing.
  const { manifest, connection } = await loadManifest(options);
  await changeEmail({
    ...options,
    manifest,
    connection,
    change: {
      ...(options.lists.includes(EmailList.Senders) ? { senders: [] } : {}),
      ...(options.lists.includes(EmailList.Inbound) ? { inbound: [] } : {}),
    },
    spin: "Clearing email...",
    hostedCheck: false,
  });
}

/** `email show`: the installation's lists against what the manifest declares and what is routed. */
export async function showEmail(options: EmailOptions): Promise<void> {
  const { out } = options;
  const { manifest, connection } = await loadManifest(options);
  const { id } = manifest;
  const declares = emailDeclarations(manifest);
  const { db, install } = await connect({ ...options, connection });
  // A hosted Gateway takes no app senders (`set --sender` refuses there), so
  // no next step names that command on one.
  const sendersSettable = declares.sends && install.deploymentMode !== "hosted";
  const app = await findRegisteredApp(db, id);
  const shown = (display: string, data: Record<string, unknown>) =>
    out.emit({ type: "done", message: stripVTControlCharacters(display), display, data });
  if (!app) {
    shown(
      chalk.dim(`${id} isn't deployed yet. Senders and inbound addresses can be set after its first deploy.`),
      { app: { id, deployed: false }, declares, next: [`${CLI} deploy`] },
    );
    return;
  }
  const { workerName, status } = app;
  const { senders, inbound } = app.email;
  // The Worker isn't uploaded: no route names it yet, the next deploy makes them.
  const pending = status === "pending";
  // A row claimed before its rule was made (a reconcile that stopped there) isn't a route.
  const routed = (await readOwnedResources(db, workerName))
    .filter((resource) => resource.kind === "email-route" && resource.resourceId !== null)
    .map((resource) => resource.name);
  const stale = routed.filter((address) => !inbound.includes(address));
  // Addresses stored for an app that no longer declares inbound: no deploy
  // routes them, so the next command is the one that clears them, not a deploy.
  const undeclared = !declares.receives && inbound.length > 0;
  const data = {
    app: { id, workerName, status, deployed: !pending },
    declares,
    senders,
    inbound,
    routed,
  };

  const rows = [
    ...senders.map((sender) => [sender, "sender", declares.sends ? "allowed" : chalk.yellow("not declared")]),
    ...inbound.map((address) => [
      address,
      "inbound",
      undeclared
        ? chalk.yellow("not declared")
        : routed.includes(address)
          ? chalk.green("routed")
          : chalk.yellow("not routed yet"),
    ]),
    ...stale.map((address) => [address, "inbound", chalk.yellow("removed, still routed")]),
  ];
  // What a side the manifest declares takes while nothing is stored for it.
  const senderNext = { command: `${CLI} email set --sender '*@<domain>'`, note: "send as your own domain" };
  const inboundNext = { command: `${CLI} email set --inbound <address>`, note: "receive mail" };
  if (rows.length === 0) {
    if (!declares.sends && !declares.receives) {
      shown(
        [
          `${id} doesn't send or receive email.`,
          'To send, add capabilities: { email: { access: "write" } } to everyapp.config.ts.',
          "To receive, add email: { inbound: true } to everyapp.config.ts.",
        ]
          .map((line) => chalk.dim(line))
          .join("\n"),
        data,
      );
      return;
    }
    const next = [...(sendersSettable ? [senderNext] : []), ...(declares.receives ? [inboundNext] : [])];
    shown(
      chalk.dim(
        `${id} ${declares.sends ? "sends as the Gateway's sender" : "doesn't send email"} and ${declares.receives ? "receives no mail" : "doesn't receive email"}.`,
      ),
      { ...data, ...(next.length > 0 ? { next } : {}) },
    );
    return;
  }

  const unrouted = inbound.some((address) => !routed.includes(address));
  const deployNext = !undeclared && (unrouted || stale.length > 0);
  // The list's own fix first (clear it, or deploy to route it), then the
  // side the manifest declares with nothing stored for it yet.
  const next = [
    ...(undeclared
      ? [{ command: `${CLI} email unset inbound`, note: "clear the stored address" }]
      : deployNext
        ? [{ command: `${CLI} deploy`, note: "route the list as shown" }]
        : []),
    ...(sendersSettable && senders.length === 0 ? [senderNext] : []),
    ...(declares.receives && inbound.length === 0 ? [inboundNext] : []),
  ];
  shown(
    [
      ...formatTable(["ADDRESS", "ROLE", "STATUS"], rows),
      ...(declares.sends && senders.length === 0 ? ["", chalk.dim(`${id} sends as the Gateway's sender only.`)] : []),
      ...(undeclared
        ? [
            ...(declares.sends && senders.length === 0 ? [] : [""]),
            chalk.dim("everyapp.config.ts no longer declares email: { inbound: true }, so this address isn't used."),
          ]
        : []),
    ].join("\n"),
    { ...data, ...(next.length > 0 ? { next } : {}) },
  );
}

/**
 * The app's manifest: the deployed one its Gateway row stores (`--app`,
 * which wins over the others), the file `--manifest` names, or the
 * everyapp.config.ts in `cwd`. With none of those, a person at a terminal
 * picks one of the Gateway's apps, as if they had passed `--app`.
 */
async function loadManifest(options: EmailOptions): Promise<{
  manifest: EveryAppCliManifest;
  connection?: Connection;
  /** Read from the Gateway's row (`--app` or the pick), not a file. */
  deployed: boolean;
}> {
  const { flags } = options;
  if (flags.app) return { ...(await deployedManifest(options, flags.app)), deployed: true };
  if (flags.manifest) return { manifest: await loadEveryAppManifestFile(flags.manifest), deployed: false };
  const file = path.join(options.cwd ?? process.cwd(), "everyapp.config.ts");
  const notHere = {
    message: "No everyapp.config.ts in this directory",
    fix: "run this from the app's directory, or pass --app <id> or --manifest <path>",
  };
  if (existsSync(file) || !(options.interactive ?? canPromptInTerminal(flags.json ?? false))) {
    return { manifest: await loadEveryAppManifestFile(file, notHere), deployed: false };
  }
  const connection = await connect(options);
  const apps = (await listApps(connection.db)).filter((app) => app.workerName);
  if (apps.length === 0) {
    throw new EveryAppError("APP_NOT_FOUND", "No apps are deployed to this Gateway yet", { fix: notHere.fix });
  }
  const pick =
    options.chooseApp ??
    ((choices: ReadonlyArray<{ label: string; hint?: string; value: string }>) =>
      choose("Which app?", choices));
  const appId = await pick(apps.map((app) => ({ label: app.appSlug, hint: app.hostname, value: app.appSlug })));
  return { ...(await deployedManifest({ ...options, connection }, appId)), deployed: true };
}

/** A registered app's deployed manifest, from its Gateway row. */
async function deployedManifest(options: EmailOptions, appId: string) {
  const connection = await connect(options);
  const found = await findRegisteredApp(connection.db, appId);
  if (!found) {
    throw new EveryAppError(
      "APP_NOT_FOUND",
      `${appId} isn't deployed to this Gateway\nAn app's email can be set after its first deploy. Nothing was changed.`,
      { rerun: `${CLI} status`, rerunNote: "lists its apps" },
    );
  }
  return { manifest: storedManifestOf(found), connection };
}

type Connection = Awaited<ReturnType<typeof connectToGateway>>;

/** The Gateway: the connection `--app` already made, or a new one. */
function connect({ flags, out, createCf, connection }: EmailOptions): Promise<Connection> {
  if (connection) return Promise.resolve(connection);
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Steps 3 to 10 of `set` and `unset`: the Gateway, the app, its lease, the
 * plan before any write, the row, the routes, one `done`. `change` names
 * the lists to replace; a list not named is kept.
 */
async function changeEmail(
  options: EmailOptions & {
    manifest: EveryAppCliManifest;
    change: Partial<AppEmailConfig>;
    /** The spinner's label while it connects, checks and writes. */
    spin: string;
    /** `set --sender`: a hosted Gateway takes no app senders. */
    hostedCheck: boolean;
    enableRouting?: boolean;
    replaceMx?: boolean;
  },
): Promise<void> {
  const { out, manifest, change } = options;
  const { id } = manifest;
  out.emit({ type: "step", step: EMAIL_STEP, status: "start", message: options.spin });
  const { cf, db, accountId, install, deployer } = await connect(options);
  const hosted = install.deploymentMode === "hosted";
  if (options.hostedCheck && hosted) {
    throw new EveryAppError(
      "EMAIL_SENDERS_HOSTED",
      "This Gateway doesn't take app senders\nHosted Gateways send all app mail from their own sender for now.",
    );
  }
  const app = await readApp(db, id);
  const { workerName } = app;
  const pending = app.status === "pending";

  const lease = await acquireAppLease(
    { db, out },
    { workerName, appId: id, purpose: LeasePurpose.AppEmail },
  );
  try {
    const current = await readAppEmail(db, app.id);
    const next: AppEmailConfig = {
      senders: change.senders ?? current.senders,
      inbound: change.inbound ?? current.inbound,
    };
    const routeChange = change.inbound !== undefined;
    // No rule for a Worker that isn't uploaded, or whose deployed manifest
    // declares no email() handler: the row holds the list, and the deploy
    // that uploads the declaration checks and routes it. An emptied list
    // still removes the routes there are.
    const deferred = pending || (!app.declaresInbound && next.inbound.length > 0);

    // Every check before any write: a refusal here leaves the row as it was.
    const plan =
      routeChange && !deferred
        ? await planEmailRoutes({
            cf,
            gatewayDb: db,
            accountId,
            workerName,
            addresses: next.inbound,
            interactive: options.interactive ?? canPromptInTerminal(options.flags.json ?? false),
            enableRouting: options.enableRouting,
            replaceMx: options.replaceMx,
            confirm: options.confirm,
          })
        : null;

    await lease.check();
    await writeAppEmail(db, id, next, deployer);

    // The row is the intent; the routes follow it. From here on the
    // addresses are saved: a stop (the lease lost too) says so.
    let routed: string[] = [];
    let removed: string[] = [];
    let reconciled = false;
    if (plan) {
      try {
        await lease.check();
        ({ routed, removed, changed: reconciled } = await applyEmailRoutes({
          cf,
          gatewayDb: db,
          plan,
          onProgress: (message) => out.emit({ type: "progress", step: "app.email", message }),
        }));
      } catch (error) {
        throw new EveryAppError(
          "EMAIL_ROUTES_PARTIAL",
          `Inbound addresses saved, but routing them stopped part-way\n${errorMessage(error)}`,
          {
            retryable: true,
            rerunNote: `again, or ${CLI} deploy, to finish`,
            data: { saved: next.inbound, cause: error instanceof EveryAppError ? error.code : null },
          },
        );
      }
    }
    out.emit({ type: "step", step: EMAIL_STEP, status: "ok" });

    const sendersChanged = !sameSet(next.senders, current.senders);
    const inboundChanged = !sameSet(next.inbound, current.inbound);
    // What changed, each a ticked line; what was already so, dim. Said as
    // sentences in the event's message.
    const lines: string[] = [];
    const said: string[] = [];
    const done = (line: string, detail?: string) => {
      lines.push(ticked(line, detail));
      said.push(`${line}${detail ? ` (${detail})` : ""}.`);
    };
    const already = (line: string) => {
      lines.push(chalk.dim(`Nothing changed. ${line}`));
      said.push(line);
    };
    if (change.senders !== undefined) {
      if (!sendersChanged) {
        already(
          next.senders.length > 0
            ? `${id} already sends as ${next.senders.join(", ")}.`
            : `${id} already sends as the Gateway's sender only.`,
        );
      } else if (next.senders.length > 0) done(`${id} sends as ${next.senders.join(", ")}`);
      else done("Senders cleared", "sends as the Gateway's sender");
    }
    const notes: string[] = [];
    if (routeChange) {
      if (deferred && next.inbound.length > 0) {
        done(`Saved ${next.inbound.join(", ")}`);
        notes.push(`It's routed to ${id} on the next deploy.`);
      } else if (inboundChanged || reconciled) {
        if (routed.length > 0) done(`Mail to ${routed.join(", ")} goes to ${id}`);
        if (removed.length > 0) done(`Stopped routing ${removed.join(", ")}`);
        if (routed.length === 0 && removed.length === 0) done("Inbound addresses cleared");
      } else {
        already(
          routed.length > 0
            ? `Mail to ${routed.join(", ")} already goes to ${id}.`
            : `${id} already receives no mail.`,
        );
      }
    }
    // How soon the Gateway serves it is the --verbose account's, not the result's.
    const detail = sendersChanged ? ["The Gateway picks up the change within 30 seconds."] : [];
    // Replying from an address routed now needs a sender on its domain.
    const unsent =
      emailDeclarations(manifest).sends && !hosted && routed.length > 0 && (inboundChanged || reconciled)
        ? unsentDomains(routed, next.senders)
        : [];
    const reply =
      unsent.length > 0
        ? [
            "",
            chalk.dim(`To reply from ${unsent.join(", ")}, set ${unsent.length === 1 ? "it" : "them"} up for Email Sending, then:`),
            // --sender replaces the list: the senders there are, and the new ones.
            `  ${chalk.bold(`${CLI} email set ${[...next.senders, ...unsent.map((domain) => `*@${domain}`)].map((sender) => `--sender '${sender}'`).join(" ")}`)}`,
          ]
        : [];
    const deployNext = deferred && next.inbound.length > 0;
    out.emit({
      type: "done",
      message: [...said, ...notes, ...detail].join(" "),
      display: [...lines, ...notes.map((note) => chalk.dim(note)), ...reply].join("\n"),
      ...(detail.length > 0 ? { detail: detail.join("\n") } : {}),
      data: {
        app: { id, workerName, status: app.status },
        senders: { value: next.senders, changed: sendersChanged },
        inbound: { value: next.inbound, changed: inboundChanged, routed, removed },
        ...(deployNext ? { next: [`${CLI} deploy`] } : {}),
      },
    });
  } finally {
    await lease.release();
  }
}
