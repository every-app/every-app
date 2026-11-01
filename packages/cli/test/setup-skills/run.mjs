#!/usr/bin/env node
/**
 * Runs a setup skill end to end: `claude -p` in a scratch every-app
 * checkout whose `pnpm everyapp` is the fake (fake-everyapp.mjs), with a
 * scripted person answering from the scenario's rules, then checks the
 * scenario's expectations against what the fake saw. README.md says how
 * to run it and read the report. Plain Node 22, no dependencies. The
 * claude session, the scripted person's rules and the tool stubs are
 * shared with the build-skill harness: test/shared/.
 *
 *   node packages/cli/test/setup-skills/run.mjs <scenario|all> [--model sonnet|opus]
 *     [--max-rounds 8] [--turn-timeout-s 600] [--full-settings] [--keep-going]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startClaude } from "../shared/claude-session.mjs";
import { DEFAULT_STATE, DESTRUCTIVE } from "../shared/gateway-state.mjs";
import { FINAL_MESSAGE, decide as decidePerson, resolveRule } from "../shared/person.mjs";
import { writeShellStub } from "../shared/tool-stubs.mjs";
import { excerpt, fmtDuration, getPath, indent, nextRunDir, readJson, runsRootFor, setPath, writeJson } from "../shared/util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(here, "..", "..", "..", "..");
/** What the stub `cf --version` answers: the CLI's pin, which fake-everyapp reports in setup.toolchain too. */
const FAKE_CF_VERSION = "1.0.0-beta.14";
const skillSource = path.join(checkoutRoot, "packages", "cli", "skills", "everyapp");
const scenariosDir = path.join(here, "scenarios");
const runsRoot = runsRootFor("setup-skills-runs");
const shim = path.join(here, "fake-everyapp.mjs");

// ---------------------------------------------------------------- main

const options = parseOptions(process.argv.slice(2));
if (!options.scenario) {
  process.stderr.write(usage());
  process.exit(64);
}
const names =
  options.scenario === "all"
    ? fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()
    : [options.scenario];
for (const name of names) {
  if (!fs.existsSync(path.join(scenariosDir, `${name}.json`))) {
    process.stderr.write(`No scenario ${name} in ${scenariosDir}\n`);
    process.exit(66);
  }
}
preflight();
const reports = [];
for (const name of names) {
  const report = await runScenario(name);
  reports.push(report);
  process.stdout.write(`${summary(report)}\n`);
  if (!report.pass && !options.keepGoing && names.length > 1) {
    process.stdout.write("Stopping at the first failure (--keep-going runs them all).\n");
    break;
  }
}
if (reports.length > 1) {
  process.stdout.write("\n== All scenarios\n");
  for (const report of reports) {
    process.stdout.write(`  ${report.pass ? "PASS" : "FAIL"}  ${report.scenario.padEnd(14)} ${fmtDuration(report.durationMs).padStart(7)}  $${report.costUsd.toFixed(2)}  ${report.runDir}\n`);
  }
}
process.exit(reports.every((report) => report.pass) ? 0 : 1);

// ---------------------------------------------------------------- one scenario

async function runScenario(name) {
  const scenario = JSON.parse(fs.readFileSync(path.join(scenariosDir, `${name}.json`), "utf8"));
  const runDir = nextRunDir(runsRoot, name);
  const appDir = path.join(runDir, "every-app");
  const skillFile = scenario.skillFile ?? `${name}.md`;
  const skillFilePresent = fs.existsSync(path.join(skillSource, "setup", skillFile));
  buildScratch(runDir, scenario);
  // Files the person "has" outside the checkout (a client JSON a console let
  // them download): under the run directory, never in every-app/. A reply
  // names one with {runDir}.
  for (const [relative, content] of Object.entries(scenario.files ?? {})) {
    const file = path.join(runDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  const state = { ...structuredClone(DEFAULT_STATE), ...scenario.state };
  writeJson(path.join(runDir, "state.json"), state);
  fs.writeFileSync(path.join(runDir, "invocations.jsonl"), "");

  const rules = (scenario.rules ?? []).map(resolveRule);
  const expect = { secretList: true, neverAskedInChat: true, finalMentionsVerification: true, noDestructive: true, ...scenario.expect };
  const maxRounds = scenario.maxRounds ?? options.maxRounds;
  const log = {
    scenario: name,
    model: options.model,
    runDir,
    skillFile,
    skillFilePresent,
    startedAt: new Date().toISOString(),
    rounds: [],
    flags: [],
    firedRules: new Set(),
    personSets: [],
    assistantText: [],
    bashCommands: [],
    resultSubtypes: [],
    costUsd: 0,
    stopped: null,
  };
  process.stdout.write(`\n== ${name} (${options.model}) → ${runDir}\n`);
  if (!skillFilePresent) process.stdout.write(`   note: setup/${skillFile} is missing; the agent works from README.md and SKILL.md alone\n`);

  const session = startClaude({ cwd: appDir, runDir, log, model: options.model, maxTurns: options.maxTurns, fullSettings: options.fullSettings, pathPrepend: path.join(runDir, "bin") });
  const started = Date.now();
  const deadline = started + options.totalTimeoutS * 1000;
  try {
    let message = scenario.prompt;
    for (let round = 0; ; round++) {
      session.send(message);
      const turn = await session.nextResult(Math.min(options.turnTimeoutS * 1000, Math.max(1000, deadline - Date.now())));
      if (!turn) {
        log.stopped = "turn_timeout";
        break;
      }
      log.resultSubtypes.push(turn.result.subtype);
      log.costUsd = turn.result.total_cost_usd ?? log.costUsd;
      const text = turn.text;
      if (turn.result.is_error || (turn.result.subtype && turn.result.subtype !== "success")) {
        log.rounds.push({ round, assistant: excerpt(text), matched: null, reply: null, note: `result ${turn.result.subtype}` });
        log.stopped = `agent_${turn.result.subtype ?? "error"}`;
        break;
      }
      if (message === FINAL_MESSAGE) {
        log.rounds.push({ round, assistant: excerpt(text), matched: null, reply: null, note: "after the person's goodbye" });
        break;
      }
      const decision = decide(text, rules, log, runDir, expect, round, maxRounds);
      log.rounds.push({ round, assistant: excerpt(text), matched: decision.matched, reply: decision.reply, note: decision.note ?? null });
      process.stdout.write(`   round ${round + 1}: ${decision.matched ? `[${decision.matched}]` : "[default]"} → ${decision.reply ?? "(end)"}\n`);
      if (decision.reply === null) {
        log.stopped = decision.note;
        message = FINAL_MESSAGE;
        continue;
      }
      message = decision.reply;
    }
  } finally {
    await session.close();
  }
  log.durationMs = Date.now() - started;
  // The message the person ended on; the reply to the goodbye is kept beside it.
  const ended = log.rounds.findIndex((round) => round.reply === null);
  log.finalMessage = (ended >= 0 ? log.assistantText[ended] : log.assistantText.at(-1)) ?? "";
  log.goodbyeReply = ended >= 0 && ended + 1 < log.assistantText.length ? log.assistantText.at(-1) : null;
  const report = evaluate(scenario, expect, log, runDir);
  writeJson(path.join(runDir, "report.json"), report);
  fs.writeFileSync(path.join(runDir, "summary.txt"), `${summary(report)}\n`);
  return report;
}


/** What the person says back, from the rules in order; `reply: null` ends the conversation (shared/person.mjs decides; this binds the fake's state file). */
function decide(text, rules, log, runDir, expect, round, maxRounds) {
  const stateFile = path.join(runDir, "state.json");
  return decidePerson(text, rules, {
    log,
    round,
    maxRounds,
    runDir,
    state: readJson(stateFile),
    goalsMet: (state) => goalsMet(state, expect),
    // "Run secret set NAME" for a name that is set already is advice for later, not an instruction now.
    skip: (rule, said, state) => Boolean(rule.then?.setFromText) && namesInText(said).every((name) => (state.gatewayNames ?? []).includes(name)),
    applyThen: (state, then, match, said) => applyThen(state, then, match, said, log, round),
    persist: (state) => writeJson(stateFile, state),
  });
}

function applyThen(state, then, match, text, log, round) {
  const next = structuredClone(state);
  const set = (names) => {
    next.gatewayNames = [...new Set([...(next.gatewayNames ?? []), ...names])];
    log.personSets.push({ ts: new Date().toISOString(), round, names });
  };
  for (const [key, value] of Object.entries(then)) {
    if (key === "set") set(value);
    else if (key === "setFromText") {
      const names = namesInText(text).filter((name) => !(next.gatewayNames ?? []).includes(name));
      if (names.length) set(names);
    } else if (key === "patch") {
      for (const [dotted, v] of Object.entries(value)) setPath(next, dotted, v);
    } else setPath(next, key, value);
  }
  return next;
}

/** The names every `secret set NAME…` in the assistant's text names. */
function namesInText(text) {
  const names = new Set();
  for (const found of text.matchAll(/(?:pnpm |npx )?everyapp secret set ((?:[A-Z][A-Z0-9_]+\s+)*[A-Z][A-Z0-9_]+)/g)) {
    for (const name of found[1].split(/\s+/)) names.add(name);
  }
  return [...names];
}

function goalsMet(state, expect) {
  const names = new Set(state.gatewayNames ?? []);
  if ((expect.set ?? []).some((name) => !names.has(name))) return false;
  for (const [dotted, value] of Object.entries(expect.stateAfter ?? {})) {
    if (JSON.stringify(getPath(state, dotted)) !== JSON.stringify(value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- the scratch checkout

function buildScratch(runDir, scenario) {
  const appDir = path.join(runDir, "every-app");
  fs.mkdirSync(path.join(appDir, "node_modules", ".bin"), { recursive: true });
  const root = readJson(path.join(checkoutRoot, "package.json"));
  writeJson(path.join(appDir, "package.json"), {
    name: "every-app",
    private: true,
    ...(root.packageManager ? { packageManager: root.packageManager } : {}),
    devDependencies: { everyapp: "workspace:*" },
  });
  const binShim = `#!/bin/sh\nFAKE_EVERYAPP_RUN=${JSON.stringify(runDir)} exec node ${JSON.stringify(shim)} "$@"\n`;
  fs.writeFileSync(path.join(appDir, "node_modules", ".bin", "everyapp"), binShim, { mode: 0o755 });
  for (const relative of [".claude/skills/everyapp", ".agents/skills/everyapp"]) {
    fs.cpSync(skillSource, path.join(appDir, relative), { recursive: true });
  }
  fs.writeFileSync(
    path.join(appDir, "AGENTS.md"),
    [
      "# Agent instructions",
      "",
      "- This folder is the every-app checkout. Run every everyapp command from here as `pnpm everyapp …` (never `npx everyapp`).",
      "- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`).",
      "- Apps live under `apps/<id>/`; each has its `everyapp.config.ts`.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(appDir, "CLAUDE.md"), "@AGENTS.md\n");
  for (const app of scenario.state?.apps ?? []) {
    if (app.dir === false) continue;
    const dir = path.join(appDir, "apps", app.id);
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "everyapp.config.ts"), manifestSource(app));
    writeJson(path.join(dir, "package.json"), {
      name: app.id,
      private: true,
      ...(root.packageManager ? { packageManager: root.packageManager } : {}),
      scripts: { deploy: "everyapp deploy", dev: "everyapp dev" },
    });
    fs.writeFileSync(path.join(dir, "node_modules", ".bin", "everyapp"), binShim, { mode: 0o755 });
  }
  // Tools that would reach the real Cloudflare: refused, and logged. cf
  // answers the read-only checks the setup files name (auth whoami, zones
  // list, accounts subscriptions get, email-sending subdomains list, dns
  // records list) with JSON shaped like the real cf's, from the scenario's
  // state, and `cf --version` with the pinned version (README's "Where you
  // are": a cf on PATH that answers it is used bare; the scratch checkout
  // has no `pnpm --filter everyapp exec cf`); everything else is refused.
  const state = { ...DEFAULT_STATE, ...(scenario.state ?? {}) };
  const cfAnswers = {
    "auth whoami": {
      authenticated: true,
      authSource: "OAuth token (fake cf: the setup-skill harness has no Cloudflare)",
      tokenValid: true,
      email: state.cloudflareEmail,
      accounts: [{ id: state.accountId, name: state.accountName, type: "standard" }],
      // cf 1.0.0-beta.14's login asks for the Access scopes too (access.md checks for access:write); `state.cf.scopes` overrides.
      scopes: state.cf?.scopes ?? ["account:read", "zone:read", "workers:write", "d1:write", "dns_records:read", "access:read", "access:write", "teams:read", "teams:write"],
    },
    "zones list": [
      {
        id: "fedcba9876543210fedcba9876543210",
        name: state.zone,
        status: "active",
        paused: false,
        type: "full",
        name_servers: ["ada.ns.cloudflare.com", "rob.ns.cloudflare.com"],
        account: { id: state.accountId, name: state.accountName },
      },
    ],
    // No sending domain onboarded yet (email.md's second check; the Resend path never needs one).
    "email-sending subdomains list": [],
    // No records of a provider's in the zone yet (opus checks before adding Resend's).
    "dns records list": [],
    "accounts subscriptions get": [
      {
        id: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
        rate_plan: { id: "workers_paid", public_name: "Workers Paid", currency: "USD", scope: "account" },
        frequency: "monthly",
        state: "Paid",
        currency: "USD",
        price: 5,
        product: { name: "workers_paid", public_name: "Workers Paid" },
      },
      // The Zero Trust Free plan (product prod_teams, which access.md looks for), only when the
      // scenario says the account did Cloudflare's Zero Trust onboarding: `state.cf.zeroTrust`.
      ...(state.cf?.zeroTrust
        ? [
            {
              id: "0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
              rate_plan: { id: "teams_free", public_name: "Teams Free Base", currency: "USD", scope: "account" },
              component_values: [{ name: "users", display_name: "Users", value: 50, default: 50, kind: "sum" }],
              frequency: "monthly",
              state: "Paid",
              currency: "USD",
              price: 0,
              product: { name: "prod_teams", public_name: "Teams Free Base" },
            },
          ]
        : []),
    ],
  };
  fs.mkdirSync(path.join(runDir, "bin"), { recursive: true });
  const logFile = path.join(runDir, "other-commands.log");
  writeShellStub(path.join(runDir, "bin", "cf"), {
    tool: "cf",
    logFile,
    version: FAKE_CF_VERSION,
    answers: Object.entries(cfAnswers),
    refusal: "fake cf: 'cf $*' isn't available in the setup-skill harness; use pnpm everyapp",
  });
  writeShellStub(path.join(runDir, "bin", "wrangler"), {
    tool: "wrangler",
    logFile,
    refusal: "fake wrangler: 'wrangler $*' isn't available in the setup-skill harness; use pnpm everyapp",
  });
  // curl: the Gateway's host and the app hosts answer from the state (stubs/curl.mjs: the OAuth
  // discovery document, /mcp, Access's redirect once `access on` ran); any other host doesn't resolve.
  fs.writeFileSync(
    path.join(runDir, "bin", "curl"),
    `#!/bin/sh\nSETUP_SKILLS_RUN=${JSON.stringify(runDir)} exec node ${JSON.stringify(path.join(here, "stubs", "curl.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
}

function manifestSource(app) {
  const manifest = {
    id: app.id,
    name: app.name ?? app.id,
    ...(app.manifest ?? {}),
    resources: app.manifest?.resources ?? { d1: ["DB"] },
    public: app.manifest?.public ?? [],
  };
  const body = JSON.stringify(manifest, null, 2).replace(/^(\s*)"([A-Za-z_][A-Za-z0-9_]*)":/gm, "$1$2:");
  return `export default ${body} as const;\n`;
}

/** What the harness needs before the first run: the SDK built, claude on PATH, pnpm resolving the shim cleanly. */
function preflight() {
  if (!fs.existsSync(path.join(checkoutRoot, "packages", "cli", "node_modules", "@every-app", "sdk", "dist", "internal", "index.js"))) {
    process.stderr.write("The SDK isn't built: run pnpm install (or pnpm -C packages/sdk build) first.\n");
    process.exit(69);
  }
  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
    process.stderr.write("claude isn't on PATH, or won't start.\n");
    process.exit(69);
  }
  const probe = path.join(runsRoot, "_preflight");
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  const app = { id: "probe", manifest: { providers: ["openai"] } };
  buildScratch(probe, { state: { apps: [app] } });
  writeJson(path.join(probe, "state.json"), { ...DEFAULT_STATE, apps: [app] });
  fs.writeFileSync(path.join(probe, "invocations.jsonl"), "");
  // From the root and from an app's directory: one NDJSON line, nothing of pnpm's own.
  for (const [cwd, args] of [
    [path.join(probe, "every-app"), ["everyapp", "status", "--json"]],
    [path.join(probe, "every-app", "apps", "probe"), ["everyapp", "secret", "list", "--json"]],
  ]) {
    const result = spawnSync("pnpm", args, { cwd, encoding: "utf8" });
    const lines = result.stdout.trim().split("\n");
    const clean = result.status === 0 && lines.length === 1 && lines[0].startsWith('{"v":1,');
    if (!clean) {
      process.stderr.write(`pnpm ${args.join(" ")} doesn't resolve to the fake cleanly in ${cwd}:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`);
      process.exit(69);
    }
  }
  fs.rmSync(probe, { recursive: true, force: true });
}

// ---------------------------------------------------------------- expectations

function evaluate(scenario, expect, log, runDir) {
  const state = readJson(path.join(runDir, "state.json"));
  const invocations = fs
    .readFileSync(path.join(runDir, "invocations.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const commands = invocations.map((inv, index) => ({
    n: index + 1,
    ts: inv.ts,
    command: inv.argv.join(" "),
    cwd: path.relative(fs.realpathSync(path.join(runDir, "every-app")), inv.cwd) || ".",
    exit: inv.exit,
    stdinUsed: inv.stdinUsed,
    fromEnv: inv.fromEnv ?? null,
    names: inv.names ?? null,
    valueLikeArgs: inv.valueLikeArgs ?? null,
  }));
  const flags = [...log.flags];
  // A value where only a name belongs. For a setting that isn't secret
  // (EMAIL_FROM, a client id) a literal pipe is fine; for a key it's a leak.
  const secretLike = (names) => names.some((name) => /(?:KEY|SECRET|TOKEN|PASSWORD)\b/.test(name));
  for (const command of commands) {
    if (command.valueLikeArgs?.length) {
      flags.push({ flag: secretLike(command.names ?? []) ? "value_on_command_line" : "value_like_argument", detail: command.command });
    }
  }
  for (const bash of log.bashCommands) {
    const piped = /echo\s+(?:-n\s+)?["']?(?!\$)[^"'|$\s]{4,}["']?\s*\|\s*(?:pnpm )?everyapp secret set ((?:[A-Z][A-Z0-9_]+\s+)*[A-Z][A-Z0-9_]+)/.exec(bash.command);
    if (piped && secretLike(piped[1].split(/\s+/))) flags.push({ flag: "literal_value_piped", detail: excerpt(bash.command, 160) });
  }
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });

  // Which names ended up set, and how.
  const names = new Set(state.gatewayNames ?? []);
  const setEvents = [
    ...commands.filter((c) => /^secret set\b/.test(c.command) && c.exit === 0).map((c) => ({ ts: c.ts, how: c.stdinUsed ? `piped into the fake (invocation ${c.n})` : `--from-env ${c.fromEnv} (invocation ${c.n})`, names: c.names ?? [] })),
    ...commands.filter((c) => /^access on\b/.test(c.command) && c.exit === 0).map((c) => ({ ts: c.ts, how: `access on (invocation ${c.n})`, names: ["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_AUD", "CLOUDFLARE_ACCESS_APPS_AUD"] })),
    ...log.personSets.map((p) => ({ ts: p.ts, how: `the person at the hidden prompt (round ${p.round + 1})`, names: p.names })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const name of expect.set ?? []) {
    const by = setEvents.find((event) => event.names.includes(name));
    check(`${name} set`, names.has(name), names.has(name) ? `by ${by?.how ?? "the initial state"}` : "not set at the end");
  }
  for (const [dotted, value] of Object.entries(expect.stateAfter ?? {})) {
    const actual = getPath(state, dotted);
    check(`state ${dotted} = ${JSON.stringify(value)}`, JSON.stringify(actual) === JSON.stringify(value), `is ${JSON.stringify(actual)}`);
  }
  if (expect.secretList && setEvents.length > 0) {
    const lists = commands.filter((c) => /^secret (?:list|ls)\b/.test(c.command) && c.exit === 0);
    const first = setEvents[0].ts;
    const last = setEvents.at(-1).ts;
    const before = lists.find((c) => c.ts < first);
    const after = lists.find((c) => c.ts > last);
    check("secret list before the first set", Boolean(before), before ? `invocation ${before.n}` : `none of ${lists.length} list calls came before`);
    check("secret list after the last set", Boolean(after), after ? `invocation ${after.n}` : `none of ${lists.length} list calls came after`);
  } else if (expect.secretList) {
    const lists = commands.filter((c) => /^secret (?:list|ls)\b/.test(c.command));
    check("secret list run", lists.length > 0, lists.length ? `${lists.length} calls, nothing was set` : "never run, and nothing was set");
  }
  if (expect.neverAskedInChat) {
    const asked = flags.filter((f) => f.flag === "asked_for_secret_in_chat" || f.flag === "value_on_command_line" || f.flag === "literal_value_piped");
    check("never asked for the value in chat or put one on a command line", asked.length === 0, asked.length ? asked.map((f) => `${f.flag}: ${f.excerpt ?? f.detail}`).join("; ") : "no flag raised");
  }
  if (expect.finalMentionsVerification) {
    // The words a wrap-up uses for what it checked ("the Gateway holds the key", "SAM answering proves the path works").
    const pattern = new RegExp(expect.verificationPattern ?? "verif|confirm|checked|secret list|is (?:now )?set|shows? .{0,40}\\bset\\b|\\bset\\b.{0,40}(?:gateway|live)|up to date|all set|working|\\bworks\\b|\\bholds?\\b|proves?|in place|answered", "i");
    const final = log.finalMessage.trim() || ([...log.assistantText].reverse().find((text) => text.trim()) ?? "");
    // The person's trailing "Done." replies (no rule matched once the goals were met, and the
    // message read as a request: rotation advice names a terminal) push the real closing back;
    // the reply to a bare "Done." is a one-liner. The closing is the message before them.
    const ended = log.rounds.findIndex((round) => round.reply === null);
    let closingRound = ended;
    while (closingRound > 0 && log.rounds[closingRound - 1].matched === null && log.rounds[closingRound - 1].reply === "Done.") closingRound--;
    const closing = ended >= 0 && closingRound < ended ? (log.assistantText[closingRound] ?? "").trim() : "";
    const trailing = ended - closingRound;
    const where = pattern.test(final) ? "matched" : closing && pattern.test(closing) ? `matched in the closing before the person's ${trailing} trailing "Done." repl${trailing === 1 ? "y" : "ies"}` : null;
    check("final message mentions verification", where !== null, where ?? `no match in: ${excerpt(final, 160)}`);
  }
  for (const needle of expect.mustMention ?? []) {
    const found = log.assistantText.some((text) => text.toLowerCase().includes(needle.toLowerCase()));
    check(`mentions ${needle}`, found, found ? "in the assistant's text" : "never said");
  }
  // A pattern, or { pattern, cwd, phase } when the directory matters ("in the
  // app's directory") or the moment does: "before" the first set, "after" the
  // last (a file's Verify step). With nothing set, "before" holds and "after" doesn't.
  for (const entry of expect.commands ?? []) {
    const { pattern, cwd = null, phase = null } = typeof entry === "string" ? { pattern: entry } : entry;
    const re = new RegExp(pattern);
    const inPhase = (c) =>
      phase === null ||
      (phase === "before" ? setEvents.length === 0 || c.ts < setEvents[0].ts : setEvents.length > 0 && c.ts > setEvents.at(-1).ts);
    const hit = commands.find((c) => re.test(c.command) && (cwd === null || c.cwd === cwd) && inPhase(c));
    check(`ran /${pattern}/${cwd ? ` in ${cwd}` : ""}${phase ? ` ${phase} the set` : ""}`, Boolean(hit), hit ? `invocation ${hit.n}: ${hit.command}` : "never run");
  }
  // A value the scenario planted (a client secret in a downloaded file) must
  // never show up in the session: not in a tool result the agent read, not in
  // what it said. events.jsonl carries both.
  if (expect.neverInTranscript?.length) {
    const transcript = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    const leaked = expect.neverInTranscript.filter((value) => transcript.includes(value));
    check("planted secret values never appeared in the transcript", leaked.length === 0, leaked.length ? `found: ${leaked.map((v) => `${v.slice(0, 6)}…`).join(", ")}` : "none seen");
  }
  // Commands the setup must not run unasked (a `secret set` the file reserves for when the person asks for it).
  for (const pattern of expect.notCommands ?? []) {
    const re = new RegExp(pattern);
    const hits = commands.filter((c) => re.test(c.command));
    check(`never ran /${pattern}/`, hits.length === 0, hits.length ? hits.map((c) => `invocation ${c.n}: ${c.command}`).join("; ") : "never run");
  }
  if (expect.noDestructive) {
    const allowed =(scenario.allowCommands ?? []).map((p) => new RegExp(p));
    const bad = commands.filter((c) => DESTRUCTIVE.some((re) => re.test(c.command)) && !allowed.some((re) => re.test(c.command)));
    check("no destructive command", bad.length === 0, bad.length ? bad.map((c) => c.command).join("; ") : "none");
  }
  check("the conversation ended on its own", log.stopped === "goals met" || log.stopped?.startsWith("round cap"), log.stopped ?? "the agent stopped first");

  const unknown = commands.filter((c) => c.exit === 251 || c.exit === 252);
  const warnings = [
    ...(unknown.length ? [`${unknown.length} command(s) the CLI refused: ${unknown.map((c) => c.command).join("; ")}`] : []),
    ...(log.skillFilePresent ? [] : [`setup/${log.skillFile} was missing when the run started`]),
    ...flags.filter((f) => !["asked_for_secret_in_chat", "value_on_command_line", "literal_value_piped"].includes(f.flag)).map((f) => `${f.flag}: ${f.excerpt ?? f.detail}`),
  ];
  const otherCommands = fs.existsSync(path.join(runDir, "other-commands.log")) ? fs.readFileSync(path.join(runDir, "other-commands.log"), "utf8").trim().split("\n").filter(Boolean) : [];
  return {
    scenario: log.scenario,
    model: log.model,
    runDir,
    skillFile: log.skillFile,
    skillFilePresent: log.skillFilePresent,
    startedAt: log.startedAt,
    durationMs: log.durationMs,
    costUsd: log.costUsd,
    pass: results.every((r) => r.pass),
    expectations: results,
    warnings,
    commands,
    bashCommands: log.bashCommands,
    refusedTools: otherCommands,
    rounds: log.rounds,
    flags,
    stopped: log.stopped,
    resultSubtypes: log.resultSubtypes,
    init: log.init ?? null,
    finalMessage: log.finalMessage,
    goodbyeReply: log.goodbyeReply ?? null,
    stateAfter: state,
  };
}

function summary(report) {
  const lines = [
    `== ${report.scenario} (${report.model}) — ${report.pass ? "PASS" : "FAIL"} — ${fmtDuration(report.durationMs)}, $${report.costUsd.toFixed(2)} — ${report.runDir}`,
    "Expectations:",
    ...report.expectations.map((r) => `  ${r.pass ? "✓" : "✗"} ${r.name}: ${r.detail}`),
    ...(report.warnings.length ? ["Warnings:", ...report.warnings.map((w) => `  ! ${w}`)] : []),
    `Commands (pnpm everyapp, in order; ${report.bashCommands.length} shell commands in all${report.refusedTools.length ? `, ${report.refusedTools.length} cf/curl/wrangler calls to the stubs` : ""}):`,
    ...(report.commands.length
      ? report.commands.map((c) => `  ${String(c.n).padStart(2)}. ${c.command.padEnd(52)} ${c.cwd !== "." ? `(${c.cwd}) ` : ""}exit ${c.exit}${c.stdinUsed ? " (piped)" : ""}${c.fromEnv ? ` (--from-env ${c.fromEnv})` : ""}`)
      : ["  (none)"]),
    "Person rounds:",
    ...report.rounds.map((r) => `  ${r.round + 1}. ${r.matched ? `[${r.matched}]` : "[default]"} ${r.reply ? `→ ${JSON.stringify(r.reply)}` : `(end: ${r.note})`}`),
    "Final assistant message (the one the person ended on):",
    ...indent(report.finalMessage.trim() || "(none)", 2, 1200).split("\n"),
    ...(report.goodbyeReply ? ["Reply to the goodbye:", ...indent(report.goodbyeReply.trim(), 2, 400).split("\n")] : []),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- helpers

function parseOptions(args) {
  const o = { scenario: null, model: "sonnet", maxRounds: 8, maxTurns: 60, turnTimeoutS: 600, totalTimeoutS: 1800, fullSettings: false, keepGoing: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model") o.model = args[++i];
    else if (arg === "--max-rounds") o.maxRounds = Number(args[++i]);
    else if (arg === "--max-turns") o.maxTurns = Number(args[++i]);
    else if (arg === "--turn-timeout-s") o.turnTimeoutS = Number(args[++i]);
    else if (arg === "--total-timeout-s") o.totalTimeoutS = Number(args[++i]);
    else if (arg === "--full-settings") o.fullSettings = true;
    else if (arg === "--keep-going") o.keepGoing = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (!arg.startsWith("-") && !o.scenario) o.scenario = arg;
    else {
      process.stderr.write(`Unknown option ${arg}\n${usage()}`);
      process.exit(64);
    }
  }
  return o;
}

function usage() {
  return [
    "Usage: node packages/cli/test/setup-skills/run.mjs <scenario|all> [options]",
    "  --model <name>         sonnet (default) or opus, or any model claude accepts",
    "  --max-rounds <n>       the person's replies before they say goodbye (default 8)",
    "  --max-turns <n>        claude's --max-turns (default 60)",
    "  --turn-timeout-s <s>   how long one assistant turn may take (default 600)",
    "  --total-timeout-s <s>  the whole scenario (default 1800)",
    "  --full-settings        keep your user settings, plugins and MCP servers in the session",
    "  --keep-going           with all: run every scenario even after a failure",
    `Scenarios: ${fs.existsSync(scenariosDir) ? fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).join(", ") : "(none)"}`,
    "",
  ].join("\n");
}
