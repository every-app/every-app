/**
 * `everyapp access on|off|show`: Cloudflare Access in front of the Gateway
 * and its apps, the outer ring of docs/runbooks/cloudflare-access.md, from
 * the Cloudflare login alone. Nothing is kept on this machine or added to
 * the Gateway's database: the Access applications are found again by what
 * they cover (the Gateway's host, `*.<app base domain>`), the policy by its
 * name, and the Gateway's settings by their names on the Worker.
 *
 * `on` reads everything first (who is a member or invited, which apps have
 * public routes, what Access has), then changes only what differs, in an
 * order that never leaves the Gateway requiring an Access login nobody can
 * get: the team, then a way to sign in, then the policy, then the two
 * applications (the apps' first), and last the Gateway's settings, all
 * three in one new version of the Worker. It never removes anyone from the
 * policy (deactivation in Every App is how someone is taken off), never
 * touches a destination it didn't make (an application that also covers
 * something else keeps that), and leaves the team's global session alone
 * unless asked.
 *
 * `off` is the reverse: the settings go first, in one version, so the
 * Gateway stops requiring Access at once; then the two applications.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import chalk from "chalk";
import type { LocalContext } from "@/context";
import {
  applicationUpdateBody,
  createAccessApplication,
  createAccessOrganization,
  createAccessPolicy,
  createOneTimePinProvider,
  deleteAccessApplication,
  getAccessOrganization,
  listAccessApplications,
  listAccessIdentityProviders,
  listAccessPolicies,
  setAccessOrganizationSession,
  updateAccessApplication,
  updateAccessPolicyRules,
  type AccessApplication,
  type AccessApplicationBody,
  type AccessIdentityProvider,
  type AccessOrganization,
  type AccessPolicy,
  type AccessRule,
} from "@/lib/cf/access";
import type { D1Database } from "@/lib/cf/d1";
import { CfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import {
  appsDestinations,
  durationSeconds,
  emailDomainRule,
  emailRule,
  findAccessApplications,
  gatewayDestination,
  managedOAuthOn,
  mergeRules,
  peopleIdentityProviders,
  ruleDomains,
  ruleEmails,
  sameDestinations,
  splitDestinations,
  UNVERIFIED_EMAIL_IDP_TYPES,
  type AccessPublicDestination,
  type AccessScope,
} from "@/lib/access/plan";
import {
  clearAccessSettingsRecord,
  readAccessSettingsRecord,
  settingsNameApplications,
  writeAccessSettingsRecord,
} from "@/lib/access/record";
import { ACCESS_SETTINGS } from "@/lib/access/settings";
import { emitPlanWarnings, readPublicSurfaces, scopeOf, type PlanLeftovers } from "@/lib/access/sync";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import type { InstallRecord } from "@/lib/gateway/install";
import { ACCESS_LEASE_ID, acquireLease, LeasePurpose } from "@/lib/gateway/lease";
import { CLI } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { askText, canPromptInTerminal, confirmUnlessYes, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts } from "@/lib/output/table";
import { listed, plural } from "@/lib/output/text";
import { applyGatewaySettings } from "../secret";
import type { GatewayCommandFlags } from "../flags";

/** The reusable policy `on` keeps: who may use Every App. */
export const POLICY_NAME = "Every App gateway members";
const GATEWAY_APPLICATION_NAME = "Every App gateway";
const APPS_APPLICATION_NAME = "Every App apps";
/** The most Access allows for an application's session: a PIN a month, not a day. */
const DEFAULT_SESSION = "720h";
/** Access's default for a team's global session, when unset. */
const ACCESS_DEFAULT_GLOBAL_SESSION_SECONDS = 24 * 3600;
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
  /** Milliseconds now (tests). */
  now?: () => number;
}

interface OnOptions extends AccessOptions {
  emails?: readonly string[];
  emailDomains?: readonly string[];
  team?: string;
  session?: string;
  teamSession?: string;
  writeSettings?: boolean;
}

export async function on(
  this: LocalContext,
  flags: GatewayCommandFlags & {
    email?: string[];
    "email-domain"?: string[];
    team?: string;
    session?: string;
    "team-session"?: string;
    "write-settings"?: boolean;
  },
): Promise<void> {
  await runCommand(flags, (out) =>
    turnAccessOn({
      flags,
      out,
      emails: flags.email,
      emailDomains: flags["email-domain"],
      team: flags.team,
      session: flags.session,
      teamSession: flags["team-session"],
      writeSettings: flags["write-settings"],
    }),
  );
}

export async function off(
  this: LocalContext,
  flags: AccessFlags & { "keep-applications"?: boolean },
): Promise<void> {
  await runCommand(flags, (out) => turnAccessOff({ flags, out, keepApplications: flags["keep-applications"] }));
}

export async function show(this: LocalContext, flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => showAccess({ flags, out }));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
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

/** A duration as Access takes it, or the error for the flag it came from. */
function checkDuration(flag: string, value: string): string {
  const trimmed = value.trim();
  const seconds = durationSeconds(trimmed);
  if (seconds === null || seconds <= 0) {
    throw new EveryAppError(
      "ACCESS_SESSION_INVALID",
      `${flag} ${value} isn't a duration Access takes\nUse hours and minutes, like 720h or 2h30m.`,
    );
  }
  return trimmed;
}

/** Who the Gateway knows: members (not deactivated), pending invitees, and who still has to link Access. */
interface People {
  members: string[];
  invited: string[];
  /** Members with a password and no Access identity yet: they sign in once with the password through Access. */
  toLink: string[];
}

/**
 * The Gateway's own rules: a member is deactivated while `banned` and the
 * ban hasn't expired; an invitation counts while pending and unexpired.
 */
async function readPeople(db: D1Database, now: number): Promise<People> {
  const active = "(u.banned IS NULL OR u.banned = 0 OR (u.ban_expires IS NOT NULL AND u.ban_expires <= ?1))";
  const [members = [], invited = [], toLink = []] = await db.run([
    { sql: `SELECT u.email FROM users u WHERE ${active} ORDER BY u.email`, params: [now] },
    {
      sql: "SELECT DISTINCT email FROM invitations WHERE status = 'pending' AND expires_at > ?1 ORDER BY email",
      params: [now],
    },
    {
      sql: `SELECT u.email FROM users u
WHERE ${active}
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.provider_id = 'credential')
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.provider_id = 'cloudflare-access')
ORDER BY u.email`,
      params: [now],
    },
  ]);
  const emails = (rows: Array<Record<string, unknown>>) =>
    [...new Set(rows.map((row) => String(row["email"]).toLowerCase()))];
  return { members: emails(members), invited: emails(invited), toLink: emails(toLink) };
}

/** `--email` and `--email-domain`, checked and lowercased. */
function wantedRules(
  emails: readonly string[],
  domains: readonly string[],
): { rules: AccessRule[]; emails: string[]; domains: string[] } {
  const rules: AccessRule[] = [];
  const checkedEmails: string[] = [];
  const checkedDomains: string[] = [];
  for (const email of emails) {
    const value = email.trim().toLowerCase();
    if (!EMAIL.test(value)) {
      throw new EveryAppError("ACCESS_EMAIL_INVALID", `--email ${email} isn't an email address`);
    }
    rules.push(emailRule(value));
    checkedEmails.push(value);
  }
  for (const domain of domains) {
    const value = domain.trim().toLowerCase().replace(/^@/, "");
    if (!DOMAIN.test(value)) {
      throw new EveryAppError(
        "ACCESS_DOMAIN_INVALID",
        `--email-domain ${domain} isn't a domain\nUse the part after the @, like example.com.`,
      );
    }
    rules.push(emailDomainRule(value));
    checkedDomains.push(value);
  }
  return { rules, emails: checkedEmails, domains: checkedDomains };
}

/** What one application ended as. */
interface ApplicationOutcome {
  application: AccessApplication;
  /** `skipped`: left as found, with a warning saying why. */
  outcome: "created" | "updated" | "unchanged" | "skipped";
}

/** What `on` found and did, for the done event. */
interface OnResult {
  teamDomain: string;
  organization: { created: boolean; sessionSet: string | null; globalSession: string | null };
  signInMethods: AccessIdentityProvider[];
  pinAdded: boolean;
  policy: { id: string; name: string; created: boolean; added: string[]; emails: string[]; domains: string[] };
  gateway: ApplicationOutcome;
  apps: ApplicationOutcome;
  /** One application covers the Gateway's host and the apps' hosts. */
  combined: boolean;
  settings: { outcome: "set" | "kept"; reason: SettingsReason | null };
  toLink: string[];
  emailDomains: string[];
}

/**
 * Why the Gateway's settings are written this run: one is missing on the
 * Worker; an application was created; nothing records what they were set
 * to (before this record existed); the record names other applications or
 * another team (one recreated by hand has a new AUD tag); or `--write-settings`.
 */
type SettingsReason = "missing" | "created" | "unrecorded" | "changed" | "asked";

export async function turnAccessOn(options: OnOptions): Promise<void> {
  const { out } = options;
  const now = options.now ?? Date.now;
  // The arguments first: no network.
  const session = options.session === undefined ? DEFAULT_SESSION : checkDuration("--session", options.session);
  const teamSession = options.teamSession === undefined ? null : checkDuration("--team-session", options.teamSession);
  const wanted = wantedRules(options.emails ?? [], options.emailDomains ?? []);
  const interactive = options.interactive ?? canPromptInTerminal(options.flags.json ?? false);

  out.emit({ type: "step", step: STEP, status: "start", message: "Checking Cloudflare Access..." });
  const connection = await connect(options);
  const { cf, db, install } = connection;
  refuseHosted(install);
  const scope = scopeOf(install);
  const { gatewayHost, appBaseDomain: base } = scope;

  // Who gets in: every read before the first write.
  const people = await readPeople(db, now());
  const rules = [...people.members.map(emailRule), ...people.invited.map(emailRule), ...wanted.rules];
  let organization = await getAccessOrganization(cf);
  const providers = await listAccessIdentityProviders(cf);
  const policies = await listAccessPolicies(cf);
  const existingPolicy = policies.find((policy) => policy.name === POLICY_NAME) ?? null;
  if (rules.length === 0 && !existingPolicy) {
    throw new EveryAppError(
      "ACCESS_NOBODY_ALLOWED",
      "Nobody to let in yet\nThe Gateway has no members or invitations, and no --email was given, so the Access policy would let nobody in. Claim the Gateway first, or name who will (the setup link is then behind Access too).",
      { rerun: `${CLI} access on --email <your address>` },
    );
  }
  const unknownEmails = wanted.emails.filter(
    (email) => !people.members.includes(email) && !people.invited.includes(email),
  );
  if (unknownEmails.length > 0) {
    out.emit({
      type: "warning",
      code: "ACCESS_EMAIL_NOT_INVITED",
      step: STEP,
      message: `${listed(unknownEmails)} ${unknownEmails.length === 1 ? "has" : "have"} no account on this Gateway\nAccess will let ${unknownEmails.length === 1 ? "them" : "them"} through, but the Gateway refuses anyone it doesn't know. Invite ${unknownEmails.length === 1 ? "them" : "them"} in Manage workspace → Users.`,
      data: { emails: unknownEmails },
    });
  }

  // 1. The Zero Trust team: its sign-in domain is permanent once used.
  let organizationCreated = false;
  let sessionSet: string | null = null;
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
        session_duration: teamSession ?? session,
      });
    } catch (error) {
      if (!(error instanceof CfError) || error.kind === "auth") throw error;
      throw new EveryAppError(
        "ACCESS_TEAM_CREATE_FAILED",
        `Cloudflare didn't create the Zero Trust team ${team}\n${error.message.split("\n")[0]}`,
        { fix: "pick another name with --team: team names are shared across Cloudflare", data: { team } },
      );
    }
    organizationCreated = true;
    sessionSet = teamSession ?? session;
  } else if (teamSession !== null && organization.session_duration !== teamSession) {
    out.emit({ type: "progress", step: STEP, message: `Setting the team's global session to ${teamSession}` });
    organization = await setAccessOrganizationSession(cf, organization, teamSession);
    sessionSet = teamSession;
  }
  const teamDomain = organization.auth_domain.toLowerCase();

  // 2. A way to sign in: the one-time PIN, unless people have another provider.
  let pinAdded = false;
  let signInMethods = peopleIdentityProviders(providers);
  if (signInMethods.length === 0) {
    out.emit({ type: "progress", step: STEP, message: "Adding the one-time PIN identity provider" });
    signInMethods = [await createOneTimePinProvider(cf)];
    pinAdded = true;
  }
  const unverified = signInMethods.filter((provider) => UNVERIFIED_EMAIL_IDP_TYPES.includes(provider.type));
  if (unverified.length > 0) {
    out.emit({
      type: "warning",
      code: "ACCESS_IDP_UNVERIFIED_EMAILS",
      step: STEP,
      message: `${listed(unverified.map((provider) => `${provider.name ?? provider.id} (${provider.type})`))} ${unverified.length === 1 ? "is a generic provider" : "are generic providers"}\nThe Gateway signs people in as the email Access asserts. A provider that lets people choose their own address would let them choose someone else's; keep only providers that verify addresses (runbook: "Verified emails").`,
      data: { providers: unverified.map((provider) => ({ id: provider.id, type: provider.type, name: provider.name ?? null })) },
    });
  }

  // 3. The policy: who may use Every App. Never fewer than before.
  let policy: AccessPolicy;
  let policyCreated = false;
  let added: AccessRule[] = [];
  if (!existingPolicy) {
    const merged = mergeRules([], rules);
    out.emit({ type: "progress", step: STEP, message: `Creating the Access policy "${POLICY_NAME}"` });
    policy = await createAccessPolicy(cf, { name: POLICY_NAME, decision: "allow", include: merged.include });
    policyCreated = true;
    added = merged.include;
  } else {
    const merged = mergeRules(existingPolicy.include ?? [], rules);
    if (merged.added.length > 0) {
      out.emit({ type: "progress", step: STEP, message: `Adding ${plural(merged.added.length, "rule")} to the Access policy` });
      policy = await updateAccessPolicyRules(cf, existingPolicy, merged.include);
      added = merged.added;
    } else {
      policy = existingPolicy;
    }
  }

  // 4. The applications, under the Access lease (a deploy syncing at the
  // same time waits, and what it deployed is read here, under it): the
  // apps' first, so its AUD exists before the Gateway's settings name it.
  const lease = await acquireLease({ db, id: ACCESS_LEASE_ID, purpose: LeasePurpose.AccessSync, out, step: "gateway.lease" });
  let apps: ApplicationOutcome;
  let gateway: ApplicationOutcome;
  let combined: boolean;
  let leftovers: PlanLeftovers;
  let plan: ReturnType<typeof appsDestinations>;
  try {
    const found = findAccessApplications(await listAccessApplications(cf), scope);
    const mcp = !managedOAuthOn(found.gateway);
    plan = appsDestinations(base, await readPublicSurfaces(db), { mcp });
    combined = found.gateway !== null && found.apps !== null && found.gateway.id === found.apps.id;
    const foreign: PlanLeftovers["foreign"] = [];
    const noteForeign = (application: AccessApplication | null) => {
      if (!application) return;
      const split = splitDestinations(application.destinations ?? [], scope).foreign;
      if (split.length > 0) {
        foreign.push({ application: application.name ?? application.id, uris: split.map((d) => d.uri ?? "(private)") });
      }
    };
    const common = {
      scope,
      policyId: policy.id,
      session,
      sessionGiven: options.session !== undefined,
      allowedIdps: signInMethods.map((provider) => provider.id),
    };
    if (combined) {
      out.emit({
        type: "warning",
        code: "ACCESS_ONE_APPLICATION",
        step: STEP,
        message: `One Access application covers ${gatewayHost} and *.${base}\nIt is kept and updated. The runbook recommends two, so an app host's Access cookie is never a Gateway login.`,
      });
      noteForeign(found.gateway);
      const together = await reconcileApplication(cf, out, found.gateway, {
        ...common,
        name: found.gateway!.name ?? GATEWAY_APPLICATION_NAME,
        destinations: [gatewayDestination(gatewayHost, !mcp), ...plan.destinations],
        appLauncherVisible: true,
      });
      apps = together;
      gateway = together;
    } else {
      noteForeign(found.apps);
      noteForeign(found.gateway);
      apps = await reconcileApplication(cf, out, found.apps, {
        ...common,
        name: APPS_APPLICATION_NAME,
        destinations: plan.destinations,
        appLauncherVisible: false,
      });
      gateway = await reconcileApplication(cf, out, found.gateway, {
        ...common,
        name: GATEWAY_APPLICATION_NAME,
        destinations: [gatewayDestination(gatewayHost, !mcp)],
        appLauncherVisible: true,
      });
    }
    leftovers = { dropped: plan.dropped, outsideBase: plan.outsideBase, foreign };
  } finally {
    await lease.release();
  }
  emitPlanWarnings(out, leftovers);

  // 5. The Gateway's settings, all three in one new version of the Worker.
  // Values can't be read back, so what was written is recorded in the
  // Gateway's D1, and they are written again when one is missing, when
  // the record doesn't name these applications (one recreated by hand has
  // a new AUD tag, and the old one locks everyone out), or when asked.
  const names = await listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
  const missing = ACCESS_SETTINGS.filter((name) => !names.includes(name));
  const values = { teamDomain, gatewayAud: gateway.application.aud, appsAud: apps.application.aud };
  const record = await readAccessSettingsRecord(db);
  const created = apps.outcome === "created" || gateway.outcome === "created";
  const reason: SettingsReason | null =
    missing.length > 0
      ? "missing"
      : created
        ? "created"
        : record === null
          ? "unrecorded"
          : !settingsNameApplications(record, values)
            ? "changed"
            : options.writeSettings
              ? "asked"
              : null;
  if (reason) {
    await applyGatewaySettings(
      connection,
      {
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: values.teamDomain,
        CLOUDFLARE_ACCESS_APPS_AUD: values.appsAud,
        CLOUDFLARE_ACCESS_AUD: values.gatewayAud,
      },
      { flags: options.flags, out },
    );
    await writeAccessSettingsRecord(db, { ...values, writtenAt: now() });
  }
  out.emit({ type: "step", step: STEP, status: "ok" });

  reportOn(
    out,
    {
      teamDomain,
      organization: { created: organizationCreated, sessionSet, globalSession: organization.session_duration ?? null },
      signInMethods,
      pinAdded,
      policy: {
        id: policy.id,
        name: policy.name,
        created: policyCreated,
        added: [...ruleEmails(added), ...ruleDomains(added).map((domain) => `@${domain}`)],
        emails: ruleEmails(policy.include ?? []),
        domains: ruleDomains(policy.include ?? []),
      },
      gateway,
      apps,
      combined,
      settings: reason ? { outcome: "set", reason } : { outcome: "kept", reason: null },
      toLink: people.toLink,
      emailDomains: wanted.domains,
    },
    // The plan's destinations: the wildcard, then one per app with public routes.
    { gatewayHost, base, session, appsWithRoutes: plan.destinations.length - 1 },
  );
}

function askTeamAtTerminal(suggested: string): Promise<string> {
  return askText("Zero Trust team name", {
    initial: suggested,
    context: [
      "This Cloudflare account has no Zero Trust team yet. People will sign in at",
      "https://<name>.cloudflareaccess.com; the name can't be changed later.",
    ],
    validate: (value) =>
      TEAM.test(value.trim()) ? null : "Lowercase letters, digits and dashes only.",
  });
}

/** What an application should be. */
interface DesiredApplication {
  scope: AccessScope;
  name: string;
  /** Our destinations; the application's others are kept. */
  destinations: AccessPublicDestination[];
  policyId: string;
  session: string;
  /** `--session` was given: an existing application's session changes too. */
  sessionGiven: boolean;
  allowedIdps: string[];
  appLauncherVisible: boolean;
}

/**
 * Create the application, or bring the fields this command owns in line
 * (our destinations, our policy among its reusable policies, the cookie
 * settings, the session when asked) and keep everything else as found. No
 * difference, no PUT.
 */
async function reconcileApplication(
  cf: CfRunner,
  out: EventSink,
  existing: AccessApplication | null,
  desired: DesiredApplication,
): Promise<ApplicationOutcome> {
  if (!existing) {
    out.emit({ type: "progress", step: STEP, message: `Creating the Access application "${desired.name}"` });
    const application = await createAccessApplication(cf, {
      name: desired.name,
      type: "self_hosted",
      destinations: desired.destinations,
      policies: [desired.policyId],
      session_duration: desired.session,
      http_only_cookie_attribute: true,
      enable_binding_cookie: true,
      ...(desired.allowedIdps.length > 0 ? { allowed_idps: desired.allowedIdps } : {}),
      auto_redirect_to_identity: desired.allowedIdps.length === 1,
      app_launcher_visible: desired.appLauncherVisible,
    });
    return { application, outcome: "created" };
  }
  const current = existing.destinations ?? [];
  const destinations = [...splitDestinations(current, desired.scope).foreign, ...desired.destinations];
  const found = [...(existing.policies ?? [])].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
  const inline = found.filter((policy) => policy.reusable === false);
  if (inline.length > 0) {
    // An application with policies of its own takes no reusable one, and
    // the API replaces it whole on PUT: it is the dashboard's to manage.
    out.emit({
      type: "warning",
      code: "ACCESS_INLINE_POLICIES",
      step: STEP,
      message: `The Access application "${existing.name ?? existing.id}" has ${inline.length === 1 ? "a policy" : "policies"} of its own: ${listed(inline.map((policy) => policy.name ?? policy.id))}\nIt is left as it is: Access takes either application policies or reusable ones, not both, so the policy "${POLICY_NAME}" can't be attached and its paths aren't managed here. Make its policies reusable in the dashboard, or manage it there.`,
      data: { application: existing.id, policies: inline.map((policy) => policy.id) },
    });
    return { application: existing, outcome: "skipped" };
  }
  const policyIds = found.map((policy) => policy.id);
  const policies = policyIds.includes(desired.policyId) ? policyIds : [...policyIds, desired.policyId];
  // Managed OAuth: the runbook leaves the binding cookie as the operator set it.
  const binding = managedOAuthOn(existing) ? (existing.enable_binding_cookie ?? false) : true;
  const changes: Partial<AccessApplicationBody> = {
    destinations: destinations as AccessApplicationBody["destinations"],
    policies,
    http_only_cookie_attribute: true,
    enable_binding_cookie: binding,
    ...(desired.sessionGiven ? { session_duration: desired.session } : {}),
  };
  const unchanged =
    sameDestinations(current, destinations) &&
    policies.join(",") === policyIds.join(",") &&
    existing.http_only_cookie_attribute === true &&
    (existing.enable_binding_cookie ?? false) === binding &&
    (!desired.sessionGiven || existing.session_duration === desired.session);
  if (unchanged) return { application: existing, outcome: "unchanged" };
  out.emit({ type: "progress", step: STEP, message: `Updating the Access application "${existing.name ?? desired.name}"` });
  const application = await updateAccessApplication(cf, existing.id, applicationUpdateBody(existing, changes));
  return { application, outcome: "updated" };
}

/** The done event of `on`: what changed, what was already so, and what to do next. */
function reportOn(
  out: EventSink,
  result: OnResult,
  context: { gatewayHost: string; base: string; session: string; appsWithRoutes: number },
): void {
  const { gatewayHost, base } = context;
  const lines: string[] = [];
  const said: string[] = [];
  const done = (line: string, detail?: string) => {
    lines.push(ticked(line, detail));
    said.push(`${line}${detail ? ` (${detail})` : ""}.`);
  };
  const already = (line: string) => {
    lines.push(chalk.dim(line));
    said.push(line);
  };
  // A one-time PIN provider is "a one-time PIN" whatever it was named.
  const methods = listed(
    result.signInMethods.map((provider) =>
      provider.type === "onetimepin" ? "a one-time PIN" : (provider.name ?? provider.type),
    ),
  );

  if (result.organization.created) done(`Zero Trust team ${result.teamDomain}`, `created · sign-in through ${methods}`);
  else if (result.organization.sessionSet) done(`Zero Trust team ${result.teamDomain}`, `global session now ${result.organization.sessionSet}, for every Access application in the account`);
  else already(`Zero Trust team ${result.teamDomain} · sign-in through ${methods}.`);
  if (result.pinAdded) done("One-time PIN sign-in", "added: Access emails people a code");

  const { policy } = result;
  const who = [...policy.emails, ...policy.domains.map((domain) => `@${domain}`)];
  if (policy.created) done(`Access policy "${policy.name}"`, `lets in ${listed(who)}`);
  else if (policy.added.length > 0) done(`Access policy "${policy.name}"`, `now also lets in ${listed(policy.added)}`);
  else already(`Access policy "${policy.name}" lets in ${listed(who)}.`);

  const routes =
    context.appsWithRoutes > 0
      ? `public routes of ${plural(context.appsWithRoutes, "app")} let through`
      : "no app has public routes";
  const machine = "MCP and the OAuth endpoints let through";
  const skipped = (where: string) => already(`Access in front of ${where} left as it is (see the warning above).`);
  if (result.combined) {
    const where = `${gatewayHost} and *.${base}`;
    if (result.gateway.outcome === "skipped") skipped(where);
    else if (result.gateway.outcome === "unchanged") already(`Access in front of ${where} is as it should be.`);
    else done(`Access in front of ${where}`, `${result.gateway.outcome} · ${machine} · ${routes}`);
  } else {
    if (result.gateway.outcome === "skipped") skipped(gatewayHost);
    else if (result.gateway.outcome === "unchanged") already(`Access in front of ${gatewayHost} is as it should be.`);
    else done(`Access in front of ${gatewayHost}`, `${result.gateway.outcome} · ${machine}`);
    if (result.apps.outcome === "skipped") skipped(`*.${base}`);
    else if (result.apps.outcome === "unchanged") already(`Access in front of *.${base} is as it should be (${routes}).`);
    else done(`Access in front of *.${base}`, `${result.apps.outcome} · ${routes}`);
  }
  if (result.settings.outcome === "set") {
    const why =
      result.settings.reason === "changed"
        ? " · an application's AUD tag had changed"
        : result.settings.reason === "unrecorded"
          ? " · recorded, so a rerun can tell when they go stale"
          : "";
    done("Gateway settings", `${ACCESS_SETTINGS.join(", ")} · one new version${why}`);
  } else already("Gateway settings kept: they name these applications already (--write-settings writes them again).");

  const pinOnly = result.signInMethods.every((provider) => provider.type === "onetimepin");
  const first = pinOnly ? "Access emails them a code first" : "Access asks them to sign in first";
  const signIn = result.toLink.length > 0
    ? `${listed(result.toLink)} ${result.toLink.length === 1 ? "signs" : "sign"} in once with ${result.toLink.length === 1 ? "their" : "their own"} password; ${first}. After that Access alone signs them in.`
    : null;
  const notes: string[] = [];
  const next: Array<{ command: string; note: string }> = [];
  if (result.emailDomains.length > 0) {
    notes.push(
      `People at ${listed(result.emailDomains)} pass Access, but still need an invitation here, unless they may join on their first sign-in: ${CLI} secret set CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS (${result.emailDomains.join(", ")}).`,
    );
    next.push({ command: `${CLI} secret set CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`, note: `${result.emailDomains.join(", ")}: people there join as members on their first sign-in` });
  }
  notes.push("MCP clients and personal access tokens keep working: /mcp, the OAuth endpoints and each app's public routes are let through without a login.");
  notes.push(`Once everyone has signed in through Access, passwords can go: ${CLI} secret set EMAIL_PASSWORD_SIGN_IN (false).`);
  next.push({ command: `${CLI} secret set EMAIL_PASSWORD_SIGN_IN`, note: "false, once everyone has linked Access" });

  out.emit({
    type: "done",
    message: [...said, ...(signIn ? [`Sign in at https://${gatewayHost}: ${signIn}`] : []), ...notes].join(" "),
    display: [
      ...lines,
      "",
      ...formatFacts([
        { label: "Sign in", value: chalk.cyan(`https://${gatewayHost}`) },
      ]),
      ...(signIn ? [`${" ".repeat("Sign in".length + 2)}${signIn}`] : []),
      ...notes.map((note) => chalk.dim(note)),
    ].join("\n"),
    data: {
      team: {
        domain: result.teamDomain,
        created: result.organization.created,
        sessionSet: result.organization.sessionSet,
        globalSession: result.organization.globalSession,
      },
      signInMethods: result.signInMethods.map((provider) => ({ id: provider.id, type: provider.type, name: provider.name ?? null })),
      identityProviders: { oneTimePinAdded: result.pinAdded },
      policy,
      applications: {
        gateway: applicationData(result.gateway),
        apps: applicationData(result.apps),
        combined: result.combined,
      },
      settings: { names: [...ACCESS_SETTINGS], ...result.settings },
      signIn: { url: `https://${gatewayHost}`, pending: result.toLink, first: pinOnly ? "pin" : "idp" },
      next,
    },
  });
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
  };
}

/** `access off`: the settings first (one version), then the applications. */
export async function turnAccessOff(options: AccessOptions & { keepApplications?: boolean }): Promise<void> {
  const { out } = options;
  const interactive = options.interactive ?? canPromptInTerminal(options.flags.json ?? false);
  const connection = await connect(options);
  const { cf, db, install } = connection;
  refuseHosted(install);
  const scope = scopeOf(install);
  const { gatewayHost, appBaseDomain: base } = scope;
  const names = await listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
  const held = ACCESS_SETTINGS.filter((name) => names.includes(name));
  const found = findAccessApplications(await listAccessApplications(cf), scope);
  const applications = options.keepApplications
    ? []
    : [...new Map([found.gateway, found.apps].filter((a): a is AccessApplication => a !== null).map((a) => [a.id, a])).values()];
  // An application that also covers something else only loses our destinations.
  const toDelete = applications.filter((a) => splitDestinations(a.destinations ?? [], scope).foreign.length === 0);
  const toTrim = applications.filter((a) => !toDelete.includes(a));
  if (held.length === 0 && applications.length === 0) {
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
      ...(held.length > 0 ? [`Removes ${listed(held)} from the Gateway: passwords sign people in again at once.`] : []),
      ...(toDelete.length > 0 ? [`Deletes ${plural(toDelete.length, "Access application")}: ${listed(toDelete.map(label))}.`] : []),
      ...(toTrim.length > 0
        ? [`Takes ${gatewayHost} and *.${base} out of ${listed(toTrim.map(label))}, which also covers something else.`]
        : []),
      ...(options.keepApplications && (found.gateway || found.apps)
        ? ["The Access applications stay: Access still asks people to sign in there."]
        : []),
      ...(toDelete.some(managedOAuthOn) ? ["The Gateway's application has Managed OAuth on: AI apps connected through it stop."] : []),
      "The team, its identity providers and the policy stay.",
    ],
    cancelled: "Cancelled. Access stays on.",
  });

  out.emit({ type: "step", step: "access.off", status: "start", message: "Turning Cloudflare Access off..." });
  if (held.length > 0) {
    await applyGatewaySettings(connection, Object.fromEntries(held.map((name) => [name, null])), {
      flags: options.flags,
      out,
    });
  }
  await clearAccessSettingsRecord(db);
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
  if (options.keepApplications && (found.gateway || found.apps)) {
    const line = "The Access applications stay: Access still asks people to sign in there, and the Gateway no longer requires it.";
    lines.push(chalk.dim(line));
    said.push(line);
  }
  const note = `Passwords sign people in as before. The Zero Trust team, its identity providers and the policy "${POLICY_NAME}" are left as they were.`;
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
        kept: options.keepApplications ?? false,
      },
    },
  });
}

/** `access show`: what Access has, against what `on` would make of it. Nothing changes. */
export async function showAccess(options: AccessOptions): Promise<void> {
  const { out } = options;
  const now = options.now ?? Date.now;
  const connection = await connect(options);
  const { cf, db, install } = connection;
  const scope = scopeOf(install);
  const { gatewayHost, appBaseDomain: base } = scope;
  const hosted = install.deploymentMode === "hosted";
  const organization = hosted ? null : await getAccessOrganization(cf);
  const names = await listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
  const settings = ACCESS_SETTINGS.filter((name) => names.includes(name));
  const record = hosted ? null : await readAccessSettingsRecord(db);
  const policy = organization
    ? ((await listAccessPolicies(cf)).find((candidate) => candidate.name === POLICY_NAME) ?? null)
    : null;
  const found: { gateway: AccessApplication | null; apps: AccessApplication | null } = organization
    ? findAccessApplications(await listAccessApplications(cf), scope)
    : { gateway: null, apps: null };
  const people = await readPeople(db, now());
  const mcp = !managedOAuthOn(found.gateway);
  const plan = appsDestinations(base, await readPublicSurfaces(db), { mcp });

  const on = settings.length === ACCESS_SETTINGS.length && found.gateway !== null;
  // Whether the settings (unreadable) name the applications in front: known once `on` recorded them.
  const settingsCurrent: boolean | null =
    on && record && organization && found.apps
      ? settingsNameApplications(record, {
          teamDomain: organization.auth_domain.toLowerCase(),
          gatewayAud: found.gateway!.aud,
          appsAud: found.apps.aud,
        })
      : null;
  const ours = (application: AccessApplication) => splitDestinations(application.destinations ?? [], scope).owned;
  const combined = found.gateway !== null && found.gateway.id === found.apps?.id;
  const appsInSync = found.apps
    ? sameDestinations(
        ours(found.apps).filter((d) => !combined || (d.uri ?? "").toLowerCase() !== gatewayHost),
        plan.destinations,
      )
    : false;
  const gatewayInSync = found.gateway
    ? sameDestinations(
        ours(found.gateway).filter((d) => (d.uri ?? "").toLowerCase() === gatewayHost),
        [gatewayDestination(gatewayHost, !mcp)],
      )
    : false;
  const policyAttached = (application: AccessApplication | null) =>
    application === null || policy === null || (application.policies ?? []).some((p) => p.id === policy.id);
  const notInPolicy = policy
    ? [...people.members, ...people.invited].filter((email) => !ruleEmails(policy.include ?? []).includes(email))
    : [];
  const fixes: string[] = [];
  if (
    !hosted &&
    (!on ||
      settingsCurrent === false ||
      !appsInSync ||
      !gatewayInSync ||
      !policyAttached(found.gateway) ||
      !policyAttached(found.apps) ||
      notInPolicy.length > 0)
  ) {
    fixes.push(`${CLI} access on`);
  }
  const who = policy ? [...ruleEmails(policy.include ?? []), ...ruleDomains(policy.include ?? []).map((d) => `@${d}`)] : [];

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
      value: organization
        ? `${organization.auth_domain}${organization.session_duration ? chalk.dim(` · global session ${organization.session_duration}`) : ""}`
        : chalk.dim(hosted ? "" : "none in this Cloudflare account"),
    },
    {
      label: "Lets in",
      value: policy
        ? `${listed(who)}${notInPolicy.length > 0 ? chalk.yellow(` · not yet: ${listed(notInPolicy)}`) : ""}${chalk.dim(` (policy "${policy.name}")`)}`
        : chalk.dim(`no policy "${POLICY_NAME}" yet`),
    },
    {
      label: gatewayHost,
      value: found.gateway
        ? `${found.gateway.name ?? found.gateway.id} · ${gatewayInSync ? "paths as they should be" : chalk.yellow("paths differ")}${managedOAuthOn(found.gateway) ? " · Managed OAuth" : ""}${policyAttached(found.gateway) ? "" : chalk.yellow(" · policy not attached")}`
        : chalk.dim("no Access application"),
    },
    {
      label: `*.${base}`,
      value: found.apps
        ? `${found.apps.name ?? found.apps.id} · ${appsInSync ? "public routes as they should be" : chalk.yellow("public routes differ")}${policyAttached(found.apps) ? "" : chalk.yellow(" · policy not attached")}`
        : chalk.dim("no Access application"),
    },
    {
      label: "Settings",
      value:
        settings.length > 0
          ? `${listed(settings)}${
              settingsCurrent === false
                ? chalk.yellow(" · name an application that no longer exists: nobody can sign in")
                : settingsCurrent === true
                  ? chalk.dim(" · name the applications above")
                  : chalk.dim(" (values can't be read back)")
            }`
          : chalk.dim("none"),
    },
    ...(people.toLink.length > 0 && on
      ? [{ label: "To link", value: `${listed(people.toLink)} (sign in once with the password through Access)` }]
      : []),
  ];
  out.emit({
    type: "done",
    message: `Cloudflare Access is ${on ? "on" : "off"} for ${gatewayHost}.`,
    display: [
      ...formatFacts(facts),
      ...(fixes.length > 0 ? ["", chalk.dim("To fix: ") + chalk.bold(fixes.join(", "))] : []),
    ].join("\n"),
    data: {
      on,
      hosted,
      team: organization ? { domain: organization.auth_domain, sessionDuration: organization.session_duration ?? null } : null,
      policy: policy
        ? { id: policy.id, name: policy.name, emails: ruleEmails(policy.include ?? []), domains: ruleDomains(policy.include ?? []), notYet: notInPolicy }
        : null,
      applications: {
        gateway: found.gateway
          ? { ...applicationData({ application: found.gateway, outcome: "unchanged" }), inSync: gatewayInSync, managedOAuth: managedOAuthOn(found.gateway), policyAttached: policyAttached(found.gateway) }
          : null,
        apps: found.apps
          ? { ...applicationData({ application: found.apps, outcome: "unchanged" }), inSync: appsInSync, policyAttached: policyAttached(found.apps) }
          : null,
        combined,
      },
      desired: { apps: plan.destinations.map((d) => ({ uri: d.uri, public: d.overrides.map((o) => o.path_pattern) })) },
      settings: { names: settings, current: settingsCurrent },
      linkPending: people.toLink,
      ...(fixes.length > 0 ? { fixes } : {}),
    },
  });
}
