#!/usr/bin/env node
/**
 * A stand-in for `pnpm everyapp` that the setup-skill harness puts in a
 * scratch checkout's node_modules/.bin. It imitates the real CLI's NDJSON
 * contract (packages/cli/src/lib/output/events.ts: one `{ v, ts, type, … }`
 * per line, exit 0 done / 1 error / 2 action required / 251 unknown
 * command) closely enough for a coding agent following the setup files,
 * and never touches Cloudflare. Everything it knows is in one state file;
 * every call is appended to an invocation log with the names it was given
 * and only a sha256 of each value.
 *
 * FAKE_EVERYAPP_RUN names the run directory (state.json, invocations.jsonl);
 * the bin shim run.mjs writes sets it. The Gateway's settable names and the
 * settings model (what an app's manifest needs set, evaluated against the
 * Gateway's names and the app's own: `appSettings`, `evaluateAppSettings`,
 * `appSetupOf`, the registries' `setup` guide pointers) come from the built
 * SDK (@every-app/sdk/internal), so `data.app.setup`, `data.apps[].setup`
 * and the APP_NEEDS_SETUP fix never drift from the real CLI's. What is set:
 * `state.gatewayNames` (plus the install's own once installed) for the
 * Gateway, each app's `secretsSet` for its Worker (unknown, never blocking,
 * before its first deploy: `deployed: false`).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = "pnpm everyapp";
const GATEWAY_WORKER_NAME = "every-app-gateway";
const INSTALL_OWNED = [
  "BETTER_AUTH_SECRET",
  "CLOUDFLARE_ACCOUNT_ID",
  "GATEWAY_DEPLOYMENT_MODE",
  "GATEWAY_URL",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
];
/** The three settings `access on` writes, in lib/access/settings.ts's order (what `show`'s names and the done line list). */
const ACCESS_SETTINGS = ["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_APPS_AUD", "CLOUDFLARE_ACCESS_AUD"];
/** The reusable Access policy `on` keeps, as the real command names it (declared up here: dispatch() runs before the functions below). */
const ACCESS_POLICY_NAME = "Every App gateway members";
/** The Gateway paths Access lets through (lib/access/plan.ts GATEWAY_BYPASS_PATHS): MCP, the OAuth token and registration endpoints, discovery. /oauth/authorize and the consent page stay behind Access. */
const ACCESS_GATEWAY_PUBLIC = ["/mcp", "/mcp/*", "/oauth/token", "/oauth/register", "/.well-known/*"];
/** The cf the real setup reports in setup.toolchain. */
const FAKE_CF_VERSION = "1.0.0-beta.14";
/** How long a fake setup waits for the owner link to be claimed (the real one: 15 minutes). */
const CLAIM_WAIT_MS = Number(process.env["FAKE_EVERYAPP_CLAIM_WAIT_MS"] ?? 5000);
/** Flags that take a value (so the value isn't read as a positional). */
const VALUE_FLAGS = new Set([
  "from-env", "app", "gateway", "account-id", "domain", "team", "email", "email-domain",
  "session", "sender", "inbound", "manifest", "worker", "binding", "file", "out", "name", "template",
]);
/** Where the real CLI says a setup guide lives, in an app that has the skill (lib/app/settings.ts SKILL_DIR). */
const SKILL_DIR = ".claude/skills/everyapp";

/** An expected failure, reported as an `error` event with its code and next step. */
class FakeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;
    this.fix = options.fix;
    this.rerun = options.rerun;
    this.rerunNote = options.rerunNote;
    this.authorize = options.authorize ?? false;
    this.data = options.data;
  }
}

/** What stdin held, read once. */
let stdinText;

const sdk = await loadSdk();

const runDir = process.env["FAKE_EVERYAPP_RUN"];
if (!runDir) {
  process.stderr.write("fake everyapp: FAKE_EVERYAPP_RUN isn't set (run it through the harness's bin shim)\n");
  process.exit(70);
}
const stateFile = path.join(runDir, "state.json");
const logFile = path.join(runDir, "invocations.jsonl");

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);
const json = parsed.flags.has("json");
const cwd = process.cwd();
const out = sink(json);
const record = { ts: new Date().toISOString(), argv, cwd, stdinUsed: false, exit: 0 };

let exitCode = 0;
try {
  exitCode = await dispatch();
} catch (error) {
  if (error instanceof FakeError) {
    out.error(error);
    exitCode = 1;
  } else {
    out.emit({ type: "error", code: "UNEXPECTED", message: String(error?.stack ?? error), retryable: false });
    exitCode = 1;
  }
}
record.exit = exitCode;
fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
process.exitCode = exitCode;

// ---------------------------------------------------------------- dispatch

async function dispatch() {
  const [cmd, sub, ...rest] = parsed.positional;
  const state = readState();
  const help = parsed.flags.has("help") || parsed.flags.has("h");

  if (!cmd) {
    process.stdout.write(helpText("root"));
    return 0;
  }
  const accessEnabled = Boolean(state.accessCommand);
  const groups = {
    secret: ["set", "unset", "list"],
    email: ["show", "set", "unset"],
    db: ["migrate", "query", "restore"],
    ...(accessEnabled ? { access: ["on", "off", "show"] } : {}),
  };
  const commands = ["login", "setup", "update", "install", "status", "create", "dev", "deploy", "release", "delete", ...Object.keys(groups)];
  if (!commands.includes(cmd)) return unknownCommand([], cmd, commands);
  if (cmd in groups) {
    if (!sub || help && !sub) {
      process.stdout.write(helpText(cmd));
      return 0;
    }
    if (!groups[cmd].includes(sub)) return unknownCommand([cmd], sub, groups[cmd]);
  }
  if (help) {
    process.stdout.write(helpText(cmd in groups ? `${cmd} ${sub}` : cmd));
    return 0;
  }

  switch (cmd) {
    case "login":
      return login(state);
    case "status":
      return status(state);
    case "setup":
      return setup(state);
    case "secret":
      return sub === "set" ? secretSet(state, rest) : sub === "unset" ? secretUnset(state, rest) : secretList(state, rest[0]);
    case "email":
      return sub === "show" ? emailShow(state) : sub === "set" ? emailSet(state) : emailUnset(state, rest);
    case "access":
      return sub === "on" ? accessOn(state) : sub === "off" ? accessOff(state) : accessShow(state);
    default:
      return notSimulated(cmd, sub);
  }
}

// ---------------------------------------------------------------- commands

function login(state) {
  out.emit({
    type: "step",
    step: "cloudflare.login",
    status: "skip",
    message: "Already logged in to Cloudflare.",
    data: { email: state.cloudflareEmail ?? null, token: false },
  });
  out.emit({ type: "done", data: { durationMs: 420 } });
  return 0;
}

function status(state) {
  if (!state.installed) {
    // No Gateway in any account this login sees: the real status stops on
    // install_gateway (lib/gateway/discover.ts), exit 2. (Its `done` with
    // installed: false and a GATEWAY_NOT_INSTALLED fix is for an install
    // that stopped before recording itself, which this fake doesn't model.)
    out.emit({
      type: "action_required",
      action: "install_gateway",
      message: `No Gateway in ${state.accountName}'s Cloudflare account (logged in as ${state.cloudflareEmail})\nGateway in another account? Log in to it: ${CLI} login`,
      data: { rerun: `${CLI} setup`, rerunNote: "to install one", accounts: [{ id: state.accountId, name: state.accountName }] },
    });
    return 2;
  }
  const host = gatewayHost(state);
  // Each app as commands/status/index.ts's AppState has it. `setup` is the
  // settings model's AppSetup (lib/app/settings.ts appSetupFrom) for a
  // deployed app whose manifest declares anything to set; null otherwise
  // (a `pending` app has nothing to evaluate yet).
  const apps = state.apps.map((app) => {
    const deployed = app.deployed !== false;
    return {
      id: app.id,
      hostname: `${app.id}.${state.appBaseDomain}`,
      workerName: workerNameOf(state, app),
      status: deployed ? "active" : "pending",
      bound: deployed,
      deployedBy: state.cloudflareEmail,
      email: {
        senders: app.email?.senders ?? [],
        inbound: app.email?.inbound ?? [],
        routed: app.email?.inbound ?? [],
        declaresInbound: Boolean(app.manifest?.email?.inbound),
      },
      publicRoutes: [],
      setup: deployed && declaresSettings(app.manifest) ? appSetupFrom(state, app).setup : null,
    };
  });
  // `fixes[]` as commands/status/index.ts's fixData gives them (#400): code,
  // severity (error | warning | info | settling), message, run, and `note`
  // only when the problem has a runNote (NO_OWNER has none). The order is
  // problems.ts's: the install's, then each app's, then APP_NEEDS_SETUP.
  const fixes = [];
  if (!state.claimed) {
    fixes.push({
      code: "NO_OWNER",
      severity: "warning",
      message: "No owner yet, so nobody can sign in\nApps still deploy. Setup prints a one-time link that creates the owner account.",
      run: `${CLI} setup`,
    });
  }
  for (const app of apps) {
    if (app.status === "pending") {
      fixes.push({
        code: "APP_NOT_UPLOADED",
        severity: "warning",
        message: `${app.id} was registered, but none of its deploys finished`,
        run: `${CLI} deploy from the app's directory, or ${CLI} delete ${app.id}`,
      });
    }
  }
  // A served app whose required settings aren't all set doesn't open
  // (problems.ts needsSetup → appNeedsSetup): each unmet setting with why,
  // where its key comes from and its guide, then the one `secret set`.
  for (const app of apps) {
    if (!app.setup || app.setup.ready) continue;
    fixes.push({
      code: "APP_NEEDS_SETUP",
      severity: "warning",
      message: [`${app.id} needs setup`, ...describeUnmetSettings(app.setup.unmet)].join("\n"),
      run: app.setup.command?.command ?? null,
      ...(app.setup.command?.note ? { note: app.setup.command.note } : {}),
    });
  }
  // `data.access` (#400): `{ on, teamDomain }` from the Worker's secret
  // names and the record `access on` keeps; null on a hosted Gateway, with
  // no Worker yet, or when cf couldn't read them (then an ACCESS_UNKNOWN
  // warning). This fake is always self-hosted with a Worker, and only its
  // `access on` writes the names, so the record is `state.access.team`.
  const accessOn = ACCESS_SETTINGS.every((name) => (state.gatewayNames ?? []).includes(name));
  const access = { on: accessOn, teamDomain: accessOn && state.access?.team ? `${state.access.team}.cloudflareaccess.com` : null };
  const toFix = fixes.filter((fix) => fix.severity === "error" || fix.severity === "warning").length;
  const live = apps.filter((app) => app.status === "active" && app.bound).length;
  const domains = [host, ...apps.map((app) => app.hostname)];
  out.emit({
    type: "done",
    message: `Gateway ${state.gatewayUrl}: ${live} ${live === 1 ? "app" : "apps"} live, ${toFix === 0 ? "nothing to fix" : `${toFix} ${toFix === 1 ? "problem" : "problems"} to fix`}`,
    display: renderStatus(state, apps, access, domains, fixes),
    data: {
      deployed: true,
      installed: true,
      gatewayUrl: state.gatewayUrl,
      accountId: state.accountId,
      mode: "self_hosted",
      release: { version: "0.2.0", sha256: "f".repeat(64) },
      versionId: state.versionId,
      recordedVersionId: state.versionId,
      owner: state.claimed ? state.owner : null,
      claimed: Boolean(state.claimed),
      apps,
      desiredApps: apps.map((app) => app.workerName),
      liveApps: apps.map((app) => app.workerName),
      appBaseDomain: state.appBaseDomain,
      domains,
      liveDomains: domains,
      inSync: true,
      upToDate: true,
      checkout: { version: "0.2.0", treeSha256: "e".repeat(64) },
      tls: true,
      certificates: domains.map((h) => ({ host: h, ready: true })),
      access,
      leases: [],
      fixes,
      durationMs: 2600,
    },
  });
  return 0;
}

function setup(state) {
  // Events as commands/setup/runSetup.ts emits them (and setup/index.ts's
  // done), for a login that is already there. The build and the upload are
  // instant here; the claim is polled briefly (CLAIM_WAIT_MS), since only
  // the person, scripted by the harness, can take it.
  const release = "0.2.0";
  const releaseName = `${release} (built from this checkout)`;
  out.emit({ type: "step", step: "setup.toolchain", status: "ok", message: `Node ${process.versions.node}, cf ${FAKE_CF_VERSION}`, data: { node: process.versions.node, cf: FAKE_CF_VERSION } });
  out.emit({ type: "step", step: "setup.auth", status: "ok", message: `Logged in to Cloudflare as ${state.cloudflareEmail}`, data: { email: state.cloudflareEmail ?? null } });
  out.emit({
    type: "step",
    step: "setup.account",
    status: "ok",
    message: `Setting up EveryApp in ${state.accountName}`,
    data: { id: state.accountId, name: state.accountName, email: state.cloudflareEmail ?? null, gateway: Boolean(state.installed) },
  });
  if (parsed.flags.has("release")) {
    out.emit({ type: "progress", step: "setup.release", message: `Using the release ${parsed.values.get("release")}` });
  }
  const zone = state.zone ?? (state.gatewayDomain ?? "example.com").split(".").slice(-2).join(".");
  let outcome = "up-to-date";
  if (!state.installed) {
    const domain = parsed.values.get("domain") ?? state.gatewayDomain;
    if (!domain) {
      throw new FakeError("DOMAIN_REQUIRED", "Say where the Gateway lives with --domain\nAny hostname under one of the account's domains, e.g. apps.example.com. At a terminal setup asks for it.", {
        fix: `add --domain <host>, e.g. ${CLI} setup --domain apps.${zone} --json`,
        data: { zones: [zone] },
      });
    }
    if (domain !== zone && !domain.endsWith(`.${zone}`)) {
      throw new FakeError("ZONE_NOT_FOUND", `${domain} isn't under a domain in ${state.accountName}\nThis account's active domains: ${zone}.`, {
        fix: "use a hostname under one of them, or add the domain to this account first",
        data: { url: `https://dash.cloudflare.com/${state.accountId}/domains`, zones: [zone] },
      });
    }
    const gatewayUrl = `https://${domain}`;
    out.emit({ type: "step", step: "setup.plan", status: "ok", message: "Account is on Workers Paid", data: { plan: "paid" } });
    out.emit({ type: "step", step: "setup.domain", status: "ok", message: `Apps will live one level below ${domain}`, data: { gatewayHost: domain, appBaseDomain: domain, zone } });
    out.emit({
      type: "step",
      step: "setup.gateway",
      status: "start",
      message: `Installing the Gateway at ${domain} (${releaseName})`,
      data: { change: "install", release, releaseName, from: null, gatewayUrl, account: state.accountName },
    });
    out.emit({ type: "step", step: "gateway.release", status: "ok", message: `Built the Gateway ${release} from this checkout.`, data: { release, cached: false } });
    out.emit({ type: "step", step: "gateway.migrations", status: "ok", message: "Database created", data: { applied: ["0000_init"], fresh: true } });
    out.emit({ type: "step", step: "gateway.deploy", status: "ok", message: "Uploaded", data: { versionId: state.versionId } });
    out.emit({ type: "progress", step: "gateway.tls", message: `Waiting for ${domain}'s certificate` });
    out.emit({ type: "step", step: "setup.gateway", status: "ok", message: `The Gateway (${releaseName}) is live at ${gatewayUrl}`, data: { versionId: state.versionId, release, releaseName } });
    state.gatewayDomain = domain;
    state.gatewayUrl = gatewayUrl;
    state.appBaseDomain = domain;
    state.installed = true;
    writeState(state);
    outcome = "installed";
  } else {
    const domain = parsed.values.get("domain");
    if (domain && domain !== state.gatewayDomain) {
      throw new FakeError("DOMAIN_CHANGE_UNSUPPORTED", `The Gateway lives at ${state.gatewayDomain}; it can't move to ${domain}`, { fix: `rerun without --domain` });
    }
    out.emit({ type: "step", step: "setup.domain", status: "ok", message: `Apps will live one level below ${state.appBaseDomain}`, data: { gatewayHost: state.gatewayDomain, appBaseDomain: state.appBaseDomain, zone } });
    out.emit({ type: "step", step: "setup.gateway", status: "skip", message: `The Gateway is up to date with ${releaseName}`, data: { upToDate: true, release, releaseName, account: state.accountName } });
  }

  const gatewayUrl = state.gatewayUrl;
  const adminUrl = `${gatewayUrl}/admin`;
  const doneData = (owner, ownerCreated) => ({
    gatewayUrl,
    adminUrl,
    organizationName: owner?.organizationName ?? null,
    owner: owner?.email ?? null,
    release,
    gateway: outcome,
    facts: [
      { label: "Gateway", value: gatewayUrl },
      ...(outcome === "installed" || ownerCreated ? [{ label: "Admin", value: adminUrl, note: "invite people, choose who opens which app" }] : []),
    ],
    // The self-hosted list of setup/index.ts's nextAfterInstall (#401): an
    // app, Access in front, AI, then email. A hosted Gateway has no Access
    // line; this fake is always self-hosted.
    ...(outcome === "installed" || ownerCreated
      ? {
          next: [
            { command: `${CLI} create my-app`, note: "start your first app" },
            { command: `${CLI} access on`, note: "put Cloudflare Access in front of your Gateway (recommended)" },
            { command: `${CLI} secret set OPENAI_API_KEY`, note: "AI for apps (or OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN)" },
            { command: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME`, note: "email invites and password resets; needs Cloudflare Email Sending" },
          ],
        }
      : { next: [{ command: `${CLI} status`, note: "see apps, domains and certificates" }] }),
    durationMs: 3100,
  });
  if (state.claimed) {
    out.emit({ type: "step", step: "setup.owner", status: "skip", message: `Owner account is ${state.owner.email}`, data: { ...state.owner } });
    out.emit({ type: "done", data: doneData(state.owner, false) });
    return 0;
  }
  // The claim: a link only a person can open. The real run waits 15
  // minutes for it; this one polls the state file briefly, in case the
  // person (the harness) took it meanwhile, then stops on the action.
  const url = `${gatewayUrl}/setup#token=est_fake_${state.setupLinkSerial ?? 1}`;
  const replaced = (state.setupLinkSerial ?? 1) > 1;
  state.setupLinkSerial = (state.setupLinkSerial ?? 1) + 1;
  state.setupUrl = url;
  writeState(state);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  out.emit({
    type: "action_required",
    action: "claim_owner",
    step: "setup.owner",
    message: replaced
      ? "Open this new link to create the owner account\nThe link shown before no longer works. This one works once and expires in 24 hours. Treat it like a password."
      : "Open this link to create the owner account\nWorks once and expires in 24 hours. Treat it like a password.",
    data: { url, expiresAt, replaced, waiting: true, waitingFor: "the owner account" },
  });
  const waited = Date.now();
  return waitForClaim(waited).then((claimed) => {
    if (claimed) {
      const now = readState();
      out.emit({ type: "step", step: "setup.owner", status: "ok", message: `Owner account created for ${now.owner.email}`, data: { ...now.owner } });
      out.emit({ type: "done", data: doneData(now.owner, true) });
      return 0;
    }
    out.emit({
      type: "action_required",
      action: "claim_owner",
      message: `Open the setup link above to create the owner account\nNobody opened it within ${roughly(Date.now() - waited)}. It still works for 24 hours; running setup before it's opened replaces it.`,
      data: { rerun: `${CLI} setup`, rerunNote: "to finish", setupUrl: url, expiresAt },
    });
    return 2;
  });
}

/** Whether the person claimed the owner link while setup waited (the harness writes `claimed` to the state file). */
async function waitForClaim(since) {
  while (Date.now() - since < CLAIM_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      if (readState().claimed) return true;
    } catch {
      // Being rewritten; next tick.
    }
  }
  return false;
}

/** "5 seconds", "2 minutes": a wait's length in words, as the real messages say it. */
function roughly(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** Commands that act on the Gateway stop without one, as requireGateway (lib/gateway/discover.ts) does. */
function requireGateway(state) {
  if (state.installed) return;
  throw new FakeError(
    "GATEWAY_NOT_FOUND",
    `No Gateway in ${state.accountName}, the only account this login sees\nLogged in to Cloudflare as ${state.cloudflareEmail}.`,
    { fix: `install one: ${CLI} setup`, data: { accounts: [{ id: state.accountId, name: state.accountName }] } },
  );
}

/**
 * `secret list [<app>]` as commands/secret/index.ts's listSecrets: one app's
 * settings (the app named, from anywhere, by the manifest its deploy stored;
 * or the app whose everyapp.config.ts is here) with `data.app.setup`, the
 * kept `data.app.declared`/`workers` and `data.gateway.needed`/`missing`,
 * and `next`; elsewhere with no app named, the Gateway's names and every
 * app's settings (`data.apps[] { id, setup }`).
 */
function secretList(state, appId) {
  requireGateway(state);
  const gatewayNames = gatewayNamesOf(state);
  const settable = [...sdk.SETTABLE_GATEWAY_SETTINGS];
  let app = null;
  if (appId) {
    // The registry's row (readApp in lib/gateway/registry.ts); an app with `deployed: false` has one (status
    // pending, no Worker yet), an id the state doesn't know has none.
    app = appById(state, appId);
    if (!app) {
      throw new FakeError("APP_NOT_FOUND", `${appId} isn't deployed to this Gateway yet`, { rerun: `${CLI} deploy`, rerunNote: "in the app's directory" });
    }
  } else {
    app = appHere(state);
  }
  if (!app) {
    // What you set, then what setup did, then, of what you could set, only
    // what some app here reads (this fake is self-hosted: the hosted
    // Gateway's own switches never show); then each app's settings, for
    // the apps that declare any.
    const yours = gatewayNames.filter((name) => !INSTALL_OWNED.includes(name));
    const setups = gatewayNames.filter((name) => INSTALL_OWNED.includes(name));
    const read = new Set(state.apps.flatMap((each) => gatewayNamesRead(each.manifest ?? {})));
    const relevant = settable.filter((name) => !sdk.isHostedOnlyGatewaySetting(name));
    const unset = relevant.filter((name) => !gatewayNames.includes(name));
    const listed = unset.filter((name) => read.has(name));
    const more = unset.length - listed.length;
    const apps = [];
    for (const each of state.apps) {
      if (!declaresSettings(each.manifest)) continue;
      const { report, setup } = appSetupFrom(state, each);
      apps.push({ id: each.id, setup, rows: settingsRows(each.id, report.settings) });
    }
    const rows = apps.flatMap((each) => each.rows);
    out.emit({
      type: "done",
      message: [
        `Gateway secrets · ${gatewayHost(state)}`,
        "",
        ...table(["NAME", "SET BY"], [...yours.map((n) => [n, "you"]), ...setups.map((n) => [n, "setup"]), ...listed.map((n) => [n, "not set"])]),
        ...(more > 0 ? [`${more} more can be set; see docs/capabilities.md`] : []),
        ...(rows.length ? ["", ...table(["APP", "SETTING", "WHERE", "STATUS"], rows)] : []),
      ].join("\n"),
      data: {
        gateway: { workerName: GATEWAY_WORKER_NAME, names: gatewayNames, settable },
        apps: apps.map(({ id, setup }) => ({ id, setup })),
        durationMs: 2900,
      },
    });
    return 0;
  }
  const manifest = app.manifest ?? {};
  const declared = sdk.secretNames(manifest);
  const workerName = app.deployed === false ? null : workerNameOf(state, app);
  // The app's Workers, once it is deployed: its own, with every name it
  // holds (everyapp's own included) and the declared names it lacks.
  const own = workerName ? [...(app.secretsSet ?? [])] : null;
  const workers = workerName
    ? [{ workerName, names: ["EVERY_APP_ORG_ID", "GATEWAY_URL", ...own], missing: declared.filter((name) => !own.includes(name)) }]
    : [];
  const { report, setup } = appSetupFrom(state, app);
  // Before the first deploy there is no Worker to hold the app's own.
  const rows = settingsRows(app.id, report.settings).map((row) => (!workerName && row[2] === app.id ? [row[0], row[1], row[2], "after first deploy"] : row));
  // What to run: the model's one command (its any-of note beside it), and
  // the deploy when the app has no Worker yet (its own read as unknown
  // until then, which never blocks, so the command leaves them out).
  const command = setup.command ? [setup.command.note ? { command: setup.command.command, note: setup.command.note } : setup.command.command] : [];
  const next = workerName ? command : [...command, `${CLI} deploy`];
  out.emit({
    type: "done",
    message: rows.length
      ? [
          ...table(["SETTING", "WHERE", "STATUS"], rows.map((row) => row.slice(1))),
          ...(!workerName && declared.length ? ["", `${app.id} isn't deployed yet; its own secrets can be set after that.`] : []),
        ].join("\n")
      : `${app.id} declares no secrets and needs no Gateway settings.`,
    data: {
      app: {
        id: app.id,
        deployed: workerName !== null,
        workerName,
        declared,
        workers,
        secretNames: own,
        settings: report.settings,
        setup,
      },
      gateway: {
        workerName: GATEWAY_WORKER_NAME,
        names: gatewayNames,
        needed: gatewayNeeds(report.settings, gatewayNames),
        missing: gatewayMissing(report.settings, gatewayNames),
        settable,
      },
      ...(rows.length && next.length ? { next } : {}),
      durationMs: 5100,
    },
  });
  return 0;
}

async function secretSet(state, names) {
  if (names.length === 0) return missingArgument("secret set");
  const fromEnv = parsed.values.get("from-env");
  record.names = names;
  record.fromEnv = fromEnv ?? null;
  // A value on the command line: the real CLI reads it as another name and
  // refuses it; the harness flags it either way.
  const odd = names.filter((name) => !/^[A-Z][A-Z0-9_]*$/.test(name));
  if (odd.length) record.valueLikeArgs = odd;
  const piped = !fromEnv && !process.stdin.isTTY;
  if ((fromEnv || piped) && names.length > 1) {
    // Checked before anything else, as the real one does; but only once a
    // piped value is actually there (an empty stdin is "no value", below).
    if (fromEnv || (await readStdin()) !== "") {
      throw new FakeError(
        "SECRET_SEVERAL_NAMES",
        `${fromEnv ? "--from-env" : "A piped value"} sets one secret at a time, and you named ${names.length}`,
        { fix: `run it once per name, e.g. ${fromEnv ? `${CLI} secret set ${names[0]} --from-env ${fromEnv}` : `echo "$${names[0]}" | ${CLI} secret set ${names[0]}`}` },
      );
    }
  }
  const route = routeNames(state, names, "set");
  if (route.gateway.length) requireGateway(state);
  const app = route.app;
  if (app && app.deployed === false) {
    // Found in the directory (`--app` on an undeployed app is refused in routeNames, as the registry has no row).
    throw new FakeError("APP_NOT_FOUND", `${app.id} isn't deployed yet\nIts secrets can be set after its first deploy. Nothing was changed.`, { rerun: `${CLI} deploy` });
  }
  // The values, read as the real CLI does: --from-env, else stdin when
  // something is piped, else a hidden prompt, which needs a terminal.
  const values = {};
  for (const name of names) {
    let value;
    if (fromEnv) {
      value = process.env[fromEnv];
      if (!value) {
        throw new FakeError("SECRET_EMPTY", `$${fromEnv} is empty or not set`, { fix: `export ${fromEnv} first, or name another variable with --from-env` });
      }
    } else if (piped) {
      value = (await readStdin()).replace(/\r?\n$/, "");
      if (value) record.stdinUsed = true;
    }
    if (!value) {
      throw new FakeError(
        "SECRET_VALUE_REQUIRED",
        `Can't ask for ${name}'s value without a terminal\nOr pipe it in: echo "$${name}" | ${CLI} secret set ${name}`,
        { rerun: `${CLI} secret set ${name} --from-env ${name}` },
      );
    }
    values[name] = value;
  }
  record.valueSha256 = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, sha256(value)]));
  for (const name of route.gateway) {
    out.emit({ type: "progress", step: "secrets.route", message: `${name} is a Gateway setting → Worker ${GATEWAY_WORKER_NAME}` });
  }
  for (const name of route.appNames) {
    out.emit({ type: "progress", step: "secrets.route", message: `${name} is ${app.id}'s secret → Worker ${workerNameOf(state, app)}` });
  }
  const applied = {};
  if (route.gateway.length) {
    out.emit({ type: "step", step: "secrets.gateway", status: "start", message: "Updating the Gateway..." });
    state.gatewayNames = [...new Set([...(state.gatewayNames ?? []), ...route.gateway])];
    for (const name of route.gateway) (state.values ??= {})[name] = sha256(values[name]);
    state.versionId = nextVersion(state.versionId);
    out.emit({ type: "step", step: "secrets.gateway", status: "ok", message: `Set ${listed(route.gateway)} on the Gateway`, data: { workerName: GATEWAY_WORKER_NAME, versionId: state.versionId } });
    applied.gateway = { names: route.gateway, versions: { [GATEWAY_WORKER_NAME]: state.versionId } };
  }
  if (app && route.appNames.length) {
    out.emit({ type: "step", step: "secrets.app", status: "start", message: `Updating ${app.id}...` });
    // The app Worker's new version, and its secret names recorded on its row (`secretsSet` is both here).
    app.secretsSet = [...new Set([...(app.secretsSet ?? []), ...route.appNames])];
    const versions = { [workerNameOf(state, app)]: nextVersion(state.versionId) };
    out.emit({ type: "step", step: "secrets.app", status: "ok", message: `Set ${listed(route.appNames)} on ${app.id}`, data: { action: "set", names: route.appNames, versions } });
    applied.app = { id: app.id, workerName: workerNameOf(state, app), names: route.appNames, versions };
  }
  writeState(state);
  out.emit({ type: "done", message: `Set ${describeApplied(applied, "on")}`, data: { ...applied, durationMs: 2400 } });
  return 0;
}

/** "OPENAI_API_KEY on the Gateway, and GITHUB_TOKEN on analytics" (secret/index.ts describe). */
function describeApplied(applied, preposition) {
  return [
    ...(applied.gateway ? [`${listed(applied.gateway.names)} ${preposition} the Gateway`] : []),
    ...(applied.app ? [`${listed(applied.app.names)} ${preposition} ${applied.app.id}`] : []),
  ].join(", and ");
}

function secretUnset(state, names) {
  if (names.length === 0) return missingArgument("secret unset");
  record.names = names;
  const route = routeNames(state, names, "unset");
  const held = [
    ...route.gateway.filter((name) => gatewayNamesOf(state).includes(name)),
    ...route.appNames.filter((name) => (route.app?.secretsSet ?? []).includes(name)),
  ];
  const where = [...(route.gateway.length ? ["the Gateway"] : []), ...(route.app ? [route.app.id] : [])].join(" or ");
  if (held.length === 0) {
    out.emit({ type: "done", message: `${listed(names)} ${names.length === 1 ? "isn't" : "aren't"} set on ${where}. Nothing changed.`, data: { removed: false } });
    return 0;
  }
  if (!parsed.flags.has("yes") && !parsed.flags.has("y")) {
    throw new FakeError("CONFIRMATION_REQUIRED", "Removing secrets needs confirmation, and there's no terminal to ask in", {
      rerun: `${CLI} ${argv.filter((a) => a !== "--json").join(" ")} --yes --json`.replace("  ", " "),
      authorize: true,
    });
  }
  // Only the names a Worker holds are removed (keepHeldNames), each destination a new version.
  const applied = {};
  const gatewayHeld = route.gateway.filter((name) => gatewayNamesOf(state).includes(name));
  if (gatewayHeld.length) {
    state.gatewayNames = (state.gatewayNames ?? []).filter((name) => !gatewayHeld.includes(name));
    state.versionId = nextVersion(state.versionId);
    applied.gateway = { names: gatewayHeld, versions: { [GATEWAY_WORKER_NAME]: state.versionId } };
  }
  const appHeld = route.appNames.filter((name) => (route.app?.secretsSet ?? []).includes(name));
  if (route.app && appHeld.length) {
    route.app.secretsSet = (route.app.secretsSet ?? []).filter((name) => !appHeld.includes(name));
    applied.app = { id: route.app.id, workerName: workerNameOf(state, route.app), names: appHeld, versions: { [workerNameOf(state, route.app)]: nextVersion(state.versionId) } };
  }
  writeState(state);
  out.emit({ type: "done", message: `Removed ${describeApplied(applied, "from")}`, data: { ...applied, durationMs: 2100 } });
  return 0;
}

function emailShow(state) {
  const app = appHere(state, true);
  const declares = { sends: Boolean(app.manifest?.capabilities?.email), receives: Boolean(app.manifest?.email?.inbound) };
  const senders = app.email?.senders ?? [];
  const inbound = app.email?.inbound ?? [];
  const data = { app: { id: app.id, workerName: workerNameOf(state, app), status: "active", deployed: true }, declares, senders, inbound, routed: inbound };
  const rows = [...senders.map((s) => [s, "sender", declares.sends ? "allowed" : "not declared"]), ...inbound.map((a) => [a, "inbound", declares.receives ? "routed" : "not declared"])];
  out.emit({
    type: "done",
    message: rows.length ? table(["ADDRESS", "KIND", "STATUS"], rows).join("\n") : `${app.id} has no senders or inbound addresses yet.`,
    data,
  });
  return 0;
}

function emailSet(state) {
  const app = appHere(state, true);
  const senders = parsed.lists.get("sender");
  const inbound = parsed.lists.get("inbound");
  if (!senders && !inbound) {
    throw new FakeError("EMAIL_NOTHING_TO_SET", "Name what to set: --sender, --inbound, or both", { fix: `${CLI} email set --sender '*@mail.example.com'` });
  }
  if (senders && !app.manifest?.capabilities?.email) {
    throw new FakeError("EMAIL_NOT_DECLARED", `${app.id} doesn't send email\nIts everyapp.config.ts doesn't list capabilities.email.`, { fix: 'add capabilities: { email: { access: "write" } } to everyapp.config.ts, deploy, then run this again' });
  }
  if (inbound && !app.manifest?.email?.inbound) {
    throw new FakeError("EMAIL_INBOUND_NOT_DECLARED", `${app.id} doesn't receive email\nIts everyapp.config.ts doesn't declare email: { inbound: true }.`, { fix: "add email: { inbound: true } to everyapp.config.ts, deploy, then run this again" });
  }
  app.email ??= { senders: [], inbound: [] };
  if (senders) app.email.senders = senders;
  if (inbound) app.email.inbound = inbound;
  writeState(state);
  out.emit({ type: "step", step: "email.update", status: "ok", message: "Email addresses set" });
  out.emit({ type: "done", message: `${app.id}: ${senders ? `senders ${listed(senders)}` : ""}${senders && inbound ? "; " : ""}${inbound ? `inbound ${listed(inbound)}` : ""} on the Gateway`, data: { app: { id: app.id }, senders: app.email.senders, inbound: app.email.inbound, routed: app.email.inbound } });
  return 0;
}

function emailUnset(state, lists) {
  const app = appHere(state, true);
  if (lists.length === 0) return missingArgument("email unset");
  app.email ??= { senders: [], inbound: [] };
  for (const list of lists) {
    if (list === "senders") app.email.senders = [];
    else if (list === "inbound") app.email.inbound = [];
    else {
      out.emit({ type: "error", code: "INVALID_VALUE", message: `"${list}" won't do for <senders|inbound>\nUse senders, inbound, or both.`, retryable: false, data: { usage: `${CLI} email unset <senders|inbound>... [flags]` } });
      return 252;
    }
  }
  writeState(state);
  out.emit({ type: "done", message: `Cleared ${listed(lists)} for ${app.id}`, data: { senders: app.email.senders, inbound: app.email.inbound } });
  return 0;
}

/** Who still signs in once with their password through Access: every member, until a scenario rule says they did (`access.linkPending`). */
function accessLinkPending(state) {
  const pending = state.access?.linkPending;
  if (Array.isArray(pending)) return pending;
  return state.claimed ? [state.owner.email, ...(state.members ?? [])] : [];
}

/** One of the two Access applications, as `on` and `show` report it (PR #379's shape: id, aud, name, outcome, destinations). */
function accessApplication(kind, state, outcome) {
  return kind === "gateway"
    ? { id: `${"0".repeat(31)}a`, aud: "a".repeat(64), name: "Every App gateway", outcome, destinations: [{ uri: gatewayHost(state), public: ACCESS_GATEWAY_PUBLIC }] }
    : { id: `${"0".repeat(31)}b`, aud: "b".repeat(64), name: "Every App apps", outcome, destinations: [{ uri: `*.${state.appBaseDomain}`, public: [] }] };
}

/** `access show`: PR #379's data (on, team, policy with notYet, applications with inSync and policyAttached, desired, settings.current, linkPending, fixes). */
function accessShow(state) {
  const access = state.access ?? { on: false, team: null };
  const host = gatewayHost(state);
  const people = state.claimed ? [state.owner.email, ...(state.members ?? [])] : [];
  const team = access.team ? { domain: `${access.team}.cloudflareaccess.com`, sessionDuration: access.globalSession ?? null } : null;
  const policyEmails = access.emails ?? people;
  const policy = access.on
    ? { id: `${"0".repeat(31)}c`, name: ACCESS_POLICY_NAME, emails: policyEmails, domains: access.domains ?? [], notYet: people.filter((email) => !policyEmails.includes(email)) }
    : null;
  const desired = { apps: [{ uri: `*.${state.appBaseDomain}`, public: [] }] };
  const data = access.on
    ? {
        on: true,
        hosted: false,
        team,
        policy,
        applications: {
          gateway: { ...accessApplication("gateway", state, "unchanged"), inSync: true, managedOAuth: false, policyAttached: true },
          apps: { ...accessApplication("apps", state, "unchanged"), inSync: true, policyAttached: true },
          combined: false,
        },
        desired,
        settings: { names: ACCESS_SETTINGS, current: true },
        linkPending: accessLinkPending(state),
        ...(policy.notYet.length ? { fixes: [`${CLI} access on`] } : {}),
      }
    : {
        on: false,
        hosted: false,
        team,
        policy: null,
        applications: { gateway: null, apps: null, combined: false },
        desired,
        settings: { names: [], current: null },
        linkPending: accessLinkPending(state),
        fixes: [`${CLI} access on`],
      };
  out.emit({ type: "done", message: `Cloudflare Access is ${access.on ? "on" : "off"} for ${host}.`, data });
  return 0;
}

/** `access on`: PR #379's order (arguments, team, PIN, policy, applications, settings) and done event. */
function accessOn(state) {
  const access = (state.access ??= { on: false, team: null });
  const host = gatewayHost(state);
  const base = state.appBaseDomain;
  const step = "access.update";
  // The arguments first, as the real command does: no network.
  const session = parsed.values.get("session") ?? "720h";
  const teamSession = parsed.values.get("team-session") ?? null;
  for (const [flag, value] of [["--session", session], ["--team-session", teamSession]]) {
    if (value !== null && !/^(?:\d+h(?:\d+m)?|\d+m)$/.test(value)) {
      throw new FakeError("ACCESS_SESSION_INVALID", `${flag} ${value} isn't a duration Access takes\nUse hours and minutes, like 720h or 2h30m.`);
    }
  }
  const emails = (parsed.lists.get("email") ?? []).map((email) => email.trim().toLowerCase());
  for (const email of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FakeError("ACCESS_EMAIL_INVALID", `--email ${email} isn't an email address`);
  }
  const domains = (parsed.lists.get("email-domain") ?? []).map((domain) => domain.trim().toLowerCase().replace(/^@/, ""));
  for (const domain of domains) {
    if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(domain)) {
      throw new FakeError("ACCESS_DOMAIN_INVALID", `--email-domain ${domain} isn't a domain\nUse the part after the @, like example.com.`);
    }
  }
  out.emit({ type: "step", step, status: "start", message: "Checking Cloudflare Access..." });
  const people = state.claimed ? [state.owner.email, ...(state.members ?? [])] : [];
  if (people.length === 0 && emails.length === 0 && !access.on) {
    throw new FakeError(
      "ACCESS_NOBODY_ALLOWED",
      "Nobody to let in yet\nThe Gateway has no members or invitations, and no --email was given, so the Access policy would let nobody in. Claim the Gateway first, or name who will (the setup link is then behind Access too).",
      { rerun: `${CLI} access on --email <your address>` },
    );
  }
  const unknown = emails.filter((email) => !people.includes(email));
  if (unknown.length) {
    out.emit({
      type: "warning",
      code: "ACCESS_EMAIL_NOT_INVITED",
      step,
      message: `${listed(unknown)} ${unknown.length === 1 ? "has" : "have"} no account on this Gateway\nAccess will let them through, but the Gateway refuses anyone it doesn't know. Invite them in Manage workspace → Users.`,
      data: { emails: unknown },
    });
  }
  // 1. The team: its sign-in domain is permanent once used.
  let team = access.team;
  let created = false;
  if (!team) {
    const flag = parsed.values.get("team");
    const suggested = (state.gatewayDomain ?? host).split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "") || "every-app";
    if (!flag) {
      throw new FakeError(
        "ACCESS_TEAM_REQUIRED",
        "Choose a name for the Zero Trust team with --team\nThis Cloudflare account has none yet. Its sign-in page becomes https://<name>.cloudflareaccess.com and can't be changed later.",
        { fix: `add --team ${suggested}, or another name`, data: { suggested } },
      );
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(flag)) {
      throw new FakeError("ACCESS_TEAM_INVALID", `--team ${flag} can't be a team name\nUse lowercase letters, digits and dashes: it becomes <name>.cloudflareaccess.com.`);
    }
    team = flag;
    created = true;
    out.emit({ type: "progress", step, message: `Creating the Zero Trust team ${team}.cloudflareaccess.com` });
    access.globalSession = teamSession ?? session;
  } else if (teamSession !== null && access.globalSession !== teamSession) {
    out.emit({ type: "progress", step, message: `Setting the team's global session to ${teamSession}` });
    access.globalSession = teamSession;
  }
  // 2. A way to sign in: the one-time PIN, unless the team has another provider.
  if (created) out.emit({ type: "progress", step, message: "Adding the one-time PIN identity provider" });
  // 3. The policy: never fewer people than before.
  const wasOn = access.on;
  const before = { emails: wasOn ? (access.emails ?? people) : [], domains: wasOn ? (access.domains ?? []) : [] };
  const policyEmails = [...new Set([...before.emails, ...people, ...emails])];
  const policyDomains = [...new Set([...before.domains, ...domains])];
  const added = [
    ...policyEmails.filter((email) => !before.emails.includes(email)),
    ...policyDomains.filter((domain) => !before.domains.includes(domain)).map((domain) => `@${domain}`),
  ];
  if (!wasOn) out.emit({ type: "progress", step, message: `Creating the Access policy "${ACCESS_POLICY_NAME}"` });
  else if (added.length) out.emit({ type: "progress", step, message: `Adding ${added.length} rule${added.length === 1 ? "" : "s"} to the Access policy` });
  // 4. The applications, the apps' first.
  if (!wasOn) {
    out.emit({ type: "progress", step, message: `Creating the Access application "Every App apps"` });
    out.emit({ type: "progress", step, message: `Creating the Access application "Every App gateway"` });
  }
  // 5. The Gateway's settings, all three in one new version.
  const writeSettings = !wasOn || parsed.flags.has("write-settings");
  if (writeSettings) {
    out.emit({ type: "step", step: "secrets.gateway", status: "start", message: "Updating the Gateway..." });
    state.gatewayNames = [...new Set([...(state.gatewayNames ?? []), ...ACCESS_SETTINGS])];
    state.versionId = nextVersion(state.versionId);
    out.emit({ type: "step", step: "secrets.gateway", status: "ok", message: `Set ${listed(ACCESS_SETTINGS)} on the Gateway`, data: { workerName: GATEWAY_WORKER_NAME, versionId: state.versionId } });
  }
  access.team = team;
  access.on = true;
  access.emails = policyEmails;
  access.domains = policyDomains;
  access.linkPending = wasOn ? accessLinkPending(state) : people;
  writeState(state);
  out.emit({ type: "step", step, status: "ok" });

  const pending = access.linkPending;
  const outcome = wasOn ? "unchanged" : "created";
  const who = [...policyEmails, ...policyDomains.map((domain) => `@${domain}`)];
  const said = [
    created
      ? `Zero Trust team ${team}.cloudflareaccess.com (created · sign-in through a one-time PIN).`
      : `Zero Trust team ${team}.cloudflareaccess.com · sign-in through a one-time PIN.`,
    ...(created ? ["One-time PIN sign-in (added: Access emails people a code)."] : []),
    !wasOn
      ? `Access policy "${ACCESS_POLICY_NAME}" (lets in ${listed(who)}).`
      : added.length
        ? `Access policy "${ACCESS_POLICY_NAME}" (now also lets in ${listed(added)}).`
        : `Access policy "${ACCESS_POLICY_NAME}" lets in ${listed(who)}.`,
    wasOn ? `Access in front of ${host} is as it should be.` : `Access in front of ${host} (created · MCP and the OAuth endpoints let through).`,
    wasOn ? `Access in front of *.${base} is as it should be (no app has public routes).` : `Access in front of *.${base} (created · no app has public routes).`,
    writeSettings
      ? `Gateway settings (${ACCESS_SETTINGS.join(", ")} · one new version).`
      : "Gateway settings kept: they name these applications already (--write-settings writes them again).",
    ...(pending.length
      ? [`Sign in at https://${host}: ${listed(pending)} sign${pending.length === 1 ? "s" : ""} in once with their${pending.length === 1 ? "" : " own"} password; Access emails them a code first. After that Access alone signs them in.`]
      : []),
    ...(domains.length
      ? [`People at ${listed(policyDomains)} pass Access, but still need an invitation here, unless they may join on their first sign-in: ${CLI} secret set CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS (${policyDomains.join(", ")}).`]
      : []),
    "MCP clients and personal access tokens keep working: /mcp, the OAuth endpoints and each app's public routes are let through without a login.",
    `Once everyone has signed in through Access, passwords can go: ${CLI} secret set EMAIL_PASSWORD_SIGN_IN (false).`,
  ];
  const next = [
    ...(domains.length ? [{ command: `${CLI} secret set CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS`, note: `${policyDomains.join(", ")}: people there join as members on their first sign-in` }] : []),
    { command: `${CLI} secret set EMAIL_PASSWORD_SIGN_IN`, note: "false, once everyone has linked Access" },
  ];
  out.emit({
    type: "done",
    message: said.join(" "),
    data: {
      team: { domain: `${team}.cloudflareaccess.com`, created, sessionSet: created || teamSession !== null ? (teamSession ?? session) : null, globalSession: access.globalSession ?? null },
      signInMethods: [{ id: `${"0".repeat(31)}d`, type: "onetimepin", name: null }],
      identityProviders: { oneTimePinAdded: created },
      policy: { id: `${"0".repeat(31)}c`, name: ACCESS_POLICY_NAME, created: !wasOn, added, emails: policyEmails, domains: policyDomains },
      applications: { gateway: accessApplication("gateway", state, outcome), apps: accessApplication("apps", state, outcome), combined: false },
      settings: { names: ACCESS_SETTINGS, outcome: writeSettings ? "set" : "kept", reason: writeSettings ? (wasOn ? "asked" : "missing") : null },
      signIn: { url: `https://${host}`, pending, first: "pin" },
      next,
      durationMs: 6200,
    },
  });
  return 0;
}

function accessOff(state) {
  const access = state.access ?? { on: false };
  if (!access.on) {
    out.emit({ type: "done", message: "Cloudflare Access is already off. Nothing changed.", data: { removed: false } });
    return 0;
  }
  if (!parsed.flags.has("yes") && !parsed.flags.has("y")) {
    throw new FakeError("CONFIRMATION_REQUIRED", "Turning Cloudflare Access off needs confirmation, and there's no terminal to ask in", { rerun: `${CLI} access off --yes --json`, authorize: true });
  }
  out.emit({ type: "step", step: "access.off", status: "start", message: "Turning Cloudflare Access off..." });
  access.on = false;
  state.gatewayNames = (state.gatewayNames ?? []).filter((name) => !ACCESS_SETTINGS.includes(name));
  writeState(state);
  out.emit({ type: "step", step: "access.off", status: "ok" });
  out.emit({ type: "done", message: "Cloudflare Access is off. The team and its policy are kept.", data: { settings: { removed: ACCESS_SETTINGS }, applications: { deleted: 2 } } });
  return 0;
}

function notSimulated(cmd, sub) {
  const name = [cmd, sub].filter(Boolean).join(" ");
  out.emit({ type: "warning", code: "FAKE_NOT_SIMULATED", message: `This is the test harness's fake everyapp: ${name} does nothing here (the person runs it on their own machine)` });
  out.emit({ type: "done", message: `${name}: nothing to do (fake everyapp)`, data: { simulated: false, durationMs: 10 } });
  return 0;
}

// ---------------------------------------------------------------- routing

/**
 * Where names go, as the real `routeNames` and `resolve` decide: a settable
 * name to the Gateway; anything else to the app, which must list it under
 * `secrets`: with `--app <id>` the app by that id, by the manifest its
 * deploy stored (from anywhere; the directory is never read), else the app
 * whose everyapp.config.ts is here.
 */
function routeNames(state, names, action) {
  const gateway = names.filter((name) => sdk.isSettableGatewaySetting(name));
  const rest = names.filter((name) => !sdk.isSettableGatewaySetting(name));
  if (rest.length === 0) return { gateway, app: null, appNames: [] };
  const appId = parsed.values.get("app");
  let app = null;
  if (appId) {
    requireGateway(state);
    app = appById(state, appId);
    if (!app || app.deployed === false) {
      throw new FakeError(
        "APP_NOT_FOUND",
        `${appId} isn't deployed to this Gateway\nAn app's secrets can be set after its first deploy. Nothing was changed.`,
        { rerun: `${CLI} status`, rerunNote: "lists its apps" },
      );
    }
  } else {
    app = appHere(state);
  }
  // With --app the manifest is the registry's: a refusal says so, and the rerun keeps the flag.
  const registry = Boolean(appId);
  const appFlag = registry ? ` --app ${app.id}` : "";
  const declared = app ? sdk.secretNames(app.manifest ?? {}) : [];
  for (const name of rest) {
    if (app && declared.includes(name)) continue;
    const match = closeName(name, [...sdk.SETTABLE_GATEWAY_SETTINGS, ...declared]);
    if (match) {
      throw new FakeError("SECRET_NOT_DECLARED", `${name} isn't a Gateway setting${app ? ` or one of ${app.id}'s secrets` : ""}`, {
        rerun: `${CLI} secret ${action} ${names.map((each) => (each === name ? match : each)).join(" ")}${appFlag}`,
        data: { didYouMean: match },
      });
    }
    if (INSTALL_OWNED.includes(name) && !app) {
      throw new FakeError("SECRET_NOT_SETTABLE", `${name} can't be changed with secret ${action}\nIt's one of the Gateway's own keys, written once by setup.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new FakeError("SECRET_NAME_INVALID", `"${name}" isn't a valid secret name`, { fix: "use letters, digits and underscores, starting with a letter, e.g. GITHUB_TOKEN" });
    }
    if (!app) {
      throw new FakeError(
        "SECRET_NOT_DECLARED",
        `${name} isn't a Gateway setting, and there's no app here\nAn app's own secrets are ${action === "set" ? "set" : "removed"} from the app's directory (where everyapp.config.ts is), or from anywhere with --app <id>.\nGateway settings: ${CLI} secret list`,
        { fix: "cd into the app's directory and run this again, or add --app <id>" },
      );
    }
    // `unset` takes a name the manifest no longer lists: it may still be set.
    if (action === "unset") continue;
    throw new FakeError(
      "SECRET_NOT_DECLARED",
      [
        `${app.id} doesn't list ${name} as a secret`,
        registry
          ? `Its deployed manifest (what --app ${app.id} reads) doesn't list it, and it isn't a Gateway setting either.`
          : INSTALL_OWNED.includes(name)
            ? `It's one of the Gateway's own keys; listing it under secrets gives ${app.id} a secret of its own.`
            : "It isn't a Gateway setting either.",
      ].join("\n"),
      {
        fix: `add it to secrets in everyapp.config.ts: secrets: ${JSON.stringify([...declared, name]).replaceAll(",", ", ")},${registry ? ` and deploy ${app.id} again` : ""}`,
        rerun: `${CLI} secret set ${name}${appFlag}`,
      },
    );
  }
  return { gateway, app, appNames: rest };
}

/** The app the registry knows by this id (its `status` row), from the state; null when there's none. */
function appById(state, id) {
  return state.apps.find((candidate) => candidate.id === id) ?? null;
}

// ---------------------------------------------------------------- the settings model (lib/app/settings.ts, over the SDK's appSettings)

/**
 * The manifest's settings against what is set, as appSetupFrom does it:
 * the Gateway's names, and the app Worker's own (`secretsSet`; null before
 * its first deploy, which reads as unknown and never blocks). The report
 * is the SDK's (every setting with `set` and `blocking`, the any-of
 * groups, `unmet`); `setup` the AppSetup every surface returns.
 */
function appSetupFrom(state, app) {
  const gatewayNames = gatewayNamesOf(state);
  const own = app.deployed === false ? null : (app.secretsSet ?? []);
  const report = sdk.evaluateAppSettings(sdk.appSettings(app.manifest ?? {}), (holder, name) =>
    holder === "gateway" ? gatewayNames.includes(name) : own === null ? null : own.includes(name),
  );
  return { report, setup: sdk.appSetupOf(report, { cli: CLI, appId: app.id }) };
}

/** Whether the manifest declares anything to set (a capability with no setting doesn't count). */
function declaresSettings(manifest) {
  return sdk.appSettings(manifest ?? {}).some((setting) => setting.names.length > 0);
}

/** Every Gateway name the manifest reads: each setting's names and what it also reads when set. */
function gatewayNamesRead(manifest) {
  const names = new Set();
  for (const setting of sdk.appSettings(manifest)) {
    if (setting.holder !== "gateway") continue;
    for (const name of [...setting.names, ...setting.alsoReads]) names.add(name);
  }
  return [...names];
}

/** `data.gateway.needed`: each Gateway name once, in manifest order, `required` unless only optional settings read it, `set` whether the Gateway holds it. */
function gatewayNeeds(settings, gatewayNames) {
  const needs = new Map();
  const add = (name, required) => {
    const need = needs.get(name);
    if (need) need.required ||= required;
    else needs.set(name, { name, required, set: gatewayNames.includes(name) });
  };
  for (const setting of settings) {
    if (setting.holder !== "gateway") continue;
    for (const name of setting.names) add(name, setting.need.kind !== "optional");
    for (const name of setting.alsoReads) add(name, false);
  }
  return [...needs.values()];
}

/** `data.gateway.missing`: the unset Gateway names that keep the app from opening. */
function gatewayMissing(settings, gatewayNames) {
  return settings
    .filter((setting) => setting.holder === "gateway" && setting.blocking)
    .flatMap((setting) => setting.names)
    .filter((name, index, names) => !gatewayNames.includes(name) && names.indexOf(name) === index);
}

/** A setting's state in the real CLI's words (settingStatus), without its colors. */
function settingStatus(setting) {
  if (setting.set === true) return "✓ set";
  if (setting.set === null) return setting.holder === "app" ? "! not recorded" : "! couldn't check";
  switch (setting.need.kind) {
    case "required":
      return "! not set";
    case "optional":
      return "not set (optional)";
    default:
      return setting.blocking ? "! not set" : `not set (one of: ${setting.need.group})`;
  }
}

/** The rows of one app's settings, in manifest order (settingsRows): APP, SETTING (names joined with +), WHERE, STATUS. */
function settingsRows(appId, settings) {
  return settings
    .filter((setting) => setting.names.length > 0)
    .map((setting) => [appId, setting.names.join("+"), setting.holder === "gateway" ? "Gateway" : appId, settingStatus(setting)]);
}

/**
 * Each unmet setting for whoever sets it (describeUnmetSettings): "<label>:
 * <why>" (the names when there is no why and the label doesn't name them),
 * "Get it at <docs>", and under the first that has one, its guide
 * ("Guide: .claude/skills/everyapp/setup/dataforseo.md"), once per guide.
 */
function describeUnmetSettings(unmet) {
  const guides = new Set();
  return unmet.flatMap((setting) => {
    const names = setting.names.join(" and ");
    const what = setting.why ?? (setting.label === names ? undefined : names);
    const lines = [what ? `${setting.label}: ${what}` : setting.label, ...(setting.docs ? [`Get it at ${setting.docs}`] : [])];
    if (!setting.setup || guides.has(setting.setup)) return lines;
    guides.add(setting.setup);
    return [...lines, `Guide: ${SKILL_DIR}/${setting.setup}`];
  });
}

/**
 * `status` for a person, as commands/status/render.ts draws it: the facts,
 * the apps table, their settings table, then each problem as a block (its
 * headline, the detail lines, the command to run) with the glyphs and
 * without the colors.
 */
function renderStatus(state, apps, access, domains, fixes) {
  const owner = state.claimed ? state.owner : null;
  const facts = [
    ["Gateway", `${state.gatewayUrl} · self-hosted`],
    ["Cloudflare", state.accountName],
    ["Owner", owner ? `${owner.email}${owner.organizationName ? ` · ${owner.organizationName}` : ""}` : "none yet"],
    ["Access", access.on ? "on · everyone signs in through Cloudflare Access first" : `off · ${CLI} access on puts Cloudflare Access in front (recommended)`],
    ["Release", "0.2.0 · matches this checkout"],
    ["TLS", `ready on ${domains.length} hostname${domains.length === 1 ? "" : "s"}`],
  ];
  const labels = Math.max(...facts.map(([label]) => label.length));
  const needsSetup = (app) => app.bound && app.status === "active" && app.setup !== null && !app.setup.ready;
  const cell = (app) => (app.status === "pending" ? "! never deployed" : needsSetup(app) ? "! needs setup" : "✓ live");
  const settings = apps.flatMap((app) => (app.setup ? settingsRows(app.id, app.setup.settings) : []));
  const glyph = { error: "✗", warning: "!", info: "i" };
  return [
    ...facts.map(([label, value]) => `${label.padEnd(labels)}  ${value}`),
    "",
    ...(apps.length
      ? table(["APP", "STATUS", "URL", "DEPLOYED BY", "PUBLIC"], apps.map((app) => [app.id, cell(app), `https://${app.hostname}`, app.deployedBy ?? "", ""]))
      : [`No apps yet. Deploy one from its directory: ${CLI} deploy`]),
    ...(settings.length ? ["", ...table(["APP", "SETTING", "WHERE", "STATUS"], settings)] : []),
    ...(fixes.length ? [""] : []),
    ...fixes.flatMap((fix) => {
      const [headline, ...detail] = fix.message.split("\n");
      return [
        `${glyph[fix.severity] ?? "!"} ${headline}`,
        ...detail.map((line) => `  ${line}`),
        ...(fix.fix ? [`  Fix: ${fix.fix}`] : []),
        ...(fix.run ? [`  Run: ${fix.run}${fix.note ? `  ${fix.note}` : ""}`] : []),
      ];
    }),
  ].join("\n");
}

/** The app whose everyapp.config.ts is in the working directory, from the state; null elsewhere. */
function appHere(state, required = false) {
  const file = path.join(cwd, "everyapp.config.ts");
  if (!fs.existsSync(file)) {
    if (required) {
      throw new FakeError("MANIFEST_NOT_FOUND", "No everyapp.config.ts in this directory", { fix: "run it in the app's directory, or pass --manifest <path>" });
    }
    return null;
  }
  const id = /\bid:\s*["']([^"']+)["']/.exec(fs.readFileSync(file, "utf8"))?.[1];
  const app = state.apps.find((candidate) => candidate.id === id);
  if (!app) {
    throw new FakeError("APP_NOT_FOUND", `${id ?? "this app"} isn't deployed yet\nIts secrets can be set after its first deploy. Nothing was changed.`, { rerun: `${CLI} deploy` });
  }
  return app;
}

function closeName(name, known) {
  const fold = (value) => value.toUpperCase().replace(/_/g, "");
  return known.find((candidate) => candidate !== name && fold(candidate) === fold(name));
}

function gatewayNamesOf(state) {
  const installed = state.installed ? INSTALL_OWNED : [];
  return [...new Set([...installed, ...(state.gatewayNames ?? [])])].sort();
}

function workerNameOf(state, app) {
  return `every-${(state.owner?.slug ?? "owner")}-${app.id}`;
}

function gatewayHost(state) {
  return (state.gatewayUrl ?? "https://gateway.invalid").replace(/^https?:\/\//, "");
}

function nextVersion(versionId) {
  const n = Number.parseInt(String(versionId ?? "").slice(-12), 10) || 0;
  return `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
}

// ---------------------------------------------------------------- argument errors (stricli's shapes)

function unknownCommand(pathSoFar, input, names) {
  const match = closeTo(input, names);
  const problem = {
    code: "UNKNOWN_COMMAND",
    message: [
      `Unknown command ${[...pathSoFar, input].join(" ")}`,
      ...(pathSoFar.length ? [`${pathSoFar.join(" ")} has ${listed(names.filter((n) => n !== "ls"))}.`] : []),
    ].join("\n"),
    data: { ...(match ? { didYouMean: [CLI, ...pathSoFar, match].join(" ") } : {}), help: [CLI, ...pathSoFar, "--help"].join(" ") },
  };
  out.emit({ type: "error", retryable: false, ...problem });
  return 251;
}

function missingArgument(command) {
  out.emit({
    type: "error",
    code: "MISSING_ARGUMENT",
    message: command === "email unset" ? "Name at least one list to clear: senders or inbound" : "Name at least one secret or Gateway setting",
    retryable: false,
    data: { usage: `${CLI} ${command} ${command === "email unset" ? "<senders|inbound>..." : "<name>..."} [flags]` },
  });
  return 252;
}

function closeTo(input, candidates) {
  let best;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// ---------------------------------------------------------------- output

/** NDJSON on stdout with --json; a person's rendering otherwise (problems on stderr). */
function sink(ndjson) {
  const emit = (event) => {
    if (ndjson) {
      const { display: _display, ...line } = event;
      process.stdout.write(`${JSON.stringify({ v: 1, ts: new Date().toISOString(), ...line })}\n`);
      return;
    }
    switch (event.type) {
      case "step":
        if (event.status === "ok" && event.message) process.stdout.write(`${event.message} ✓\n`);
        else if (event.status === "skip" && event.message) process.stdout.write(`${event.message}\n`);
        return;
      case "progress":
        return;
      case "warning":
        process.stderr.write(`! ${event.message}\n`);
        return;
      case "action_required":
        process.stdout.write(`→ ${event.message.split("\n")[0]}\n${event.data?.url ? `  ${event.data.url}\n` : ""}${event.data?.rerun ? `  Run: ${event.data.rerun}\n` : ""}`);
        return;
      case "error":
        process.stderr.write(`✗ ${event.message}\n${event.data?.fix ? `  ${event.data.fix}\n` : ""}${event.data?.rerun ? `  Run: ${event.data.rerun}\n` : ""}${event.data?.help ? `  Run: ${event.data.help}\n` : ""}`);
        return;
      case "done": {
        // `display` is drawn for a person (the real sink never puts it in --json); `message` otherwise.
        const shown = event.display ?? event.message;
        if (shown) process.stdout.write(`${shown}\n`);
        return;
      }
    }
  };
  return {
    emit,
    error(error) {
      emit({
        type: "error",
        code: error.code,
        message: error.message,
        retryable: false,
        data: {
          ...(error.fix ? { fix: error.fix } : {}),
          ...(error.rerun ? { rerun: error.rerun } : {}),
          ...(error.rerunNote ? { rerunNote: error.rerunNote } : {}),
          ...(error.authorize ? { authorize: true } : {}),
          ...(error.data ?? {}),
        },
      });
    },
  };
}

function helpText(key) {
  const file = path.join(here, "help", "everyapp-help.txt");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const sections = new Map();
  const parts = text.split(/^===== (.*)\n/m);
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i].trim(), parts[i + 1]);
  if (key === "access") {
    return [
      "Put Cloudflare Access in front of the Gateway and its apps.",
      "",
      "USAGE",
      "  everyapp access <command> [flags]",
      "",
      "COMMANDS",
      "  on    Put the Gateway and its apps behind Cloudflare Access, or bring them up to date",
      "  off   Take the Gateway and its apps out from behind Cloudflare Access",
      "  show  Show how Cloudflare Access fronts the Gateway, and what access on would change",
      "",
      "EXAMPLES",
      "  $ everyapp access on",
      "  $ everyapp access on --email-domain example.com",
      "  $ everyapp access off",
      "",
      "Run everyapp access <command> --help for its flags.",
      "",
    ].join("\n");
  }
  if (key === "access on") {
    return [
      "USAGE",
      "  everyapp access on [--team name] [--email address]... [--email-domain domain]... [--session duration] [--write-settings] [--gateway value] [--account-id value] [--json] [--verbose]",
      "  everyapp access on --help",
      "",
      "Finds or creates the Zero Trust team (--team when the account has none; the name is permanent),",
      "adds the one-time PIN when the team has no other identity provider, keeps the reusable policy",
      '"Every App gateway members" (every member and pending invitee, plus --email and --email-domain),',
      "creates or updates the two Access applications (the Gateway's host and *.<app base domain>), and",
      "sets CLOUDFLARE_ACCESS_TEAM_DOMAIN, CLOUDFLARE_ACCESS_AUD and CLOUDFLARE_ACCESS_APPS_AUD on the",
      "Gateway in one version. Run it again any time; it changes only what differs.",
      "",
      "FLAGS",
      "     [--team]                  The Zero Trust team's name (<name>.cloudflareaccess.com), when the account has none yet",
      "     [--email]...              Also let this address in",
      "     [--email-domain]...       Also let every address at this domain in",
      "     [--session]               The Access session's length, e.g. 24h (default: 720h)",
      "     [--json/--no-json]        Print NDJSON events on stdout and never prompt (exit 0 done, 1 error, 2 action required, 251/252 bad command or arguments)",
      "     [--verbose/--no-verbose]  Show every step and progress line",
      "  -h  --help                   Print help information and exit",
      "",
    ].join("\n");
  }
  if (key === "access off") {
    return ["USAGE", "  everyapp access off [--yes] [--keep-applications] [--json] [--verbose]", "", "Removes the three Gateway settings, then deletes the two Access applications. Asks first; --yes doesn't.", ""].join("\n");
  }
  if (key === "access show") {
    return ["USAGE", "  everyapp access show [--json] [--verbose]", "", "Reports whether Cloudflare Access fronts the Gateway, and what access on would change.", ""].join("\n");
  }
  if (sections.has(key)) return sections.get(key);
  return ["USAGE", `  everyapp ${key} [--json] [--verbose]`, `  everyapp ${key} --help`, "", `(fake everyapp: no captured help text for "${key}")`, ""].join("\n");
}

// ---------------------------------------------------------------- helpers

function parseArgs(args) {
  const flags = new Set();
  const values = new Map();
  const lists = new Map();
  const positional = [];
  let escaped = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (escaped || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      escaped = true;
      continue;
    }
    const [raw, inline] = arg.replace(/^--?/, "").split(/=(.*)/s);
    const name = raw.replace(/^no-/, "");
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? args[++i];
      flags.add(name);
      values.set(name, value);
      lists.set(name, [...(lists.get(name) ?? []), value]);
    } else {
      flags.add(raw);
    }
  }
  return { flags, values, lists, positional };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    throw new FakeError("FAKE_STATE_UNREADABLE", `fake everyapp can't read ${stateFile}: ${error.message}`);
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** Everything piped on stdin, once; "" when nothing comes within a moment. */
function readStdin() {
  if (stdinText !== undefined) return Promise.resolve(stdinText);
  return new Promise((resolve) => {
    let text = "";
    const finish = () => {
      stdinText = text;
      resolve(text);
    };
    const timer = setTimeout(() => {
      // An open stdin nobody writes to (a tool that keeps it open): no value.
      process.stdin.removeAllListeners();
      finish();
    }, 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function listed(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** The SDK's registry, from the checkout this file lives in (built by `pnpm install`). */
async function loadSdk() {
  const candidates = [
    path.join(here, "..", "..", "node_modules", "@every-app", "sdk", "dist", "internal", "index.js"),
    path.join(here, "..", "..", "..", "sdk", "dist", "internal", "index.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return import(candidate);
  }
  process.stderr.write("fake everyapp: the SDK isn't built (pnpm -C packages/sdk build)\n");
  process.exit(70);
}
