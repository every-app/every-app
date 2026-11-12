/**
 * `everyapp access on|off|show`: Cloudflare Access in front of the Gateway
 * and its apps, the outer ring of docs/runbooks/cloudflare-access.md, from
 * the Cloudflare login alone. Nothing is kept on this machine: the Access
 * applications are found again by what they cover (the Gateway's host,
 * `*.<app base domain>`), the policy by its name, and the Gateway's
 * settings by their names on the Worker.
 *
 * `on` is one fixed recipe, safe to run again any time:
 *
 *  1. the Zero Trust team (created, with a name, when the account has none);
 *  2. two ways to sign in: Sign in with Cloudflare for the members of the
 *     operator's Cloudflare account, the one-time PIN for everyone else;
 *  3. the policy "Every App gateway members", whose one rule asks the
 *     Gateway whether the person who signed in is a member or an invitee
 *     (External Evaluation: apps/every-app-gateway/src/server/
 *     access-evaluation.ts), so an invitation needs no change in Access;
 *  4. the two applications (the apps' first, so its AUD exists before the
 *     Gateway's settings name it), with the Gateway's machine endpoints and
 *     every served app's public routes let through;
 *  5. the Gateway's three settings, in one new version of the Worker.
 *
 * While Access is on, `deploy` and `delete` run the same recipe, unattended,
 * when they changed an app's public routes, and `update` after every run
 * (`updateAccessIfOn`). `off` is the reverse: the settings go first, so the
 * Gateway stops requiring Access at once; then the two applications.
 *
 * Either way, once the Gateway's settings are written, `access.changed`
 * is queued for the install organization's event subscribers
 * (lib/gateway/events.ts).
 */
import chalk from "chalk";
import {
  applicationUpdateBody,
  createAccessOrganization,
  createAccessPolicy,
  createCloudflareIdentityProvider,
  createOneTimePinProvider,
  deleteAccessApplication,
  getAccessOrganizationOrNone,
  listAccessApplications,
  listAccessIdentityProviders,
  listAccessPolicies,
  updateAccessApplication,
  updateAccessPolicyRules,
  type AccessApplication,
  type AccessIdentityProvider,
  type AccessPolicy,
} from "@/lib/cf/access";
import type { D1Database } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import {
  accessApplicationNames,
  APPS_APPLICATION_NAME,
  applyApplication,
  emitPlanWarnings,
  GATEWAY_APPLICATION_NAME,
  POLICY_NAME,
  readPublicSurfaces,
  scopeOf,
  SESSION,
  type ApplicationOutcome,
} from "@/lib/access/applications";
import {
  allowedSignInProviders,
  appsDestinations,
  CLOUDFLARE_IDP_TYPE,
  describeSignInMethods,
  externalEvaluationRule,
  findAccessApplications,
  gatewayDestination,
  missingSignInProviders,
  sameRules,
  splitDestinations,
} from "@/lib/access/plan";
import { clearAccessOffChoice, writeAccessOffChoice } from "@/lib/access/record";
import { ACCESS_SETTINGS, accessStateOf } from "@/lib/access/settings";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import type { InstallRecord } from "@/lib/gateway/install";
import { operatorActor, queueEventFromCli } from "@/lib/gateway/events";
import { installOrganization, type Deployer } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { askText, canPromptInTerminal, confirmUnlessYes, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts } from "@/lib/output/table";
import { listed, plural } from "@/lib/output/text";
import { applyGatewaySettings } from "../secret";
import type { GatewayCommandFlags } from "../flags";

/** The default Gateway's names `on` makes and `teardown` finds (lib/access/applications.ts; a named Gateway's: `accessApplicationNames`). */
export { APPS_APPLICATION_NAME, GATEWAY_APPLICATION_NAME, POLICY_NAME };
const STEP = "access.update";

interface AccessFlags extends GatewayCommandFlags {
  yes?: boolean;
}

/** What the handlers take from the command line, and the seams tests use. */
interface AccessOptions {
  flags: AccessFlags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** Whether a person is at the terminal (default: canPromptInTerminal); tests. */
  interactive?: boolean;
  confirm?: Confirm;
  /** Asks the person at the terminal for the team name (tests answer for them). */
  askTeam?: (suggested: string) => Promise<string>;
}

interface OnOptions extends AccessOptions {
  team?: string;
}

export async function on(flags: GatewayCommandFlags & { team?: string }): Promise<void> {
  await runCommand(flags, (out) => turnAccessOn({ flags, out, team: flags.team }));
}

export async function off(flags: AccessFlags): Promise<void> {
  await runCommand(flags, (out) => turnAccessOff({ flags, out }));
}

export async function show(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => showAccess({ flags, out }));
}

/** A team name: the label before .cloudflareaccess.com (what the Gateway's config accepts). */
const TEAM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function connect({ flags, out, createCf }: AccessOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

/** Access settings mean nothing on a hosted Gateway; it ignores them. */
function refuseHosted(install: InstallRecord): void {
  if (install.deploymentMode === "hosted") {
    throw new EveryAppError(
      "ACCESS_HOSTED",
      "This Gateway can't be put behind Cloudflare Access\nHosted Gateways ignore the Access settings.",
    );
  }
}

/** Whether the Gateway has been claimed: until it has an owner, Access would let nobody in. */
async function hasOwner(db: D1Database): Promise<boolean> {
  const [rows = []] = await db.run([{ sql: "SELECT 1 AS one FROM members WHERE role = 'owner' LIMIT 1" }]);
  return rows.length > 0;
}

/** Sign in with Cloudflare and the one-time PIN on the team: the providers it had, with whichever of the two it lacked added. */
async function ensureSignInProviders(
  cf: CfRunner,
  out: EventSink,
): Promise<{ providers: AccessIdentityProvider[]; added: string[] }> {
  let providers = await listAccessIdentityProviders(cf);
  const missing = missingSignInProviders(providers);
  const added: string[] = [];
  if (missing.cloudflare) {
    out.emit({ type: "progress", step: STEP, message: "Adding Sign in with Cloudflare (members of this Cloudflare account)" });
    providers = [...providers, await createCloudflareIdentityProvider(cf)];
    added.push("Sign in with Cloudflare");
  }
  if (missing.pin) {
    out.emit({ type: "progress", step: STEP, message: "Adding the one-time PIN" });
    providers = [...providers, await createOneTimePinProvider(cf)];
    added.push("the one-time PIN");
  }
  return { providers, added };
}

export async function turnAccessOn(options: OnOptions): Promise<void> {
  const { out } = options;
  const interactive = options.interactive ?? canPromptInTerminal(options.flags.json ?? false);

  out.emit({ type: "step", step: STEP, status: "start", message: "Checking Cloudflare Access..." });
  const connection = await connect(options);
  const { cf, db, install } = connection;
  refuseHosted(install);
  const scope = scopeOf(install);
  const { gatewayHost, appBaseDomain: base } = scope;
  const accessNames = accessApplicationNames(connection.names);
  if (!(await hasOwner(db))) {
    throw new EveryAppError(
      "ACCESS_NOBODY_ALLOWED",
      "Claim the Gateway first\nAccess lets in the Gateway's members and invitees, and it has none yet, so nobody could open the setup link.",
      { rerun: `${CLI} access on`, rerunNote: "once the owner has claimed the Gateway" },
    );
  }

  // 1. The Zero Trust team: its sign-in domain is permanent once used.
  let organization = await getAccessOrganizationOrNone(cf);
  let teamCreated = false;
  if (!organization) {
    const suggested = install.zoneName.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "") || "every-app";
    let team = options.team;
    if (team === undefined) {
      if (!interactive) {
        throw new EveryAppError(
          "ACCESS_TEAM_REQUIRED",
          "Choose a name for the Zero Trust team with --team\nThis Cloudflare account has none yet. Its sign-in page becomes https://<name>.cloudflareaccess.com and can't be changed later.",
          { fix: `add --team ${suggested}, or another name`, data: { suggested } },
        );
      }
      team = await (options.askTeam ?? askTeamAtTerminal)(suggested);
    }
    // Checked here, not up front: with a team already, the flag is ignored, as its help says.
    if (!TEAM.test(team)) {
      throw new EveryAppError(
        "ACCESS_TEAM_INVALID",
        `${options.team === undefined ? "" : "--team "}${team} can't be a team name\nUse lowercase letters, digits and dashes: it becomes <name>.cloudflareaccess.com.`,
      );
    }
    out.emit({ type: "progress", step: STEP, message: `Creating the Zero Trust team ${team}.cloudflareaccess.com` });
    try {
      organization = await createAccessOrganization(cf, {
        name: team,
        auth_domain: `${team}.cloudflareaccess.com`,
        session_duration: SESSION,
      });
    } catch (error) {
      if (!(error instanceof CfError) || error.kind === "auth") throw error;
      throw new EveryAppError(
        "ACCESS_TEAM_CREATE_FAILED",
        `Cloudflare didn't create the Zero Trust team ${team}\n${error.message.split("\n")[0]}`,
        { fix: "pick another name with --team: team names are shared across Cloudflare", data: { team } },
      );
    }
    teamCreated = true;
  }
  const teamDomain = organization.auth_domain.toLowerCase();

  // 2. The ways to sign in: the applications allow only these two.
  const { providers, added: providersAdded } = await ensureSignInProviders(cf, out);
  const allowed = allowedSignInProviders(providers);

  // 3. The policy: one rule, the Gateway's answer.
  const include = [externalEvaluationRule(gatewayHost)];
  const existingPolicy = (await listAccessPolicies(cf)).find((policy) => policy.name === accessNames.policy) ?? null;
  let policy: AccessPolicy;
  let policyOutcome: "created" | "updated" | "unchanged";
  if (!existingPolicy) {
    out.emit({ type: "progress", step: STEP, message: `Creating the Access policy "${accessNames.policy}"` });
    policy = await createAccessPolicy(cf, { name: accessNames.policy, decision: "allow", include });
    policyOutcome = "created";
  } else if (!sameRules(existingPolicy.include ?? [], include)) {
    out.emit({ type: "progress", step: STEP, message: `Updating the Access policy "${accessNames.policy}"` });
    policy = await updateAccessPolicyRules(cf, existingPolicy, include);
    policyOutcome = "updated";
  } else {
    policy = existingPolicy;
    policyOutcome = "unchanged";
  }

  // 4. The applications: the apps' first, so its AUD exists before the settings name it.
  const plan = appsDestinations(base, await readPublicSurfaces(db));
  emitPlanWarnings(out, plan);
  const found = findAccessApplications(await listAccessApplications(cf), scope);
  const common = { scope, policyId: policy.id, allowedIdps: allowed.map((provider) => provider.id), step: STEP };
  let apps: ApplicationOutcome;
  let gateway: ApplicationOutcome;
  if (found.gateway && found.gateway.id === found.apps?.id) {
    // One application made by hand covers both hosts: kept as one.
    gateway = await applyApplication(cf, out, found.gateway, {
      ...common,
      name: found.gateway.name ?? accessNames.gateway,
      destinations: [gatewayDestination(gatewayHost), ...plan.destinations],
      appLauncherVisible: true,
    });
    apps = gateway;
  } else {
    apps = await applyApplication(cf, out, found.apps, {
      ...common,
      name: accessNames.apps,
      destinations: plan.destinations,
      appLauncherVisible: false,
    });
    gateway = await applyApplication(cf, out, found.gateway, {
      ...common,
      name: accessNames.gateway,
      destinations: [gatewayDestination(gatewayHost)],
      appLauncherVisible: true,
    });
  }

  // 5. The Gateway's settings, all three in one new version of the Worker,
  // every run: a value can't be read back, so writing them is how an
  // application recreated by hand (a new AUD tag) is picked up.
  const secretNames = await listWorkerSecrets(cf, connection.names.worker);
  const changedAccess =
    teamCreated ||
    policyOutcome !== "unchanged" ||
    apps.outcome !== "unchanged" ||
    gateway.outcome !== "unchanged" ||
    ACCESS_SETTINGS.some((name) => !secretNames.includes(name));
  await applyGatewaySettings(
    connection,
    {
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain,
      CLOUDFLARE_ACCESS_APPS_AUD: apps.application.aud,
      CLOUDFLARE_ACCESS_AUD: gateway.application.aud,
    },
    // access.changed below is the event for this; the settings' names ride it.
    { flags: options.flags, out, announce: false },
  );
  // A rerun that found everything as it should be changes nothing a subscriber sees.
  const changed = changedAccess ? await accessChanged(db, connection.deployer, { access: "on", teamDomain }) : [];
  if (changed.length > 0) await db.run(changed);
  // On again: an earlier choice to leave it off no longer holds.
  await clearAccessOffChoice(db);
  out.emit({ type: "step", step: STEP, status: "ok" });

  const methods = describeSignInMethods(allowed);
  const appsWithSurface = plan.destinations.length - 1;
  // Only what this run changed: a person needs that, not a list of what
  // was already so. The settings are written every run, so they are said
  // only beside a change.
  const changes = [
    ...(teamCreated ? [ticked(`Zero Trust team ${teamDomain}`, "created")] : []),
    ...(providersAdded.length > 0 ? [ticked("Sign-in methods", `added ${listed(providersAdded)}`)] : []),
    ...(policyOutcome === "unchanged"
      ? []
      : [ticked(`Access policy "${policy.name}"`, `${policyOutcome}: asks the Gateway who is a member`)]),
    ...[...new Set([gateway, apps])].flatMap((outcome) => applicationLine(outcome)),
  ];
  const lines =
    changes.length > 0 || changedAccess
      ? [...changes, ticked("Gateway settings", `${ACCESS_SETTINGS.join(", ")} · one new version`)]
      : [ticked("Cloudflare Access is in step with this Gateway")];
  const notes = [
    `People sign in to Access with ${methods}, and get in when they are a member or invited here: invite someone in Manage workspace → Users and they can sign in at once.`,
    `MCP clients and personal access tokens keep working: the Gateway's /mcp, the OAuth endpoints, /health and ${plural(appsWithSurface, "app")}'s public routes are let through without a login; deploy keeps them current.`,
  ];
  out.emit({
    type: "done",
    message: [`Cloudflare Access is on for ${gatewayHost} and *.${base}.`, ...notes].join(" "),
    display: (changes.length > 0 || changedAccess
      ? [
          ...lines,
          "",
          ...formatFacts([{ label: "Sign in", value: chalk.cyan(`https://${gatewayHost}`) }]),
          ...notes.map((note) => chalk.dim(note)),
        ]
      : lines
    ).join("\n"),
    data: {
      team: { domain: teamDomain, created: teamCreated },
      signInMethods: providers.map((provider) => signInMethodData(provider, allowed)),
      policy: { id: policy.id, name: policy.name, outcome: policyOutcome },
      applications: {
        gateway: applicationData(gateway),
        apps: applicationData(apps),
        combined: gateway === apps,
      },
      settings: { names: [...ACCESS_SETTINGS] },
      signIn: { url: `https://${gatewayHost}` },
    },
  });
}

/**
 * After a deploy, delete or update: when Cloudflare Access is on for this
 * Gateway (its three settings on the Worker, as `status` reads it), `on`'s
 * recipe again, unattended and with no prompts, so new or removed public
 * routes are let through without anyone running `access on`. Access off, a
 * hosted Gateway, or settings that can't be listed: nothing, no output.
 * One ticked line when it ran; when it fails (a login that can't edit Zero
 * Trust), the command still succeeds, with one warning that names the rerun.
 */
export async function updateAccessIfOn(
  {
    cf,
    createCf,
    out,
    accountId,
    gatewayUrl,
    worker,
    hosted,
  }: {
    cf: CfRunner;
    /**
     * cf per account, as the command made them: `access on` finds the
     * Gateway again in every account the login sees, and `cf` answers for
     * one account only.
     */
    createCf?: (accountId?: string) => CfRunner;
    out: EventSink;
    accountId: string;
    gatewayUrl: string;
    worker: string;
    hosted: boolean;
  },
  { what, data }: { what: string; data?: Record<string, unknown> },
): Promise<void> {
  if (hosted) return;
  const names = await listWorkerSecrets(cf, worker).catch(() => null);
  if (!names || !accessStateOf(names).on) return;
  const step = "app.access";
  out.emit({ type: "step", step, status: "start", message: "Updating Cloudflare Access..." });
  // The recipe's own lines stay inside: its warnings come through, its summary is read.
  let summary: Record<string, unknown> | undefined;
  const inner: EventSink = {
    emit(event) {
      if (event.type === "warning") out.emit(event);
      else if (event.type === "done") summary = event.data;
    },
    get exitCode() {
      return out.exitCode;
    },
    get verbose() {
      return out.verbose;
    },
  };
  try {
    await turnAccessOn({
      // json: never a prompt (a Gateway version changed by hand is refused, not asked about).
      flags: { json: true, "account-id": accountId, gateway: gatewayUrl },
      out: inner,
      interactive: false,
      createCf,
    });
  } catch (error) {
    out.emit({ type: "step", step, status: "skip" });
    out.emit({
      type: "warning",
      code: "ACCESS_UPDATE_FAILED",
      step,
      message: `Cloudflare Access wasn't updated for ${what}\n${errorMessage(error).split("\n")[0]}`,
      data: {
        ...data,
        cause: error instanceof EveryAppError ? error.code : null,
        rerun: `${CLI} access on --gateway ${gatewayUrl}`,
      },
    });
    return;
  }
  const outcomes = summary as
    | { policy?: { outcome?: string }; applications?: { gateway?: { outcome?: string }; apps?: { outcome?: string } } }
    | undefined;
  const changed = [outcomes?.policy, outcomes?.applications?.gateway, outcomes?.applications?.apps].some(
    (part) => part?.outcome !== "unchanged",
  );
  out.emit({
    type: "step",
    step,
    status: "ok",
    message: changed ? `Cloudflare Access updated for ${what}` : "Cloudflare Access is up to date",
    data: { ...data, changed },
  });
}

function applicationLine({ application, outcome }: ApplicationOutcome): string[] {
  return outcome === "unchanged" ? [] : [ticked(`Access application "${application.name ?? application.id}"`, outcome)];
}

/**
 * The `access.changed` event (the outbox, lib/gateway/events.ts) on the
 * install organization, whose Gateway it is; nothing before there is one.
 */
async function accessChanged(db: D1Database, deployer: Deployer, data: { access: "on" | "off"; teamDomain?: string }) {
  const found = await installOrganization(db);
  if (!found) return [];
  return queueEventFromCli(db, {
    organizationId: found.organization.id,
    type: "access.changed",
    actor: operatorActor(deployer),
    data,
  });
}

function askTeamAtTerminal(suggested: string): Promise<string> {
  return askText("Zero Trust team name", {
    initial: suggested,
    context: [
      "This Cloudflare account has no Zero Trust team yet. Visitors will sign in at",
      "https://<name>.cloudflareaccess.com; the name can't be changed later.",
    ],
    validate: (value) => (TEAM.test(value.trim()) ? null : "Lowercase letters, digits and dashes only."),
  });
}

/** A provider as `on` and `show` list it: whether the applications allow it, and on the Cloudflare one whether it is restricted to the account's members. */
function signInMethodData(provider: AccessIdentityProvider, allowed: readonly AccessIdentityProvider[]) {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name ?? null,
    allowed: allowed.some((candidate) => candidate.id === provider.id),
    ...(provider.type === CLOUDFLARE_IDP_TYPE
      ? { restrictToAccountMembers: provider.config?.restrict_to_account_members === true }
      : {}),
  };
}

function applicationData({ application, outcome }: ApplicationOutcome) {
  return {
    id: application.id,
    aud: application.aud,
    name: application.name ?? null,
    outcome,
    destinations: (application.destinations ?? []).map((destination) => ({
      uri: destination.uri ?? null,
      public: (destination.overrides ?? []).map((override) => override.path_pattern),
    })),
    allowedIdps: application.allowed_idps ?? [],
  };
}

/** `access off`: the settings first (one version), then the applications. */
export async function turnAccessOff(options: AccessOptions): Promise<void> {
  const { out } = options;
  const interactive = options.interactive ?? canPromptInTerminal(options.flags.json ?? false);
  const connection = await connect(options);
  const { cf, db, install } = connection;
  refuseHosted(install);
  const scope = scopeOf(install);
  const { gatewayHost, appBaseDomain: base } = scope;
  const names = await listWorkerSecrets(cf, connection.names.worker);
  const held = ACCESS_SETTINGS.filter((name) => names.includes(name));
  const found = findAccessApplications(await listAccessApplications(cf), scope);
  const applications = [
    ...new Map([found.gateway, found.apps].filter((a): a is AccessApplication => a !== null).map((a) => [a.id, a])).values(),
  ];
  // An application that also covers something else only loses our destinations.
  const toDelete = applications.filter((a) => splitDestinations(a.destinations ?? [], scope).foreign.length === 0);
  const toTrim = applications.filter((a) => !toDelete.includes(a));
  if (held.length === 0 && applications.length === 0) {
    // Off on purpose: setup won't put it back on unattended.
    await writeAccessOffChoice(db, "access-off");
    const message = `Cloudflare Access isn't in front of ${gatewayHost}. Nothing changed.`;
    out.emit({ type: "done", message, display: chalk.dim(message), data: { removed: false } });
    return;
  }
  const label = (a: AccessApplication) => a.name ?? a.id;
  await confirmUnlessYes({
    yes: options.flags.yes,
    interactive,
    confirm: options.confirm,
    question: `Turn Cloudflare Access off for ${gatewayHost}?`,
    unattended: "Turning Access off needs confirmation at a terminal, or --yes",
    context: [
      ...(held.length > 0 ? [`Removes ${listed(held)} from the Gateway: the Gateway stops requiring Access at once.`] : []),
      ...(toDelete.length > 0 ? [`Deletes ${plural(toDelete.length, "Access application")}: ${listed(toDelete.map(label))}.`] : []),
      ...(toTrim.length > 0
        ? [`Takes ${gatewayHost} and *.${base} out of ${listed(toTrim.map(label))}, which also covers something else.`]
        : []),
      "The team, its identity providers and the policy stay.",
    ],
    cancelled: "Cancelled. Access stays on.",
  });

  out.emit({ type: "step", step: "access.off", status: "start", message: "Turning Cloudflare Access off..." });
  if (held.length > 0) {
    await applyGatewaySettings(connection, Object.fromEntries(held.map((name) => [name, null])), {
      flags: options.flags,
      out,
      announce: false,
    });
  }
  const changed = await accessChanged(db, connection.deployer, { access: "off" });
  if (changed.length > 0) await db.run(changed);
  // Off on purpose: setup won't put it back on unattended.
  await writeAccessOffChoice(db, "access-off");
  const deleted: string[] = [];
  for (const application of toDelete) {
    if (await deleteAccessApplication(cf, application.id)) deleted.push(label(application));
  }
  const trimmed: string[] = [];
  for (const application of toTrim) {
    const kept = splitDestinations(application.destinations ?? [], scope).foreign;
    await updateAccessApplication(cf, application.id, applicationUpdateBody(application, { destinations: kept as never }));
    trimmed.push(label(application));
  }
  out.emit({ type: "step", step: "access.off", status: "ok" });

  const lines: string[] = [];
  const said: string[] = [];
  if (held.length > 0) {
    lines.push(ticked("Gateway settings removed", listed(held)));
    said.push(`Removed ${listed(held)} from the Gateway.`);
  }
  if (deleted.length > 0) {
    lines.push(ticked(`${plural(deleted.length, "Access application")} deleted`, listed(deleted)));
    said.push(`Deleted ${listed(deleted)}.`);
  }
  if (trimmed.length > 0) {
    lines.push(ticked(`${gatewayHost} and *.${base} taken out of ${listed(trimmed)}`));
    said.push(`Took ${gatewayHost} and *.${base} out of ${listed(trimmed)}.`);
  }
  const note = `The Gateway's own sign-in stands alone again. The Zero Trust team, its identity providers and the policy "${accessApplicationNames(connection.names).policy}" are left as they were.`;
  out.emit({
    type: "done",
    message: [...said, note].join(" "),
    display: [...lines, chalk.dim(note)].join("\n"),
    data: {
      removed: true,
      settings: held,
      applications: {
        deleted: toDelete.filter((a) => deleted.includes(label(a))).map((a) => a.id),
        trimmed: toTrim.map((a) => a.id),
      },
    },
  });
}

/** `access show`: what Access has in front of the Gateway. Nothing changes. */
export async function showAccess(options: AccessOptions): Promise<void> {
  const { out } = options;
  const connection = await connect(options);
  const { cf, install } = connection;
  const scope = scopeOf(install);
  const { gatewayHost, appBaseDomain: base } = scope;
  const hosted = install.deploymentMode === "hosted";
  const organization = hosted ? null : await getAccessOrganizationOrNone(cf);
  const names = await listWorkerSecrets(cf, connection.names.worker);
  const settings = ACCESS_SETTINGS.filter((name) => names.includes(name));
  const policyName = accessApplicationNames(connection.names).policy;
  const policy = organization ? ((await listAccessPolicies(cf)).find((candidate) => candidate.name === policyName) ?? null) : null;
  const providers = organization ? await listAccessIdentityProviders(cf) : [];
  const allowed = allowedSignInProviders(providers);
  const found: { gateway: AccessApplication | null; apps: AccessApplication | null } = organization
    ? findAccessApplications(await listAccessApplications(cf), scope)
    : { gateway: null, apps: null };

  const on = settings.length === ACCESS_SETTINGS.length && found.gateway !== null;
  const asksGateway = policy !== null && sameRules(policy.include ?? [], [externalEvaluationRule(gatewayHost)]);
  const fixes = !hosted && (!on || !asksGateway || found.apps === null) ? [`${CLI} access on`] : [];
  const applicationValue = (application: AccessApplication | null) =>
    application
      ? `${application.name ?? application.id}${chalk.dim(` · ${plural((application.destinations ?? []).length, "destination")}`)}`
      : chalk.dim("no Access application");

  const facts = [
    {
      label: "Access",
      value: hosted
        ? chalk.dim("not available on a hosted Gateway")
        : on
          ? chalk.green("on")
          : found.gateway
            ? chalk.yellow("applications exist, Gateway settings missing")
            : chalk.dim("off"),
    },
    {
      label: "Team",
      value: organization ? organization.auth_domain : chalk.dim(hosted ? "" : "none in this Cloudflare account"),
    },
    {
      label: "Lets in",
      value: policy
        ? asksGateway
          ? `the Gateway's members and invitees${chalk.dim(` (policy "${policy.name}")`)}`
          : chalk.yellow(`policy "${policy.name}" doesn't ask the Gateway`)
        : chalk.dim(`no policy "${policyName}" yet`),
    },
    ...(organization
      ? [{ label: "Sign in", value: allowed.length > 0 ? `with ${describeSignInMethods(allowed)}` : chalk.dim("no sign-in method yet") }]
      : []),
    { label: gatewayHost, value: applicationValue(found.gateway) },
    { label: `*.${base}`, value: applicationValue(found.apps) },
    { label: "Settings", value: settings.length > 0 ? `${listed(settings)}${chalk.dim(" (values can't be read back)")}` : chalk.dim("none") },
  ];
  const asOutcome = (application: AccessApplication) => applicationData({ application, outcome: "unchanged" });
  out.emit({
    type: "done",
    message: `Cloudflare Access is ${on ? "on" : "off"} for ${gatewayHost}.`,
    display: [...formatFacts(facts), ...(fixes.length > 0 ? ["", chalk.dim("To fix: ") + chalk.bold(fixes.join(", "))] : [])].join(
      "\n",
    ),
    data: {
      on,
      hosted,
      team: organization ? { domain: organization.auth_domain } : null,
      policy: policy ? { id: policy.id, name: policy.name, asksGateway } : null,
      signIn: organization ? { methods: providers.map((provider) => signInMethodData(provider, allowed)) } : null,
      applications: {
        gateway: found.gateway ? asOutcome(found.gateway) : null,
        apps: found.apps ? asOutcome(found.apps) : null,
        combined: found.gateway !== null && found.gateway.id === found.apps?.id,
      },
      settings: { names: settings },
      ...(fixes.length > 0 ? { fixes } : {}),
    },
  });
}
