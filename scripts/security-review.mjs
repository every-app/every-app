#!/usr/bin/env node
/**
 * The security review of a branch's pending changes, run locally.
 *
 * Builds one prompt (the audit prompt of anthropics/claude-code-security-review
 * pinned at 0c6a49f1, scripts/security-review/audit-prompt.md; this
 * repository's boundaries, scan-instructions.md; its false-positive rules,
 * false-positives.md; a pointer to docs/threat-model.md; the diff), runs
 * Claude Code over it non-interactively in restricted mode with read-only
 * tools confined to the checkout, parses the JSON block the model ends with,
 * prints the findings, and exits 1 while a high or medium one remains. No CI
 * job runs it: Ben's call (2026-10-24) was local skills instead of an API key
 * in Actions. The .claude/skills/security-review skill says when to run it.
 *
 * The model reads the diff as instructions too: the review is a second pair
 * of eyes on your own changes, not a gate on a stranger's. On a contributor's
 * branch read the diff first, and this script, since the branch's copy runs.
 *
 *   pnpm security-review                 the branch against origin/main, plus the working tree
 *   pnpm security-review --base main     against another ref
 *   pnpm security-review --staged        only what is committed or staged
 *   pnpm security-review --json          the findings as JSON on stdout
 *   pnpm security-review --model opus    another model than Claude Code's default
 *
 * Exit 0: no high or medium finding. 1: at least one. 2: it could not run
 * (no claude on PATH, nothing to review, no answer it could read).
 *
 * Pinned by packages/cli/src/lib/securityReview.test.ts with a fake claude.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { policy } from "./public-copy/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.join(HERE, "security-review");
const CLAUDE_CODE = "https://docs.claude.com/en/docs/claude-code";
/** Prose and the lockfile: nothing there runs, and the false-positive rules exclude it anyway. */
const NOT_REVIEWED = ["docs", "adr", "prompts", "landing-page/content", "*.md", "pnpm-lock.yaml"];
/** Two copies of the skill, for the two places agents look; they must stay the same. */
const SKILL_COPIES = [".claude/skills/security-review/SKILL.md", ".agents/skills/security-review/SKILL.md"];
/**
 * The review's own rules and this script: *.md keeps the rules out of the
 * diff, so a change to them is named instead, or a rule written to excuse
 * one change would pass unseen.
 */
const RULES = ["scripts/security-review.mjs", "scripts/security-review", ...SKILL_COPIES];
const SEVERITIES = ["high", "medium", "low"];
/** Claude Code refuses piped stdin over 10 MB before it sends anything; a prompt past this goes without the diff. */
const STDIN_LIMIT = 9_500_000;

const HELP = `pnpm security-review [options]

Review the branch's pending changes for security problems with Claude Code
(restricted mode, read-only tools confined to the checkout, your own Claude
Code login). Exit 1 while a high or medium finding remains, 0 otherwise, 2
when the review could not run.

  --base <ref>    What to diff against (default origin/main, else main).
  --staged        Only what is committed or staged, not the working tree
                  (the default also sends untracked files, except ones whose
                  name only ever holds credentials: .env, *.pem, providers.env).
  --json          Print the findings as JSON instead of the table.
  --model <id>    A model other than Claude Code's default (an alias or a full name).
  --help          This text.`;

let flags;
try {
  ({ values: flags } = parseArgs({
    options: {
      base: { type: "string" },
      staged: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      model: { type: "string" },
      help: { type: "boolean", default: false },
    },
  }));
} catch (error) {
  console.error(`security-review: ${error.message}\n\n${HELP}`);
  process.exit(2);
}
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

/** Prints to stderr and exits 2: the review did not run, which is not the same as a clean one. */
function fail(message) {
  console.error(`security-review: ${message}`);
  process.exit(2);
}

/** `git <args>`; a non-zero status is fatal unless `ok` lists it (`git diff --no-index` exits 1 on a difference). */
function git(args, { ok = [0] } = {}) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error) fail(`git failed: ${run.error.message}`);
  if (!ok.includes(run.status)) fail(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (top.status !== 0) fail("run it inside the checkout");
const root = top.stdout.trim();

const [claudeCopy, agentsCopy] = SKILL_COPIES.map((p) => path.join(root, p));
if (fs.existsSync(claudeCopy) && fs.existsSync(agentsCopy) && fs.readFileSync(claudeCopy, "utf8") !== fs.readFileSync(agentsCopy, "utf8")) {
  console.error(`security-review: ${SKILL_COPIES[1]} differs from ${SKILL_COPIES[0]}; copy one over the other.`);
}

// The diff: everything the branch changed since it left the base, plus what
// is edited and not yet committed (what a pull request would carry once it
// is). --staged leaves out the working tree, as a commit now would.
const base = flags.base ?? (git(["rev-parse", "--verify", "--quiet", "origin/main"], { ok: [0, 1] }) ? "origin/main" : "main");
const mergeBase = git(["merge-base", base, "HEAD"]).trim();
const staged = flags.staged ? ["--cached"] : [];
const rulesChanged = git(["diff", "--name-only", ...staged, mergeBase, "--", ...RULES]).split("\n").filter(Boolean);
if (rulesChanged.length > 0) {
  console.error(`security-review: the review's own rules changed on this branch; read them: ${rulesChanged.join(", ")}`);
}
const exclude = NOT_REVIEWED.map((p) => `:(exclude)${p}`);
let diff = git(["diff", ...staged, mergeBase, "--", ".", ...exclude]);
if (!flags.staged) {
  // Untracked files are new to the branch too; git diff alone never shows
  // them. A file whose name only ever holds credentials (the public copy's
  // list: accounts.json, providers.env, .env, *.pem and the rest) stays out
  // whatever it holds, since .gitignore does not cover them all; so does
  // anything that is not a regular file (a nested repository, a link).
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclude]).split("\0").filter(Boolean);
  const sent = [];
  const kept = [];
  for (const file of untracked) {
    const name = path.basename(file);
    const rule = policy.denyNames.find((r) => r.pattern.test(name) && !r.allow?.test(name));
    if (rule) {
      kept.push(`${file} (${rule.why})`);
      continue;
    }
    if (!fs.lstatSync(path.join(root, file)).isFile()) {
      kept.push(`${file} (not a regular file)`);
      continue;
    }
    diff += git(["diff", "--no-index", "--", "/dev/null", file], { ok: [0, 1] });
    sent.push(file);
  }
  if (sent.length > 0) console.error(`security-review: untracked, reviewed as new files: ${sent.join(", ")}`);
  if (kept.length > 0) console.error(`security-review: untracked and not sent: ${kept.join(", ")}`);
}
if (diff.trim() === "") {
  fail(`nothing to review against ${base} (${mergeBase.slice(0, 8)}): no code changed (${NOT_REVIEWED.join(", ")} are not reviewed).`);
}

/** Every file in the diff, from its `diff --git` headers (a deleted file has no `+++ b/` line), the deleted ones marked. */
function listFiles(text) {
  const files = new Map();
  for (const block of text.split(/^(?=diff --git )/m)) {
    const header = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) continue;
    const file = header[2];
    files.set(file, /^\+\+\+ \/dev\/null$/m.test(block) ? `${file} (deleted)` : file);
  }
  return [...files.values()];
}
const files = listFiles(diff);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();

/** A prompt file, its HTML comment (the attribution) stripped. */
const promptFile = (name) => fs.readFileSync(path.join(PROMPT_DIR, name), "utf8").replace(/<!--[\s\S]*?-->\n*/g, "").trim();

function prompt({ withDiff }) {
  const diffSection = withDiff
    ? `DIFF CONTENT:\n\`\`\`\n${diff}\n\`\`\`\n\nReview the complete diff above. This contains all code changes on the branch.`
    : "NOTE: the diff was omitted because it is too long for one prompt. Read the files listed above with the Read tool and review what they contain.";
  return `You are a senior security engineer conducting a focused security review of the pending changes on branch "${branch}" of the Every App repository (a self-hosted platform for private web apps on Cloudflare), against ${base} (merge base ${mergeBase.slice(0, 8)}).

Files modified:
${files.map((f) => `- ${f}`).join("\n")}

${diffSection}

${promptFile("audit-prompt.md")}

EVERY APP'S BOUNDARIES (what to look for in this repository; read docs/threat-model.md with the Read tool when a change touches one, it names each boundary's invariants and the code that holds them):
${promptFile("scan-instructions.md")}

FALSE-POSITIVE FILTERING: before reporting a finding, check it against every rule below as a second reviewer would, and drop it when a rule matches or your confidence is below 0.8.
${promptFile("false-positives.md")}

TOOLS: you have Read, Grep and Glob, nothing else; do not try to run commands, edit files or reproduce an exploit. Read the code.

REQUIRED OUTPUT FORMAT: end your reply with exactly one fenced \`\`\`json block (nothing after it) of this shape:
{
  "findings": [
    {
      "file": "packages/perimeter/src/gateway.ts",
      "line": 42,
      "severity": "high",
      "category": "auth_bypass",
      "description": "What is wrong, in one or two sentences",
      "exploit_scenario": "Which actor from the threat model does what, and what they get",
      "recommendation": "The fix",
      "confidence": 0.9
    }
  ],
  "summary": { "files_reviewed": 8, "candidates_dropped": 2 }
}
"severity" is "high", "medium" or "low"; "findings" is [] when there is nothing to report.`;
}

/** Claude Code's answer when the prompt is over the model's window: an error result, exit 1, no charge. */
const tooLong = (result) => typeof result?.result === "string" && /prompt is too long/i.test(result.result);

// Claude Code, non-interactively, in restricted mode: read-only tools only
// (no Bash, no edits), confined to the checkout, the branch's own .claude
// settings and hooks ignored, no MCP servers, no prompts (anything that
// would ask is denied). The model is the login's default unless --model
// says otherwise.
function runClaude(text) {
  const args = ["-p", "--output-format", "json", "--restricted", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob"];
  args.push("--permission-prompts", "none", "--strict-mcp-config", "--no-session-persistence");
  if (flags.model) args.push("--model", flags.model);
  const run = spawnSync("claude", args, { cwd: root, input: text, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error?.code === "ENOENT") fail(`claude (Claude Code) is not on PATH. Install it and sign in: ${CLAUDE_CODE}`);
  if (run.error) fail(`could not run claude: ${run.error.message}`);
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    fail(`claude exited ${run.status} without a JSON result.\n${run.stderr.trim()}\n${run.stdout.trim().slice(0, 2000)}`);
  }
  // A too-long prompt is an error result too; the caller retries without the diff.
  if (tooLong(result)) return result;
  if (run.status !== 0 || result.is_error) fail(`claude exited ${run.status}: ${result.result ?? run.stderr.trim()}`);
  return result;
}

/** The findings block at the end of the model's reply: the last fenced JSON block, else the reply itself. */
function parseFindings(text) {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const candidate of [...fenced.reverse(), text]) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed.findings)) return parsed;
    } catch {
      // the next candidate
    }
  }
  return null;
}

const full = prompt({ withDiff: true });
let withDiff = Buffer.byteLength(full) <= STDIN_LIMIT;
if (!withDiff) console.error("security-review: the diff is over Claude Code's 10 MB stdin limit; sending the file list instead.");
let result = runClaude(withDiff ? full : prompt({ withDiff: false }));
if (withDiff && tooLong(result)) {
  console.error("security-review: the diff is too long for one prompt; sending the file list instead.");
  withDiff = false;
  result = runClaude(prompt({ withDiff: false }));
}
if (tooLong(result)) fail("the file list alone is too long for one prompt; review less at a time (--base a nearer ref).");
const parsed = parseFindings(typeof result.result === "string" ? result.result : "");
if (!parsed) fail(`the model's reply had no findings block:\n${String(result.result).slice(0, 2000)}`);

const findings = parsed.findings
  .map((f) => ({ ...f, severity: String(f.severity ?? "low").toLowerCase() }))
  .filter((f) => SEVERITIES.includes(f.severity))
  .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
const cost = result.total_cost_usd === undefined ? "" : `, $${result.total_cost_usd.toFixed(2)}`;
const took = result.duration_ms === undefined ? "" : `, ${Math.round(result.duration_ms / 1000)} s`;

if (flags.json) {
  const run = { costUsd: result.total_cost_usd ?? null, durationMs: result.duration_ms ?? null, model: flags.model ?? null, withDiff };
  console.log(JSON.stringify({ branch, base, mergeBase, files, rulesChanged, findings, summary: parsed.summary ?? null, counts, run }, null, 2));
} else {
  console.log(`Security review of ${branch} against ${base} (${mergeBase.slice(0, 8)}): ${files.length} files, ${findings.length} findings${cost}${took}\n`);
  for (const f of findings) {
    console.log(`${f.severity.toUpperCase().padEnd(7)} ${f.file}:${f.line ?? "?"}  ${f.category ?? ""}`);
    console.log(`        ${f.description ?? ""}`);
    if (f.exploit_scenario) console.log(`        Exploit: ${f.exploit_scenario}`);
    if (f.recommendation) console.log(`        Fix: ${f.recommendation}`);
    console.log();
  }
  console.log(
    counts.high + counts.medium === 0
      ? `No high or medium finding${counts.low ? ` (${counts.low} low, worth a look)` : ""}.`
      : `${counts.high} high, ${counts.medium} medium: fix each, or say in the pull request why it is a false positive.`,
  );
}
process.exit(counts.high + counts.medium > 0 ? 1 : 0);
