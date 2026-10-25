/**
 * What the build-skill harness reads off the scratch app after a run: the
 * diff against the pristine copy, the tools `src/tools.ts` defines (each
 * with its `risk`), the lines of added code that smell of a login or of
 * identity read from a client header, and, from the session's tool calls,
 * when the skill was read and when the first edit happened. Pure
 * functions over strings and small objects; app-checks.test.mjs holds
 * their cases.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Never copied from the starter or snapshotted from the app (lib/app/starter.ts LOCAL_ONLY, plus the harness's links). */
export const LOCAL_ONLY = [
  "node_modules",
  ".git",
  "pnpm-lock.yaml",
  "package-lock.json",
  ".env",
  ".env.local",
  ".env.production",
  ".dev.vars",
  ".cloudflare",
  ".everyapp",
  ".wrangler",
  ".output",
  ".tanstack",
  "dist",
  "manual-steps.md",
];

/** The app's display name from its id, as `everyapp create` spells it (commands/create/steps/updateConfiguration.ts). */
export function appNameFor(appId) {
  return appId
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A copy of `from` at `to` without LOCAL_ONLY entries (at any depth). */
export function snapshotApp(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => !LOCAL_ONLY.includes(path.basename(source)),
  });
}

/**
 * `git diff --no-index` of two snapshots under `runDir` (`pristine`, `after`):
 * the unified text and, per file, its status and added lines.
 */
export function diffApps(runDir, before = "pristine", after = "after") {
  const result = spawnSync("git", ["-c", "core.pager=cat", "diff", "--no-index", "--no-color", "--no-ext-diff", before, after], { cwd: runDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git diff --no-index failed (${result.status}): ${result.stderr}`);
  return { text: result.stdout, files: parseDiff(result.stdout, after, before) };
}

/**
 * The files of a unified diff between the two snapshot directories: path
 * (relative to either snapshot: a deleted file's b/ side still names the
 * first), status, added lines (with their text).
 */
export function parseDiff(text, afterDir = "after", beforeDir = "pristine") {
  const files = [];
  let current = null;
  for (const line of text.split("\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (header) {
      const prefix = [afterDir, beforeDir].find((dir) => header[2].startsWith(`${dir}/`));
      const relative = prefix ? header[2].slice(prefix.length + 1) : header[2];
      current = { path: relative, status: "modified", added: [], removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed++;
  }
  return files;
}

const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const GENERATED = [/^src\/routeTree\.gen\.ts$/, /^drizzle\/meta\//, /^\.claude\//, /^\.agents\//];

/** The added lines of code (not comments, not generated files, not markdown) across the diff's files. */
export function addedCodeLines(files) {
  const lines = [];
  for (const file of files) {
    if (!CODE_FILE.test(file.path) || GENERATED.some((re) => re.test(file.path))) continue;
    for (const line of file.added) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      lines.push({ path: file.path, line: trimmed });
    }
  }
  return lines;
}

/** A login, session, password or cookie of the app's own: what the skill's rule 4 forbids. */
export const AUTH_PATTERN = /\b(?:login|log[- ]?in|logout|log[- ]?out|sign[- ]?in|signin|sign[- ]?up|signup|session|sessions|jwt|jose|password|passwd|bcrypt|argon2|cookie|cookies|setCookie|authenticate|authentication|authorize|authorization)\b/i;

/** Identity taken from what a client sent: a header read, or the Gateway's own header names spelled out. */
export const CLIENT_HEADER_PATTERN = /headers\.get\(|request\.headers|getHeaders?\(|getRequestHeaders?\(|x-user|x-email|x-everyapp|x-every-app|cf-access-authenticated|forwarded-user/i;

/** The added code lines that match `pattern`. */
export function findForbidden(files, pattern) {
  return addedCodeLines(files).filter(({ line }) => pattern.test(line));
}

/**
 * The calls the tool stubs logged (one `<utc> <tool> <args>` per line,
 * shared/tool-stubs.mjs) that reached for Cloudflare: every `wrangler` call,
 * and every `cf` or `cloudflare` call except `--version` and the
 * `passthrough` prefixes the harness hands to the real cf. Each as
 * `<tool> <args>`.
 */
export function cloudflareCalls(lines, passthrough = []) {
  const calls = [];
  for (const line of lines) {
    const [, tool, ...rest] = line.trim().split(" ");
    const args = rest.join(" ");
    const reached =
      tool === "wrangler" ||
      ((tool === "cf" || tool === "cloudflare") && args !== "--version" && !passthrough.some((prefix) => args === prefix || args.startsWith(`${prefix} `)));
    if (reached) calls.push(`${tool} ${args}`.trim());
  }
  return calls;
}

/**
 * The tools `source` (src/tools.ts) defines in its `defineTools({ … })`
 * call: `[{ name, risk }]` with `risk` null when the tool has none; null
 * when there is no defineTools call. A small walk over the object literal
 * that skips strings, template literals and comments, so a brace inside a
 * description doesn't throw it off.
 */
export function toolsDefined(source) {
  const call = source.indexOf("defineTools(");
  if (call < 0) return null;
  const open = source.indexOf("{", call);
  if (open < 0) return null;
  const close = matchingBrace(source, open);
  if (close < 0) return null;
  const tools = [];
  let i = open + 1;
  while (i < close) {
    const skipped = skipNonCode(source, i);
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const key = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*\{/.exec(source.slice(i, close + 1));
    if (key) {
      const name = key[1] ?? key[2] ?? key[3];
      const blockOpen = i + key[0].length - 1;
      const blockClose = matchingBrace(source, blockOpen);
      if (blockClose < 0) break;
      const body = source.slice(blockOpen, blockClose + 1);
      const risk = /\brisk\s*:\s*["'`](read|write|destructive)["'`]/.exec(body);
      tools.push({ name, risk: risk ? risk[1] : null });
      i = blockClose + 1;
      continue;
    }
    // Something else at this level (a spread, a comma, whitespace): step over it, and over any nested block.
    if (source[i] === "{" || source[i] === "[" || source[i] === "(") {
      const end = matchingBrace(source, i);
      i = end < 0 ? i + 1 : end + 1;
      continue;
    }
    i++;
  }
  return tools;
}

/** The index of the bracket that closes the one at `open`, or -1. */
function matchingBrace(source, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const closer = pairs[source[open]];
  if (!closer) return -1;
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return ch === closer ? i : -1;
    }
    i++;
  }
  return -1;
}

/** The index after a string, template literal or comment that starts at `i`; `i` when none does. */
function skipNonCode(source, i) {
  const ch = source[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    let j = i + 1;
    while (j < source.length && source[j] !== ch) {
      if (source[j] === "\\") j++;
      j++;
    }
    return j + 1;
  }
  if (ch === "/" && source[i + 1] === "/") {
    const end = source.indexOf("\n", i);
    return end < 0 ? source.length : end + 1;
  }
  if (ch === "/" && source[i + 1] === "*") {
    const end = source.indexOf("*/", i + 2);
    return end < 0 ? source.length : end + 2;
  }
  return i;
}

/**
 * The skill's two files, in either copy (`.claude/skills/…`, `.agents/skills/…`).
 * Not anchored: a Bash command goes on after the path (run 2 read patterns.md
 * with `grep -B2 -A12 "orgId" .agents/skills/build-every-app/patterns.md | head -80`).
 */
export const SKILL_FILE = /skills\/build-every-app\/SKILL\.md\b/;
export const PATTERNS_FILE = /skills\/build-every-app\/patterns\.md\b/;

const READ_VERBS = /\b(?:cat|sed|head|tail|less|more|bat|awk|grep|rg)\b/;

/**
 * The first tool call that read a file matching `file` (a RegExp over the
 * path): the Read tool, a Bash command that prints it, or, when `skill`
 * is given, the Skill tool invoking that skill (which loads its SKILL.md).
 */
export function firstRead(toolUses, { file, skill = null }) {
  for (const use of toolUses) {
    const input = use.input ?? {};
    if (use.name === "Read" && typeof input.file_path === "string" && file.test(input.file_path)) return use;
    if (use.name === "Bash" && typeof input.command === "string" && READ_VERBS.test(input.command) && file.test(input.command)) return use;
    if (skill && use.name === "Skill" && typeof input.skill === "string" && input.skill.includes(skill)) return use;
  }
  return null;
}

/** A Bash command that changes files: a redirect (not stderr's), tee, sed -i, cp, mv, rm, or a generator. */
const WRITES = /(?:^|[^2&<>])>(?!&)|\btee\b|\bsed\s+-i\b|\bcp\s|\bmv\s|\brm\s|\bdb:generate\b|drizzle-kit\s+generate/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The first tool call that changed a file: an edit tool, or a Bash command that writes. */
export function firstWrite(toolUses) {
  for (const use of toolUses) {
    const input = use.input ?? {};
    if (EDIT_TOOLS.has(use.name)) return use;
    if (use.name === "Bash" && typeof input.command === "string" && WRITES.test(input.command)) return use;
  }
  return null;
}

/** One line naming a tool call for a report: "call 7, Edit src/db/schema.ts". */
export function describeCall(use, appDir) {
  const input = use.input ?? {};
  const what = typeof input.file_path === "string" ? path.relative(appDir, input.file_path) : typeof input.command === "string" ? excerptOf(input.command, 80) : typeof input.skill === "string" ? `skill ${input.skill}` : "";
  return `call ${use.seq}, ${use.name}${what ? ` ${what}` : ""}`;
}

function excerptOf(text, length) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
