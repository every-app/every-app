#!/usr/bin/env node
/**
 * Runs the build-every-app skill end to end: `claude -p` in a scratch
 * every-app checkout whose apps/<id> is a fresh copy of the starter (the
 * skills in place, the starter's node_modules linked in so `pnpm test`,
 * `pnpm types:check` and `pnpm run db:generate` work, `pnpm everyapp` the
 * fake), a scripted person asking for a feature, then checks what the
 * agent did against the skill's rules: read the skill first, a table
 * through drizzle with its migration, tools with a risk, no login of the
 * app's own, no identity from a header, the app's checks green, nothing
 * deployed, a plain closing message. README.md says how to run it and
 * read the report. Plain Node 22, no dependencies; the claude session,
 * the person's rules and the tool stubs are test/shared/.
 *
 *   node packages/cli/test/build-skill/run.mjs <scenario|all> [--model sonnet|opus]
 *     [--max-rounds 6] [--turn-timeout-s 900] [--scratch-only] [--full-settings] [--keep-going]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startClaude } from "../shared/claude-session.mjs";
import { DEFAULT_STATE, DESTRUCTIVE } from "../shared/gateway-state.mjs";
import { FINAL_MESSAGE, decide, resolveRule } from "../shared/person.mjs";
import { writeShellStub } from "../shared/tool-stubs.mjs";
import { excerpt, fmtDuration, indent, nextRunDir, readJson, runsRootFor, writeJson } from "../shared/util.mjs";
import {
  AUTH_PATTERN,
  CLIENT_HEADER_PATTERN,
  LOCAL_ONLY,
  PATTERNS_FILE,
  SKILL_FILE,
  appNameFor,
  cloudflareCalls,
  describeCall,
  diffApps,
  findForbidden,
  firstRead,
  firstWrite,
  snapshotApp,
  toolsDefined,
} from "./app-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(here, "..", "..", "..", "..");
const starterDir = path.join(checkoutRoot, "starter");
const skillsDir = path.join(checkoutRoot, "packages", "cli", "skills");
const scenariosDir = path.join(here, "scenarios");
const runsRoot = runsRootFor("build-skill-runs");
/** The fake everyapp is the setup-skill harness's: it answers create, dev and deploy with a done event and does nothing. */
const shim = path.join(here, "..", "setup-skills", "fake-everyapp.mjs");
const FAKE_CF_VERSION = "1.0.0-beta.14";
/** The one cf command the stubs hand to the real cf: it writes the app's `.cloudflare/types` and touches nothing else. */
const CF_PASSTHROUGH = ["workers types"];
/** A fake-everyapp command that would have reached the Gateway or Cloudflare for real. */
const NEVER = [/^deploy\b/, /^release\b/, /^install\b/, /^update\b/, /^setup\b/, /^delete\b/, /^login\b/];
/** Files the build may touch without a warning. */
const EXPECTED_CHANGES = [/^src\//, /^drizzle\//, /^everyapp\.config\.ts$/, /^README\.md$/, /^public\//];

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
  const scenario = readJson(path.join(scenariosDir, `${name}.json`));
  const appId = scenario.app ?? name;
  const runDir = nextRunDir(runsRoot, name);
  const rootDir = path.join(runDir, "every-app");
  const appDir = path.join(rootDir, "apps", appId);
  const pristineDir = path.join(runDir, "pristine");
  const expect = {
    readSkill: true,
    readPatterns: true,
    schema: true,
    migration: true,
    tools: { min: 1 },
    noAuthCode: true,
    noClientHeaders: true,
    neverDeploy: true,
    checks: true,
    finalMentions: ["pnpm dev"],
    neverAskedInChat: true,
    noDestructive: true,
    ...scenario.expect,
  };
  const maxRounds = scenario.maxRounds ?? options.maxRounds;
  const defaultReply = scenario.defaultReply ?? "Go on.";
  const log = {
    scenario: name,
    model: options.model,
    runDir,
    appId,
    startedAt: new Date().toISOString(),
    rounds: [],
    flags: [],
    firedRules: new Set(),
    assistantText: [],
    bashCommands: [],
    toolUses: [],
    resultSubtypes: [],
    costUsd: 0,
    stopped: null,
    durationMs: 0,
    finalMessage: "",
    goodbyeReply: null,
    scratchChecks: [],
    checksAfter: [],
    routeTreeRegenerated: false,
  };
  process.stdout.write(`\n== ${name} (${options.model}) → ${runDir}\n`);

  buildScratch({ runDir, rootDir, appDir, appId, scenario });
  snapshotApp(appDir, pristineDir);
  // The scratch must pass its own checks before the agent touches it, or a
  // failure at the end says nothing about the skill.
  log.scratchChecks = runChecks(appDir, runDir, ["status", "test", "types:check", "db:generate"]);
  for (const check of log.scratchChecks) process.stdout.write(`   scratch ${check.name}: ${check.ok ? "ok" : "FAILED"} (${fmtDuration(check.ms)})\n`);
  if (log.scratchChecks.some((check) => !check.ok) || options.scratchOnly) {
    log.stopped = log.scratchChecks.some((check) => !check.ok) ? "scratch_check_failed" : "scratch_only";
    const report = evaluate(scenario, expect, log, runDir, appDir, pristineDir, { files: [], text: "" }, defaultReply);
    writeJson(path.join(runDir, "report.json"), report);
    fs.writeFileSync(path.join(runDir, "summary.txt"), `${summary(report)}\n`);
    return report;
  }

  const rules = (scenario.rules ?? []).map(resolveRule);
  const cwd = scenario.cwd === "root" ? rootDir : appDir;
  const session = startClaude({ cwd, runDir, log, model: options.model, maxTurns: options.maxTurns, fullSettings: options.fullSettings, pathPrepend: path.join(runDir, "bin") });
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
      // The wrap-up is the first message after the work was done; the closing message check reads from there.
      if (log.goalsMetRound == null && goals(appDir, pristineDir, expect).met) log.goalsMetRound = round;
      const decision = decide(text, rules, {
        log,
        round,
        maxRounds,
        runDir,
        state: {},
        goalsMet: () => goals(appDir, pristineDir, expect).met,
        defaultReply,
      });
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

  // What the agent left behind, against the pristine copy.
  snapshotApp(appDir, path.join(runDir, "after"));
  const diff = diffApps(runDir);
  fs.writeFileSync(path.join(runDir, "app.diff"), diff.text);
  // `pnpm dev` would have rewritten src/routeTree.gen.ts for a new route file; the fake
  // dev didn't, so the harness does what dev does before the checks, and says so.
  const routesChanged = diff.files.some((file) => /^src\/routes\//.test(file.path) && file.status !== "modified");
  const treeChanged = diff.files.some((file) => file.path === "src/routeTree.gen.ts");
  if (routesChanged && !treeChanged) {
    const regen = runChecks(appDir, runDir, ["routes"])[0];
    log.routeTreeRegenerated = regen.ok ? "by the harness" : `attempted by the harness, failed: ${excerpt(regen.tail, 200)}`;
  }
  log.checksAfter = runChecks(appDir, runDir, ["test", "types:check"]);
  const report = evaluate(scenario, expect, log, runDir, appDir, pristineDir, diff, defaultReply);
  writeJson(path.join(runDir, "report.json"), report);
  fs.writeFileSync(path.join(runDir, "summary.txt"), `${summary(report)}\n`);
  return report;
}

/** The scenario's file goals, read off the app as it is now: the person stops once they hold. */
function goals(appDir, pristineDir, expect) {
  const read = (dir, file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), "utf8") : null);
  const schemaChanged = read(appDir, "src/db/schema.ts") !== read(pristineDir, "src/db/schema.ts");
  const migrations = (dir) => (fs.existsSync(path.join(dir, "drizzle")) ? fs.readdirSync(path.join(dir, "drizzle")).filter((f) => f.endsWith(".sql")).sort() : []);
  const newMigrations = migrations(appDir).filter((f) => !migrations(pristineDir).includes(f));
  const before = toolsDefined(read(pristineDir, "src/tools.ts") ?? "") ?? [];
  const now = toolsDefined(read(appDir, "src/tools.ts") ?? "") ?? [];
  const added = now.filter((tool) => !before.some((old) => old.name === tool.name));
  const wanted = expect.tools?.nameMatches ? new RegExp(expect.tools.nameMatches, "i") : null;
  const matching = wanted ? added.filter((tool) => wanted.test(tool.name)) : added;
  const toolsOk = expect.tools === false || (matching.length >= (expect.tools?.min ?? 1) && added.every((tool) => tool.risk));
  const met = (!expect.schema || schemaChanged) && (!expect.migration || newMigrations.length > 0) && toolsOk;
  return { met, schemaChanged, newMigrations, toolsBefore: before, toolsNow: now, toolsAdded: added, toolsMatching: matching };
}

// ---------------------------------------------------------------- the scratch checkout

function buildScratch({ runDir, rootDir, appDir, appId, scenario }) {
  const root = readJson(path.join(checkoutRoot, "package.json"));
  const packageManager = root.packageManager ? { packageManager: root.packageManager } : {};
  const binShim = `#!/bin/sh\nFAKE_EVERYAPP_RUN=${JSON.stringify(runDir)} exec node ${JSON.stringify(shim)} "$@"\n`;
  const skills = fs.readdirSync(skillsDir).filter((name) => fs.existsSync(path.join(skillsDir, name, "SKILL.md")));

  // The checkout's root: `pnpm everyapp` resolves to the fake from here too.
  fs.mkdirSync(path.join(rootDir, "node_modules", ".bin"), { recursive: true });
  writeJson(path.join(rootDir, "package.json"), { name: "every-app", private: true, ...packageManager, devDependencies: { everyapp: "workspace:*" } });
  fs.writeFileSync(path.join(rootDir, "node_modules", ".bin", "everyapp"), binShim, { mode: 0o755 });
  fs.writeFileSync(
    path.join(rootDir, "AGENTS.md"),
    [
      "# Agent instructions",
      "",
      "- This folder is the every-app checkout. Run every everyapp command from here as `pnpm everyapp …` (never `npx everyapp`).",
      "- Before running everyapp, read the everyapp skill: `.agents/skills/everyapp/SKILL.md` (also in `.claude/skills/`).",
      "- Apps live under `apps/<id>/`; each has its `everyapp.config.ts`. To build or change one, read its `.agents/skills/build-every-app/SKILL.md`.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(rootDir, "CLAUDE.md"), "@AGENTS.md\n");
  for (const name of skills) {
    for (const base of [".claude/skills", ".agents/skills"]) fs.cpSync(path.join(skillsDir, name), path.join(rootDir, base, name), { recursive: true });
  }

  // The app: what `everyapp create <id>` makes (lib/app/starter.ts, lib/app/skill.ts), without the install.
  fs.cpSync(starterDir, appDir, { recursive: true, filter: (source) => !LOCAL_ONLY.includes(path.basename(source)) });
  const packageJson = readJson(path.join(appDir, "package.json"));
  packageJson.name = appId;
  writeJson(path.join(appDir, "package.json"), packageJson);
  const manifestFile = path.join(appDir, "everyapp.config.ts");
  fs.writeFileSync(
    manifestFile,
    fs
      .readFileSync(manifestFile, "utf8")
      .replace(/(\bid\s*:\s*)["'][^"']+["']/, `$1"${appId}"`)
      .replace(/(\bname\s*:\s*)["'][^"']+["']/, `$1"${appNameFor(appId)}"`),
  );
  const readmeFile = path.join(appDir, "README.md");
  if (fs.existsSync(readmeFile)) fs.writeFileSync(readmeFile, fs.readFileSync(readmeFile, "utf8").replace(/^# .*$/m, `# ${appNameFor(appId)}`));
  for (const name of skills) {
    for (const base of [".claude/skills", ".agents/skills"]) fs.cpSync(path.join(skillsDir, name), path.join(appDir, base, name), { recursive: true });
  }
  for (const [relative, content] of Object.entries(scenario.appFiles ?? {})) {
    const file = path.join(appDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  // node_modules: the starter's, entry by entry (so vitest, tsc, drizzle-kit and the SDK
  // resolve as they do in starter/), with everyapp the fake and cf a stub that only
  // writes types. pnpm's bin shims locate their package through `$basedir/../<pkg>`,
  // which the links beside them satisfy.
  const logFile = path.join(runDir, "other-commands.log");
  const sourceModules = path.join(starterDir, "node_modules");
  const targetModules = path.join(appDir, "node_modules");
  fs.mkdirSync(path.join(targetModules, ".bin"), { recursive: true });
  for (const entry of fs.readdirSync(sourceModules)) {
    if (entry.startsWith(".")) continue;
    fs.symlinkSync(path.join(sourceModules, entry), path.join(targetModules, entry));
  }
  const realCf = path.join(sourceModules, ".bin", "cf");
  const cfStub = (file, tool) =>
    writeShellStub(file, {
      tool,
      logFile,
      version: FAKE_CF_VERSION,
      passthrough: { prefixes: CF_PASSTHROUGH, exec: realCf },
      refusal: `fake ${tool}: '${tool} $*' isn't available in the build-skill harness; the app is deployed by the person with pnpm run deploy`,
    });
  for (const bin of fs.readdirSync(path.join(sourceModules, ".bin"))) {
    if (bin === "everyapp") fs.writeFileSync(path.join(targetModules, ".bin", bin), binShim, { mode: 0o755 });
    else if (bin === "cf" || bin === "cloudflare") cfStub(path.join(targetModules, ".bin", bin), bin);
    else fs.symlinkSync(path.join(sourceModules, ".bin", bin), path.join(targetModules, ".bin", bin));
  }

  // On PATH, first: cf (types only), wrangler and curl refused and logged.
  fs.mkdirSync(path.join(runDir, "bin"), { recursive: true });
  cfStub(path.join(runDir, "bin", "cf"), "cf");
  writeShellStub(path.join(runDir, "bin", "wrangler"), { tool: "wrangler", logFile, refusal: "fake wrangler: 'wrangler $*' isn't available in the build-skill harness; use pnpm everyapp" });
  writeShellStub(path.join(runDir, "bin", "curl"), { tool: "curl", logFile, refusal: "fake curl: nothing is listening in the build-skill harness (pnpm dev is a fake here); the person tries the app" });

  // The fake Gateway's state: this app registered, never deployed, with the
  // manifest the starter ships (read from starter/everyapp.config.ts, so the
  // seed follows the starter: its resources, its capabilities, no public route).
  const state = {
    ...structuredClone(DEFAULT_STATE),
    ...(scenario.state ?? {}),
    apps: scenario.state?.apps ?? [{ id: appId, name: appNameFor(appId), deployed: false, manifest: { ...starterManifest(), id: appId, name: appNameFor(appId) } }],
  };
  writeJson(path.join(runDir, "state.json"), state);
  fs.writeFileSync(path.join(runDir, "invocations.jsonl"), "");
}

/**
 * The starter's manifest (starter/everyapp.config.ts) as an object. The file
 * is one literal, `export default { … } as const;` with line comments, so the
 * harness reads it as such instead of through a TypeScript loader (it has no
 * dependencies). A starter manifest that stops being a plain literal fails
 * here, by name.
 */
function starterManifest() {
  const file = path.join(starterDir, "everyapp.config.ts");
  const literal = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/^\s*export\s+default\s*/, "")
    .replace(/\s*as\s+const\s*;?\s*$/, "");
  try {
    return new Function(`return (${literal});`)();
  } catch (error) {
    throw new Error(`${file} is not the one object literal the harness reads it as: ${error.message}`);
  }
}

/** The app's own checks, run by the harness: name, ok, ms, the output's tail. */
function runChecks(appDir, runDir, which) {
  const commands = {
    status: { args: ["everyapp", "status", "--json"], ok: (r) => (r.status === 0 || r.status === 2) && r.stdout.trim().split("\n")[0]?.startsWith('{"v":1,') },
    test: { args: ["test"], ok: (r) => r.status === 0 },
    "types:check": { args: ["types:check"], ok: (r) => r.status === 0 },
    "db:generate": { args: ["run", "db:generate"], ok: (r) => r.status === 0 && /No schema changes/.test(r.stdout + r.stderr) },
    // What `pnpm dev` does for a new route file: the TanStack plugin rewrites src/routeTree.gen.ts during a build.
    routes: { args: ["exec", "vite", "build", "--mode", "development"], ok: (r) => r.status === 0 },
  };
  const env = { ...process.env, PATH: `${path.join(runDir, "bin")}:${process.env["PATH"] ?? ""}`, CI: "1" };
  delete env["CLAUDECODE"];
  const results = [];
  for (const name of which) {
    const command = commands[name];
    const started = Date.now();
    const result = spawnSync("pnpm", command.args, { cwd: appDir, encoding: "utf8", env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const ok = Boolean(command.ok(result)) && !result.error;
    results.push({ name, command: `pnpm ${command.args.join(" ")}`, ok, exit: result.status, ms: Date.now() - started, tail: output.trim().split("\n").slice(-12).join("\n") });
    fs.appendFileSync(path.join(runDir, "checks.log"), `== pnpm ${command.args.join(" ")} (exit ${result.status}, ${ok ? "ok" : "failed"})\n${output}\n`);
  }
  return results;
}

/** What the harness needs before the first run: the SDK built, claude on PATH, the starter installed. */
function preflight() {
  if (!fs.existsSync(path.join(checkoutRoot, "packages", "cli", "node_modules", "@every-app", "sdk", "dist", "internal", "index.js"))) {
    process.stderr.write("The SDK isn't built: run pnpm install (or pnpm -C packages/sdk build) first.\n");
    process.exit(69);
  }
  for (const bin of ["vitest", "tsc", "drizzle-kit", "cf", "vite"]) {
    if (!fs.existsSync(path.join(starterDir, "node_modules", ".bin", bin))) {
      process.stderr.write(`starter/node_modules/.bin/${bin} is missing: run pnpm install at the checkout root first.\n`);
      process.exit(69);
    }
  }
  if (!options.scratchOnly && spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
    process.stderr.write("claude isn't on PATH, or won't start.\n");
    process.exit(69);
  }
}

// ---------------------------------------------------------------- expectations

function evaluate(scenario, expect, log, runDir, appDir, pristineDir, diff, defaultReply) {
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
  }));
  const otherCommands = fs.existsSync(path.join(runDir, "other-commands.log")) ? fs.readFileSync(path.join(runDir, "other-commands.log"), "utf8").trim().split("\n").filter(Boolean) : [];
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  const ran = log.stopped !== "scratch_only" && log.stopped !== "scratch_check_failed";

  for (const scratch of log.scratchChecks) {
    check(`scratch ${scratch.command} before the run`, scratch.ok, scratch.ok ? fmtDuration(scratch.ms) : `exit ${scratch.exit}: ${excerpt(scratch.tail, 300)}`);
  }
  if (!ran) {
    check("the agent ran", false, log.stopped === "scratch_only" ? "--scratch-only: the scratch was built and checked, no agent" : "a scratch check failed, so the agent never started");
    return finish(results, [], commands, otherCommands, diff, log, runDir, []);
  }

  // The skill was read before the first edit.
  const firstEdit = firstWrite(log.toolUses);
  const editAt = firstEdit ? `first edit at ${describeCall(firstEdit, appDir)}` : "no edit was made";
  if (expect.readSkill) {
    const read = firstRead(log.toolUses, { file: SKILL_FILE, skill: "build-every-app" });
    const before = read && (!firstEdit || read.seq < firstEdit.seq);
    check("read build-every-app/SKILL.md before the first edit", Boolean(before), read ? `${describeCall(read, appDir)}; ${editAt}` : `never read; ${editAt}`);
  }
  if (expect.readPatterns) {
    const read = firstRead(log.toolUses, { file: PATTERNS_FILE });
    const before = read && (!firstEdit || read.seq < firstEdit.seq);
    check("read build-every-app/patterns.md before the first edit", Boolean(before), read ? `${describeCall(read, appDir)}; ${editAt}` : `never read; ${editAt}`);
  }

  // The table, its migration, the tools.
  const state = goals(appDir, pristineDir, expect);
  if (expect.schema) check("src/db/schema.ts changed", state.schemaChanged, state.schemaChanged ? "differs from the starter's" : "unchanged");
  if (expect.migration) {
    const generate = log.bashCommands.findIndex((bash) => /\bdb:generate\b|drizzle-kit\s+generate/.test(bash.command));
    const how = generate >= 0 ? `by pnpm run db:generate (shell command ${generate + 1})` : "written by hand (db:generate never ran)";
    check("a migration was added under drizzle/", state.newMigrations.length > 0, state.newMigrations.length ? `${state.newMigrations.join(", ")}, ${how}` : "no new .sql file");
  }
  if (expect.tools !== false) {
    const min = expect.tools?.min ?? 1;
    const noRisk = state.toolsAdded.filter((tool) => !tool.risk);
    const enough = state.toolsMatching.length >= min;
    const listed = state.toolsAdded.map((tool) => `${tool.name} (${tool.risk ?? "no risk"})`).join(", ");
    check(
      `src/tools.ts gained ${min}+ tool${min === 1 ? "" : "s"}${expect.tools?.nameMatches ? ` matching /${expect.tools.nameMatches}/` : ""}, each with a risk`,
      enough && noRisk.length === 0,
      state.toolsAdded.length ? `${listed}${noRisk.length ? `; without a risk: ${noRisk.map((t) => t.name).join(", ")}` : ""}` : state.toolsNow.length === 0 && !fs.existsSync(path.join(appDir, "src/tools.ts")) ? "src/tools.ts is gone" : "no tool added",
    );
  }

  // What the ask leaves alone (run 1: "add notes" deleted the todo list and its migration).
  if (expect.keep?.length) {
    const gone = expect.keep.filter((file) => !fs.existsSync(path.join(appDir, file)));
    check(`kept ${expect.keep.length} file${expect.keep.length === 1 ? "" : "s"} the ask didn't touch`, gone.length === 0, gone.length ? `deleted: ${gone.join(", ")}` : expect.keep.join(", "));
  }

  // Nothing of the app's own around identity.
  if (expect.noAuthCode) {
    const hits = findForbidden(diff.files, AUTH_PATTERN);
    check("no login, session, password or cookie code added", hits.length === 0, hits.length ? hits.slice(0, 4).map((h) => `${h.path}: ${excerpt(h.line, 100)}`).join("; ") : `${diff.files.length} files changed, none of it`);
  }
  if (expect.noClientHeaders) {
    const hits = findForbidden(diff.files, CLIENT_HEADER_PATTERN);
    check("no identity read from a client header", hits.length === 0, hits.length ? hits.slice(0, 4).map((h) => `${h.path}: ${excerpt(h.line, 100)}`).join("; ") : "no header read added");
  }

  // Nothing reached Cloudflare or the Gateway.
  if (expect.neverDeploy) {
    const deploys = commands.filter((c) => NEVER.some((re) => re.test(c.command)));
    // The stubs' log is `<utc> <tool> <args>` per line (shared/tool-stubs.mjs); cloudflareCalls reads it.
    const tools = cloudflareCalls(otherCommands, CF_PASSTHROUGH);
    const bad = [...deploys.map((c) => `everyapp ${c.command}`), ...tools];
    check("never deployed (no everyapp deploy/release/install, no cf or wrangler)", bad.length === 0, bad.length ? bad.join("; ") : "nothing reached Cloudflare or the Gateway");
  }

  // The app's checks, run by the harness.
  if (expect.checks) {
    for (const after of log.checksAfter) {
      check(`${after.command} passes after the run`, after.ok, after.ok ? fmtDuration(after.ms) : `exit ${after.exit}: ${excerpt(after.tail, 400)}`);
    }
  }

  // The closing message: what changed, how to try it.
  const closing = closingMessage(log, defaultReply);
  for (const needle of expect.finalMentions ?? []) {
    const found = closing.text.toLowerCase().includes(needle.toLowerCase());
    check(`final message says "${needle}"`, found, found ? closing.where : `not in: ${excerpt(closing.text, 160)}`);
  }
  if (expect.finalPattern) {
    const re = new RegExp(expect.finalPattern, "i");
    const found = re.test(closing.text);
    check(`final message matches /${expect.finalPattern}/`, found, found ? closing.where : `not in: ${excerpt(closing.text, 160)}`);
  }
  for (const needle of expect.mustMention ?? []) {
    const found = log.assistantText.some((text) => text.toLowerCase().includes(needle.toLowerCase()));
    check(`mentions ${needle}`, found, found ? "in the assistant's text" : "never said");
  }
  if (expect.neverAskedInChat) {
    const asked = log.flags.filter((f) => f.flag === "asked_for_secret_in_chat");
    check("never asked for a secret in the chat", asked.length === 0, asked.length ? asked.map((f) => f.excerpt).join("; ") : "no flag raised");
  }
  if (expect.noDestructive) {
    const allowed = (scenario.allowCommands ?? []).map((p) => new RegExp(p));
    const bad = commands.filter((c) => DESTRUCTIVE.some((re) => re.test(c.command)) && !allowed.some((re) => re.test(c.command)));
    check("no destructive everyapp command", bad.length === 0, bad.length ? bad.map((c) => c.command).join("; ") : "none");
  }
  check("the conversation ended on its own", log.stopped === "goals met" || log.stopped?.startsWith("round cap"), log.stopped ?? "the agent stopped first");

  const warnings = [];
  const unknown = commands.filter((c) => c.exit === 251 || c.exit === 252);
  if (unknown.length) warnings.push(`${unknown.length} command(s) the CLI refused: ${unknown.map((c) => c.command).join("; ")}`);
  const faked = commands.filter((c) => /^(?:create|dev|deploy|release|install|update)\b/.test(c.command));
  if (faked.length) warnings.push(`the fake everyapp answered, and did nothing, for: ${faked.map((c) => c.command).join("; ")}`);
  const unexpected = diff.files.filter((file) => !EXPECTED_CHANGES.some((re) => re.test(file.path)));
  if (unexpected.length) warnings.push(`changed outside src/, drizzle/, everyapp.config.ts: ${unexpected.map((f) => `${f.path} (${f.status})`).join(", ")}`);
  if (log.routeTreeRegenerated) warnings.push(`src/routeTree.gen.ts regenerated ${log.routeTreeRegenerated} (pnpm dev would have; the fake dev doesn't)`);
  if (log.stopped?.startsWith("round cap")) warnings.push(`the person hit the round cap; the closing message is the last one before it`);
  return finish(results, warnings, commands, otherCommands, diff, log, runDir, state.toolsAdded);
}

/**
 * What the agent said once the work was done: from the wrap-up (the first
 * message after the goals were met; run 3's said "pnpm dev" there and the
 * person's "I ran it" drew a follow-up that didn't) to the message the
 * person ended on. Without a wrap-up (the round cap came first), the
 * message the person ended on, plus the one before any trailing default
 * replies ("Go on.") to messages that only reported progress.
 */
function closingMessage(log, defaultReply) {
  const ended = log.rounds.findIndex((round) => round.reply === null);
  const last = ended >= 0 ? ended : log.assistantText.length - 1;
  if (log.goalsMetRound != null && log.goalsMetRound <= last) {
    const n = last - log.goalsMetRound + 1;
    return { text: log.assistantText.slice(log.goalsMetRound, last + 1).join("\n"), where: n === 1 ? "in the wrap-up, the message the person ended on" : `in the ${n} messages from the wrap-up (round ${log.goalsMetRound + 1}) to the one the person ended on` };
  }
  let at = last;
  while (at > 0 && log.rounds[at - 1]?.matched === null && log.rounds[at - 1]?.reply === defaultReply) at--;
  const final = log.assistantText[last] ?? "";
  if (at === last) return { text: final, where: "in the message the person ended on" };
  return { text: `${log.assistantText[at] ?? ""}\n${final}`, where: `in the closing before the person's ${last - at} trailing "${defaultReply}" repl${last - at === 1 ? "y" : "ies"}, or the message after them` };
}

function finish(expectations, warnings, commands, otherCommands, diff, log, runDir, toolsAdded) {
  const counts = {};
  for (const use of log.toolUses) counts[use.name] = (counts[use.name] ?? 0) + 1;
  return {
    scenario: log.scenario,
    model: log.model,
    runDir,
    appId: log.appId,
    startedAt: log.startedAt,
    durationMs: log.durationMs,
    costUsd: log.costUsd,
    pass: expectations.every((r) => r.pass),
    expectations,
    warnings,
    scratchChecks: log.scratchChecks,
    checksAfter: log.checksAfter,
    routeTreeRegenerated: log.routeTreeRegenerated,
    changedFiles: diff.files.map((file) => ({ path: file.path, status: file.status, added: file.added.length, removed: file.removed })),
    toolsAdded,
    toolCalls: counts,
    toolUses: log.toolUses,
    commands,
    bashCommands: log.bashCommands,
    refusedTools: otherCommands,
    rounds: log.rounds,
    flags: log.flags,
    stopped: log.stopped,
    resultSubtypes: log.resultSubtypes,
    init: log.init ?? null,
    finalMessage: log.finalMessage,
    goodbyeReply: log.goodbyeReply ?? null,
  };
}

function summary(report) {
  const calls = Object.entries(report.toolCalls).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(", ");
  const lines = [
    `== ${report.scenario} (${report.model}) — ${report.pass ? "PASS" : "FAIL"} — ${fmtDuration(report.durationMs)}, $${report.costUsd.toFixed(2)} — ${report.runDir}`,
    "Expectations:",
    ...report.expectations.map((r) => `  ${r.pass ? "✓" : "✗"} ${r.name}: ${r.detail}`),
    ...(report.warnings.length ? ["Warnings:", ...report.warnings.map((w) => `  ! ${w}`)] : []),
    `Tool calls (${report.toolUses.length}${calls ? `: ${calls}` : ""}); pnpm everyapp commands in order:`,
    ...(report.commands.length
      ? report.commands.map((c) => `  ${String(c.n).padStart(2)}. ${c.command.padEnd(40)} ${c.cwd !== "." ? `(${c.cwd}) ` : ""}exit ${c.exit}`)
      : ["  (none)"]),
    "Changed files:",
    ...(report.changedFiles.length ? report.changedFiles.map((f) => `  ${f.status.padEnd(8)} ${f.path} (+${f.added} -${f.removed})`) : ["  (none)"]),
    "Person rounds:",
    ...report.rounds.map((r) => `  ${r.round + 1}. ${r.matched ? `[${r.matched}]` : "[default]"} ${r.reply ? `→ ${JSON.stringify(r.reply)}` : `(end: ${r.note})`}`),
    "Final assistant message (the one the person ended on):",
    ...indent(report.finalMessage.trim() || "(none)", 2, 1600).split("\n"),
    ...(report.goodbyeReply ? ["Reply to the goodbye:", ...indent(report.goodbyeReply.trim(), 2, 400).split("\n")] : []),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- options

function parseOptions(args) {
  const o = { scenario: null, model: "sonnet", maxRounds: 6, maxTurns: 150, turnTimeoutS: 900, totalTimeoutS: 3600, fullSettings: false, keepGoing: false, scratchOnly: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model") o.model = args[++i];
    else if (arg === "--max-rounds") o.maxRounds = Number(args[++i]);
    else if (arg === "--max-turns") o.maxTurns = Number(args[++i]);
    else if (arg === "--turn-timeout-s") o.turnTimeoutS = Number(args[++i]);
    else if (arg === "--total-timeout-s") o.totalTimeoutS = Number(args[++i]);
    else if (arg === "--full-settings") o.fullSettings = true;
    else if (arg === "--keep-going") o.keepGoing = true;
    else if (arg === "--scratch-only") o.scratchOnly = true;
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
    "Usage: node packages/cli/test/build-skill/run.mjs <scenario|all> [options]",
    "  --model <name>         sonnet (default) or opus, or any model claude accepts",
    "  --max-rounds <n>       the person's replies before they say goodbye (default 6)",
    "  --max-turns <n>        claude's --max-turns (default 150)",
    "  --turn-timeout-s <s>   how long one assistant turn may take (default 900)",
    "  --total-timeout-s <s>  the whole scenario (default 3600)",
    "  --scratch-only         build the scratch app, run its checks, start no agent",
    "  --full-settings        keep your user settings, plugins and MCP servers in the session",
    "  --keep-going           with all: run every scenario even after a failure",
    `Scenarios: ${fs.existsSync(scenariosDir) ? fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).join(", ") : "(none)"}`,
    "",
  ].join("\n");
}
