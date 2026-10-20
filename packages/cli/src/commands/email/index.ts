/**
 * `everyapp email show|set|unset`: the addresses an app sends as and
 * receives at. Two lists, kept on the app's installation (its registry
 * row's `email_senders` and `email_inbound` on the Gateway), never in its
 * manifest: a release carries the manifest, and whoever installs it must
 * not inherit the first deployer's domain. The manifest declares what the
 * app does (`capabilities.email` says it sends, `email: { inbound: true }`
 * says its Worker exports an `email()` handler); the installation
 * configures as whom and at which addresses, with this command, in the
 * app's directory (or with `--manifest <path>`) after its first deploy.
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
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { emailListProblems, type AppEmailConfig } from "@every-app/sdk/internal";
import chalk from "chalk";
import type { LocalContext } from "@/context";
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
  readApp,
  readAppEmail,
  writeAppEmail,
} from "@/lib/gateway/registry";
import { loadEveryAppManifestFile, type EveryAppCliManifest } from "@/lib/manifest";
import { CLI, thisCommand } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { canPromptInTerminal, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import type { GatewayCommandFlags } from "../flags";
import { EmailList } from "./command";

interface EmailFlags extends GatewayCommandFlags {
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
}

/** The step a change runs under: its spinner says what it does. */
const EMAIL_STEP = "email.update";

export async function set(
  this: LocalContext,
  flags: EmailFlags & { sender?: string[]; inbound?: string[]; "enable-email-routing"?: boolean },
): Promise<void> {
  await runCommand(flags, (out) =>
    setEmail({
      flags,
      out,
      senders: flags.sender?.length ? flags.sender : undefined,
      inbound: flags.inbound?.length ? flags.inbound : undefined,
      enableRouting: flags["enable-email-routing"],
    }),
  );
}

export async function unset(this: LocalContext, flags: EmailFlags, ...lists: EmailList[]): Promise<void> {
  await runCommand(flags, (out) => unsetEmail({ flags, out, lists }));
}

export async function show(this: LocalContext, flags: EmailFlags): Promise<void> {
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
            rerun: thisCommand(
              [],
              process.argv.slice(2).map((arg) => (values.includes(arg) ? arg.toLowerCase() : arg)),
            ),
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
  const manifest = await loadManifest(options);
  const declares = emailDeclarations(manifest);
  const thenAgain = { rerun: `${CLI} deploy`, rerunNote: "then this command again" };
  if (senders !== undefined && !declares.sends) {
    throw new EveryAppError(
      "EMAIL_NOT_DECLARED",
      `${manifest.id} can't send mail yet\neveryapp.config.ts doesn't list email in its capabilities.`,
      { fix: 'add capabilities: { email: { access: "write" } } to everyapp.config.ts', ...thenAgain },
    );
  }
  if (inbound !== undefined && !declares.receives) {
    throw new EveryAppError(
      "EMAIL_INBOUND_NOT_DECLARED",
      `${manifest.id} can't receive mail yet\neveryapp.config.ts doesn't declare email: { inbound: true }.`,
      { fix: "declare email: { inbound: true } and export email() from the app's Worker", ...thenAgain },
    );
  }

  await changeEmail({
    ...options,
    manifest,
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
  const manifest = await loadManifest(options);
  await changeEmail({
    ...options,
    manifest,
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
  const manifest = await loadManifest(options);
  const { id } = manifest;
  const declares = emailDeclarations(manifest);
  const { db } = await connect(options);
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
    shown(
      chalk.dim(
        `${id} ${declares.sends ? "sends as the Gateway's sender" : "doesn't send email"} and ${declares.receives ? "receives no mail" : "doesn't receive email"}.`,
      ),
      {
        ...data,
        next: [
          ...(declares.sends
            ? [{ command: `${CLI} email set --sender '*@<domain>'`, note: "send as your own domain" }]
            : []),
          ...(declares.receives
            ? [{ command: `${CLI} email set --inbound <address>`, note: "receive mail" }]
            : []),
        ],
      },
    );
    return;
  }

  const unrouted = inbound.some((address) => !routed.includes(address));
  const deployNext = !undeclared && (unrouted || stale.length > 0);
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
    {
      ...data,
      ...(undeclared
        ? { next: [{ command: `${CLI} email unset inbound`, note: "clear the stored address" }] }
        : deployNext
          ? { next: [{ command: `${CLI} deploy`, note: "route the list as shown" }] }
          : {}),
    },
  );
}

/** The manifest of the app in `cwd`, or the one `--manifest` names. */
function loadManifest(options: EmailOptions): Promise<EveryAppCliManifest> {
  return options.flags.manifest
    ? loadEveryAppManifestFile(options.flags.manifest)
    : loadEveryAppManifestFile(path.join(options.cwd ?? process.cwd(), "everyapp.config.ts"), {
        message: "No everyapp.config.ts in this directory",
        fix: "run this from the app's directory, or pass --manifest <path>",
      });
}

function connect({ flags, out, createCf }: EmailOptions) {
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
    if (sendersChanged) notes.push("The Gateway picks up the change within 30 seconds.");
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
      message: [...said, ...notes].join(" "),
      display: [...lines, ...notes.map((note) => chalk.dim(note)), ...reply].join("\n"),
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
