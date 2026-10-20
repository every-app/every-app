/**
 * `everyapp email set|unset|show`: the addresses an app sends as and
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
 * the ledger what exists: a reconcile that stops part-way warns, and
 * `everyapp deploy` (or this command again) finishes from the same row.
 * An app whose Worker isn't uploaded, or whose deployed manifest doesn't
 * declare inbound yet, gets no rule: its addresses are stored, and the
 * deploy that uploads the declaration checks and routes them. Nothing is
 * built or deployed. The Gateway reads a change within 30 seconds (it
 * caches the app's row that long); the CLI says "on the Gateway", never
 * "live".
 */
import { emailListProblems, type AppEmailConfig } from "@every-app/sdk/internal";
import type { LocalContext } from "@/context";
import {
  applyEmailRoutes,
  describeMailRoutes,
  emailDeclarations,
  planEmailRoutes,
} from "@/lib/app/emailRoutes";
import { readOwnedResources } from "@/lib/app/ownership";
import { canPromptInTerminal, type Confirm } from "@/lib/output/prompt";
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
import {
  loadEveryAppManifest,
  loadEveryAppManifestFile,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";
import type { GatewayCommandFlags } from "../flags";

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

export async function unset(
  this: LocalContext,
  flags: EmailFlags & { senders?: boolean; inbound?: boolean },
): Promise<void> {
  await runCommand(flags, (out) =>
    unsetEmail({ flags, out, senders: flags.senders, inbound: flags.inbound }),
  );
}

export async function show(this: LocalContext, flags: EmailFlags): Promise<void> {
  await runCommand(flags, (out) => showEmail({ flags, out }));
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
    throw new EveryAppError(
      "EMAIL_NOTHING_TO_SET",
      "Name what to set: --sender <pattern> and/or --inbound <address>.",
    );
  }
  if (senders !== undefined) {
    const problems = emailListProblems("senders", senders);
    if (problems.length > 0) {
      throw new EveryAppError("EMAIL_SENDER_INVALID", problems.join(" "), { data: { problems } });
    }
  }
  if (inbound !== undefined) {
    const problems = emailListProblems("inbound", inbound);
    if (problems.length > 0) {
      throw new EveryAppError("EMAIL_INBOUND_INVALID", problems.join(" "), { data: { problems } });
    }
  }

  // The manifest: what the app declares.
  const manifest = await loadManifest(options);
  const declares = emailDeclarations(manifest);
  if (senders !== undefined && !declares.sends) {
    throw new EveryAppError(
      "EMAIL_NOT_DECLARED",
      `${manifest.id} doesn't list email in its capabilities, so it can't send mail. Add capabilities: { email: { access: "write" } } to everyapp.config.ts and deploy, then set its senders.`,
    );
  }
  if (inbound !== undefined && !declares.receives) {
    throw new EveryAppError(
      "EMAIL_INBOUND_NOT_DECLARED",
      `${manifest.id} doesn't declare email: { inbound: true } in everyapp.config.ts, so no mail is routed to it. Declare it (its Worker exports email()) and deploy, then set its addresses.`,
    );
  }

  await changeEmail({
    ...options,
    manifest,
    change: {
      ...(senders !== undefined ? { senders: [...senders] } : {}),
      ...(inbound !== undefined ? { inbound: [...inbound] } : {}),
    },
    hostedCheck: senders !== undefined,
  });
}

/** `email unset`: the same pipeline with a list emptied. */
export async function unsetEmail(
  options: EmailOptions & { senders?: boolean; inbound?: boolean },
): Promise<void> {
  if (!options.senders && !options.inbound) {
    throw new EveryAppError("EMAIL_NOTHING_TO_UNSET", "Name what to clear: --senders and/or --inbound.");
  }
  // The manifest names the app; a declaration it dropped may still need clearing.
  const manifest = await loadManifest(options);
  await changeEmail({
    ...options,
    manifest,
    change: {
      ...(options.senders ? { senders: [] } : {}),
      ...(options.inbound ? { inbound: [] } : {}),
    },
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
  if (!app) {
    out.emit({
      type: "done",
      message: `${id} isn't deployed yet; its senders and addresses are set after its first \`${CLI} deploy\`.`,
      data: { app: { id, deployed: false }, declares },
    });
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
  const missing = inbound.filter((address) => !routed.includes(address));
  const stale = routed.filter((address) => !inbound.includes(address));
  // Addresses stored for an app that no longer declares inbound: no deploy
  // routes them, so the next command is the one that clears them, not a deploy.
  const undeclared = !declares.receives && inbound.length > 0;

  const lines = [
    declares.sends
      ? senders.length > 0
        ? `${id} sends as ${senders.join(", ")}.`
        : `${id} sends as the Gateway's sender only.`
      : `${id} doesn't list email in its capabilities, so it doesn't send mail.`,
    declares.receives
      ? inbound.length > 0
        ? pending
          ? `Mail to ${inbound.join(", ")} goes to ${workerName} once \`${CLI} deploy\` uploads it.`
          : `Mail to ${inbound.join(", ")} goes to ${workerName}.`
        : `${id} receives no mail.`
      : `${id} doesn't declare email: { inbound: true }, so no mail is routed to it.`,
    ...(undeclared
      ? [`Its addresses (${inbound.join(", ")}) stay stored until \`${CLI} email unset --inbound\` clears them.`]
      : []),
    ...(missing.length > 0 && !pending && !undeclared ? [`Not routed yet: ${missing.join(", ")}.`] : []),
    ...(stale.length > 0 ? [`Still routed, no longer listed: ${stale.join(", ")}.`] : []),
  ];
  const deployNext = pending ? inbound.length > 0 : (missing.length > 0 && !undeclared) || stale.length > 0;
  out.emit({
    type: "done",
    message: lines.join("\n"),
    data: {
      app: { id, workerName, status, deployed: !pending },
      declares,
      senders,
      inbound,
      routed,
      ...(deployNext ? { next: [`${CLI} deploy`] } : {}),
    },
  });
}

/** The manifest of the app in `cwd`, or the one `--manifest` names. */
function loadManifest(options: EmailOptions): Promise<EveryAppCliManifest> {
  return options.flags.manifest
    ? loadEveryAppManifestFile(options.flags.manifest)
    : loadEveryAppManifest(options.cwd ?? process.cwd());
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
    /** `set --sender`: a hosted Gateway takes no app senders. */
    hostedCheck: boolean;
    enableRouting?: boolean;
  },
): Promise<void> {
  const { out, manifest, change } = options;
  const { id } = manifest;
  const { cf, db, accountId, install, deployer } = await connect(options);
  const hosted = install.deploymentMode === "hosted";
  if (options.hostedCheck && hosted) {
    throw new EveryAppError(
      "EMAIL_SENDERS_HOSTED",
      "This Gateway is hosted and sends app mail from its own sender only for now; it takes no app senders. Leave --sender out.",
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
      out.emit({ type: "progress", step: "app.email", message: `Routing ${id}'s mail...` });
      try {
        await lease.check();
        ({ routed, removed, changed: reconciled } = await applyEmailRoutes({
          cf,
          gatewayDb: db,
          plan,
          onProgress: (message) => out.emit({ type: "progress", step: "app.email", message }),
        }));
      } catch (error) {
        out.emit({
          type: "warning",
          code: "EMAIL_ROUTES_PARTIAL",
          step: "app.email",
          message: `Saved ${id}'s addresses; routing them stopped at: ${errorMessage(error)} Run \`${CLI} deploy\` (in ${id}'s directory), or this command again, to finish.`,
        });
        throw error;
      }
    }

    const sendersChanged = !sameSet(next.senders, current.senders);
    const inboundChanged = !sameSet(next.inbound, current.inbound);
    const parts: string[] = [];
    if (change.senders !== undefined) {
      const as = next.senders.length > 0 ? next.senders.join(", ") : "the Gateway's sender only";
      parts.push(`${id} ${sendersChanged ? "sends" : "already sends"} as ${as}.`);
    }
    if (routeChange) {
      if (deferred) {
        parts.push(
          next.inbound.length > 0
            ? `Mail to ${next.inbound.join(", ")} goes to ${workerName} once \`${CLI} deploy\` uploads ${pending ? "it" : "the manifest that declares email: { inbound: true }"}.`
            : `${id} receives no mail.`,
        );
      } else if (plan) {
        // A rule made or mended counts as a change, whatever the list did.
        parts.push(
          inboundChanged || reconciled
            ? describeMailRoutes({
                appId: id,
                workerName,
                senders: next.senders,
                routed,
                removed,
                sendersSettable: emailDeclarations(manifest).sends && !hosted,
              })
            : `Mail to ${routed.join(", ")} already goes to ${workerName}.`,
        );
      } else {
        parts.push(`${id} already receives no mail.`);
      }
    }
    const deployNext = deferred && next.inbound.length > 0;
    out.emit({
      type: "done",
      message: parts.join(" "),
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
