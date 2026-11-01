#!/usr/bin/env node
/**
 * The public copy of Every App, as one fresh commit.
 *
 * Reads a commit of this repository (origin/main by default), exports its
 * tree, drops what stays private, scrubs TODO.md and the documents, checks
 * the result against a deny list, and makes a brand-new git repository that
 * holds exactly one commit of it. Nothing of this repository's history
 * travels. The policy (what is dropped, scrubbed and refused, and why) is
 * scripts/public-copy/policy.mjs; the names that must not travel are in
 * scripts/public-copy/private.txt, a file the copy itself leaves out.
 *
 * Dry run by default: everything happens in a temporary directory that is
 * removed at the end, and the report says what the copy would be, with the
 * tree hash it would have. The same input gives the same tree and commit
 * hash every time: the commit is dated as the source commit and authored
 * as "Every App".
 *
 *   node scripts/public-copy.mjs                   dry run of origin/main
 *   node scripts/public-copy.mjs --write           keep the repository (../every-app-public)
 *   node scripts/public-copy.mjs --push git@github.com:every-app/every-app.git
 *   node scripts/public-copy.mjs --self-test       prove the checks catch what they must
 *   node scripts/public-copy.mjs --help
 *
 * docs/runbooks/public-copy.md is the runbook.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { policy, loadPrivateNames } from "./public-copy/policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = path.join(HERE, "public-copy");
const PRIVATE_FILE = "scripts/public-copy/private.txt";
const MARKER = "Built by scripts/public-copy.mjs";
/** The one identity the public commits carry; the dates are the source commit's. */
const AUTHOR = { name: "EveryApp", email: "noreply@everyapp.com" };

const HELP = `node scripts/public-copy.mjs [options]

Build the public copy of this repository as one fresh commit. Dry run unless
--write or --push is given; nothing is pushed unless --push is given.

  --commit <ref>     The commit to copy (default origin/main, fetched first).
  --no-fetch         Don't fetch before resolving --commit.
  --out <dir>        Where --write puts the new repository
                     (default: every-app-public beside this checkout).
  --write            Keep the repository at --out (replaces an earlier copy there).
  --push <url>       Build, write, then push the one commit to <url>'s main with
                     --force, after you type "push". Only the public repository's
                     URL is accepted unless --any-remote is given too; a remote
                     whose name says private is always refused.
  --any-remote       Allow --push to a URL other than the public repository's.
  --todo scrub|replace
                     TODO.md travels scrubbed (default), or is replaced by
                     scripts/public-copy/TODO.public.md.
  --design designs|all|none
                     docs/design: the designs without the research syntheses
                     (default), everything, or nothing.
  --logs drop|keep   The dated operations logs (docs/launch-2026-10-27.md,
                     docs/simplify-2026-10-24.md): left out (default) or kept.
                     Citations of a document left out become plain text.
  --scan             Also run gitleaks over the copy with scripts/public-copy/gitleaks.toml
                     (gitleaks must be on PATH or in $GITLEAKS).
  --self-test        Build a small tree of things the checks must refuse and
                     prove they do; nothing else runs.
  --json             Print the report as JSON.
  --help             This.

Exit 0: the copy passed every check. 1: a check failed (the report says which).
2: bad usage or a missing tool.`;

async function main() {
  let opts;
  try {
    opts = parseArgs({
      options: {
        commit: { type: "string", default: "origin/main" },
        fetch: { type: "boolean", default: true },
        out: { type: "string" },
        write: { type: "boolean", default: false },
        push: { type: "string" },
        "any-remote": { type: "boolean", default: false },
        todo: { type: "string", default: "scrub" },
        design: { type: "string", default: "designs" },
        logs: { type: "string", default: "drop" },
        scan: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowNegative: true,
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    return usage(error.message);
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts["self-test"]) return selfTest();
  if (!["scrub", "replace"].includes(opts.todo)) return usage(`--todo must be scrub or replace, not ${opts.todo}`);
  if (!["designs", "all", "none"].includes(opts.design)) return usage(`--design must be designs, all or none, not ${opts.design}`);
  if (!["drop", "keep"].includes(opts.logs)) return usage(`--logs must be drop or keep, not ${opts.logs}`);
  if (opts.push !== undefined) {
    if (policy.refusedRemote.test(opts.push)) return usage(`refusing to push to ${opts.push}: that is a private remote`);
    if (!policy.publicRemote.test(opts.push) && !opts["any-remote"]) {
      return usage(`--push takes the public repository's URL (${policy.publicCloneUrl}); pass --any-remote for another`);
    }
    opts.write = true;
  }
  return run(opts);
}

function usage(message) {
  console.error(`public-copy: ${message}\n\n${HELP}`);
  return 2;
}

/**
 * Variables that would point a git command at another repository or index
 * (a GIT_DIR exported by a hook or a tool): removed from every git call, so
 * the copy's init, add and commit touch nothing but the copy.
 */
const GIT_ENV_UNSET = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG_PARAMETERS",
];

function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of GIT_ENV_UNSET) delete env[key];
  return { ...env, ...extra };
}

/** The root of the checkout this script lives in, whatever the cwd. */
const ROOT = git(["rev-parse", "--show-toplevel"], { cwd: HERE });

function outDir(opts) {
  return path.resolve(opts.out ?? path.join(path.dirname(ROOT), "every-app-public"));
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(options.env),
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/**
 * The environment of every git command in the copy: no user or system
 * config, no signing, no background maintenance (a detached `git
 * maintenance run` would repack the objects while they are being copied),
 * one fixed identity, the source commit's dates.
 */
function copyEnv(committedAt) {
  const config = {
    "gc.auto": "0",
    "gc.autoDetach": "false",
    "maintenance.auto": "false",
    "commit.gpgsign": "false",
    "core.excludesFile": "/dev/null",
  };
  const env = {
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
    GIT_AUTHOR_DATE: committedAt,
    GIT_COMMITTER_DATE: committedAt,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(Object.keys(config).length),
  };
  Object.entries(config).forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * An earlier copy this script wrote at `dir`, and nothing else: one commit,
 * carrying the marker, no remotes. Only such a directory is ever replaced.
 */
function existingCopy(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  try {
    return (
      git(["log", "-1", "--format=%B"], { cwd: dir }).includes(MARKER) &&
      git(["rev-list", "--count", "HEAD"], { cwd: dir }) === "1" &&
      git(["remote"], { cwd: dir }) === ""
    );
  } catch {
    return false;
  }
}

async function run(opts) {
  const report = {
    source: {},
    excluded: [],
    replaced: [],
    scrubbed: [],
    citations: [],
    checks: [],
    tree: null,
    commit: null,
    fileCount: 0,
    out: null,
    pushed: null,
  };
  const failures = [];
  const check = (name, ok, details = []) => {
    report.checks.push({ name, ok, details });
    if (!ok) failures.push(name);
  };

  // 1. The source commit.
  if (opts.fetch && opts.commit.startsWith("origin/")) {
    try {
      git(["fetch", "--quiet", "origin", opts.commit.slice("origin/".length)]);
    } catch (error) {
      console.error(`public-copy: git fetch failed (${firstLine(error)}); pass --no-fetch to use the local ${opts.commit}`);
      return 2;
    }
  }
  let sha;
  try {
    sha = git(["rev-parse", "--verify", "--end-of-options", `${opts.commit}^{commit}`]);
  } catch {
    console.error(`public-copy: ${opts.commit} is not a commit of this repository`);
    return 2;
  }
  const committedAt = git(["show", "-s", "--format=%cI", sha]);
  report.source = { ref: opts.commit, sha, committedAt };

  // 2. Export the tree, and nothing else: no history, no ignored or untracked files.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "every-app-public-"));
  const tree = path.join(tmp, "tree");
  fs.mkdirSync(tree);
  try {
    const tar = path.join(tmp, "tree.tar");
    git(["archive", "--format=tar", "-o", tar, sha]);
    execFileSync("tar", ["-xf", tar, "-C", tree], { stdio: "inherit" });
    fs.rmSync(tar);
    const exported = walk(tree);

    // 3. The private names: a file the copy leaves out. Absent in the public
    //    repository itself, where the dry run only guards against regressions.
    const privateNames = loadPrivateNames(path.join(POLICY_DIR, "private.txt"));
    report.privateNames = privateNames ? privateNames.length : 0;

    // 4. The deny list, on everything the commit holds, before any exclusion:
    //    a credential file never leaves silently.
    const denied = deniedNames(exported);
    check("no file on the deny list (1k, accounts.json, providers.env, .dev.vars, *.pem, …)", denied.length === 0, denied);

    // 5. Exclusions.
    const excludeRules = [...policy.exclude];
    if (opts.todo === "replace") excludeRules.push({ pattern: /^TODO\.md$/, why: "replaced by the public TODO (--todo replace)" });
    if (opts.design === "designs") excludeRules.push({ pattern: /^docs\/design\/.*research.*\.md$/, why: "research synthesis, not a design (--design designs)" });
    if (opts.design === "none") excludeRules.push({ pattern: /^docs\/design\//, why: "--design none" });
    if (opts.logs === "drop") {
      excludeRules.push({
        pattern: /^docs\/(launch|simplify)-\d{4}-\d{2}-\d{2}\.md$/,
        why: "dated operations logs of the maintainers' own account and gateway (--logs drop)",
      });
    }
    let files = exported;
    for (const rule of excludeRules) {
      const hit = files.filter((file) => rule.pattern.test(file));
      for (const file of hit) fs.rmSync(path.join(tree, file));
      report.excluded.push({ pattern: rule.pattern.source, why: rule.why, files: hit });
      files = files.filter((file) => !hit.includes(file));
    }
    removeEmptyDirs(tree);
    check(
      "the private-names file does not travel",
      !files.includes(PRIVATE_FILE),
      files.includes(PRIVATE_FILE) ? [`${PRIVATE_FILE} is still in the tree: add it to policy.exclude`] : [],
    );

    // 6. Replacements and scrubs.
    if (opts.todo === "replace") {
      fs.copyFileSync(path.join(POLICY_DIR, "TODO.public.md"), path.join(tree, "TODO.md"));
      files.push("TODO.md");
      files.sort();
      report.replaced.push({ file: "TODO.md", from: "scripts/public-copy/TODO.public.md" });
    }
    const scrubRules = [...policy.scrub, ...(privateNames ?? [])];
    for (const file of files) {
      if (!policy.scrubFiles.test(file)) continue;
      const full = path.join(tree, file);
      const before = fs.readFileSync(full, "utf8");
      const { text: after, applied } = scrub(before, scrubRules);
      if (after !== before) {
        fs.writeFileSync(full, after);
        report.scrubbed.push({ file, applied });
      }
    }

    // 7. A citation of a document the copy leaves out becomes plain text: the
    //    drift test in the copy (every cited path exists) keeps passing, and
    //    the name stays readable where it was.
    const dropped = report.excluded.flatMap((rule) => rule.files).filter((file) => /\.mdx?$/.test(file));
    for (const file of files) {
      if (!/\.(md|mdx)$/.test(file)) continue;
      const full = path.join(tree, file);
      const before = fs.readFileSync(full, "utf8");
      const { text: after, count } = plainCitations(before, dropped);
      if (count > 0) {
        fs.writeFileSync(full, after);
        report.citations.push({ file, count });
      }
    }

    // 8. Checks.
    const license = path.join(tree, "LICENSE");
    const licenseOk = fs.existsSync(license) && /MIT License/.test(fs.readFileSync(license, "utf8"));
    check("LICENSE is present and MIT", licenseOk, licenseOk ? [] : ["add LICENSE at the root of main before copying"]);

    const readme = fs.existsSync(path.join(tree, "README.md")) ? fs.readFileSync(path.join(tree, "README.md"), "utf8") : "";
    const readmeProblems = [];
    if (!readme.includes(policy.publicCloneUrl)) readmeProblems.push(`README.md doesn't give the public clone URL ${policy.publicCloneUrl}`);
    if (!/https:\/\/everyapp\.com\b/.test(readme)) readmeProblems.push("README.md doesn't link https://everyapp.com");
    for (const link of readme.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      if (policy.refusedLink.test(link[1])) readmeProblems.push(`README.md links ${link[1]}`);
    }
    check("README gives the public clone URL and everyapp.com, and links no private repository", readmeProblems.length === 0, readmeProblems);

    const notText = files.filter((file) => policy.textFiles.test(file) && isBinary(fs.readFileSync(path.join(tree, file))));
    check("every text file reads as text (nothing hides in a binary-looking one)", notText.length === 0, notText);

    const leaks = contentLeaks(tree, files, contentRules(privateNames));
    check("no secret shapes or private names in the tree", leaks.length === 0, leaks);

    if (opts.scan) {
      const result = scan(tree, tmp);
      if (result.error) {
        console.error(`public-copy: ${result.error}`);
        return 2;
      }
      check("gitleaks finds nothing in the copy", result.findings.length === 0, result.findings);
    }

    // 9. The one commit. Dated as the source commit, authored as Every App,
    //    with nothing of the source but its sha in the message: the same
    //    tree always gives the same commit hash.
    const env = copyEnv(committedAt);
    git(["init", "--quiet", "--initial-branch=main"], { cwd: tree, env });
    git(["add", "--all", "--force", "."], { cwd: tree, env });
    const message = [
      `EveryApp at ${committedAt.slice(0, 10)}`,
      "",
      "The public copy of the maintainers' main branch, as one commit.",
      `Source commit ${sha.slice(0, 12)}.`,
      "",
      `${MARKER} (--todo ${opts.todo}, --design ${opts.design}, --logs ${opts.logs}).`,
    ].join("\n");
    git(["commit", "--quiet", "--no-verify", "-m", message], { cwd: tree, env });
    report.tree = git(["rev-parse", "HEAD^{tree}"], { cwd: tree, env });
    report.commit = git(["rev-parse", "HEAD"], { cwd: tree, env });
    const committed = git(["ls-files"], { cwd: tree, env }).split("\n").filter(Boolean);
    report.fileCount = committed.length;
    const uncommitted = files.filter((file) => !committed.includes(file));
    check("every file of the copy is in its commit", uncommitted.length === 0, uncommitted);

    // 10. Keep it, push it.
    if (failures.length > 0) {
      print(report, opts, failures);
      return 1;
    }
    if (opts.write) {
      const out = outDir(opts);
      if (fs.existsSync(out)) {
        if (!existingCopy(out)) {
          console.error(`public-copy: ${out} exists and is not an earlier copy of this script; remove it or pass --out`);
          return 2;
        }
        fs.rmSync(out, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.cpSync(tree, out, { recursive: true, verbatimSymlinks: true });
      report.out = out;
      const written = git(["rev-parse", "HEAD"], { cwd: out, env });
      if (written !== report.commit) {
        console.error(`public-copy: the copy written to ${out} is ${written}, not ${report.commit}`);
        return 2;
      }
    }
    if (opts.push !== undefined) {
      const out = report.out;
      const ok = await confirm(
        `About to push ${report.commit.slice(0, 12)} (tree ${report.tree.slice(0, 12)}, ${report.fileCount} files, from ${out}) to ${opts.push} as main, with --force: whatever that remote has on main is replaced. Type push to continue: `,
        "push",
      );
      if (!ok) {
        console.error("public-copy: not pushed");
        print(report, opts, failures);
        return 1;
      }
      git(["push", "--force", opts.push, "HEAD:refs/heads/main"], { cwd: out, env });
      report.pushed = { remote: opts.push, commit: report.commit };
    }
    print(report, opts, failures);
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The files of the export whose base name is on the deny list. */
function deniedNames(files) {
  const denied = [];
  for (const file of files) {
    const base = path.posix.basename(file);
    for (const rule of policy.denyNames) {
      if (rule.pattern.test(base) && !(rule.allow && rule.allow.test(base))) denied.push(`${file}: ${rule.why}`);
    }
  }
  return denied;
}

/** The content rules: the generic secret shapes, plus the private names as strict rules. */
function contentRules(privateNames) {
  return [
    ...policy.denyContent,
    ...(privateNames ?? []).map((rule) => ({
      name: `private name: ${rule.why}`,
      pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")),
      strict: true,
    })),
  ];
}

/** `file:line: rule: match` for every text file of `files` a content rule matches. */
function contentLeaks(tree, files, rules) {
  const leaks = [];
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(tree, file));
    if (isBinary(buffer)) continue;
    const text = buffer.toString("utf8");
    for (const rule of rules) {
      if (rule.allowFiles && rule.allowFiles.test(file)) continue;
      const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
      const pattern = new RegExp(rule.pattern.source, flags);
      let match;
      let seen = 0;
      while ((match = pattern.exec(text)) !== null && seen < 5) {
        if (match[0].length === 0) pattern.lastIndex += 1;
        if (rule.allowMatch && rule.allowMatch.test(match[0])) continue;
        if (!rule.strict && policy.obviousFake.test(match[0])) continue;
        seen += 1;
        const line = text.slice(0, match.index).split("\n").length;
        leaks.push(`${file}:${line}: ${rule.name}: ${redact(match[0])}`);
      }
    }
  }
  return leaks;
}

/** `text` with every scrub rule applied; `applied` counts the real replacements per rule. */
function scrub(text, rules) {
  const applied = [];
  for (const rule of rules) {
    let count = 0;
    text = text.replace(rule.pattern, (...match) => {
      const whole = match[0];
      if (rule.keep && rule.keep.test(whole)) return whole;
      count += 1;
      // "$1" in the replacement is the first group, as String.replace reads it.
      return rule.replace.replace(/\$(\d)/g, (_, n) => (typeof match[Number(n)] === "string" ? match[Number(n)] : ""));
    });
    if (count > 0) applied.push({ rule: rule.why ?? rule.pattern.source, count });
  }
  return { text, applied };
}

/**
 * Citations of the dropped documents, as plain text: a Markdown link keeps
 * its text, a backticked path loses the backticks, and inside a fenced code
 * block (whose tokens the drift test reads as paths) the directory goes and
 * the file name stays.
 */
function plainCitations(text, dropped) {
  let count = 0;
  for (const gone of dropped) {
    const base = escapeRegExp(path.posix.basename(gone));
    text = text.replace(new RegExp(`\\[([^\\]]*)\\]\\((?:[^)\\s]*/)?${base}(?:#[^)]*)?\\)`, "g"), (_, link) => {
      count += 1;
      return link;
    });
    text = text.replace(new RegExp("`((?:[^`\\s]*/)?" + base + ")(?:#[^`]*)?`", "g"), (_, span) => {
      count += 1;
      return span;
    });
    let inCode = false;
    text = text
      .split("\n")
      .map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inCode = !inCode;
          return line;
        }
        if (!inCode) return line;
        return line.replace(new RegExp(`(^|[\\s"'(])(?:[^\\s"'()]*/)${base}(?=$|[\\s"'):,;])`, "g"), (_, lead) => {
          count += 1;
          return `${lead}${path.posix.basename(gone)}`;
        });
      })
      .join("\n");
  }
  return { text, count };
}

/** Every regular file (and symlink) under `dir`, repository-relative, sorted. */
function walk(dir) {
  const out = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  visit("");
  return out.sort();
}

function removeEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    removeEmptyDirs(child);
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** The first 4 characters of a match, then its length: never the value. */
function redact(text) {
  const flat = text.replace(/\s+/g, " ");
  return `${flat.slice(0, 4)}… (${flat.length} chars)`;
}

function firstLine(error) {
  return String(error?.stderr || error?.message || error).split("\n")[0];
}

async function confirm(question, word) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return answer.trim() === word;
  } finally {
    rl.close();
  }
}

/** gitleaks over the copy, with the repository's rules; findings as `file:line rule`. */
function scan(tree, tmp) {
  const gitleaks = process.env["GITLEAKS"] || which("gitleaks");
  if (!gitleaks) return { error: "--scan needs gitleaks on PATH or in $GITLEAKS (https://github.com/gitleaks/gitleaks/releases)" };
  const reportPath = path.join(tmp, "gitleaks.json");
  const result = spawnSync(
    gitleaks,
    [
      "dir",
      tree,
      "--config",
      path.join(POLICY_DIR, "gitleaks.toml"),
      "--no-banner",
      "--redact=90",
      "--exit-code",
      "3",
      "--report-format",
      "json",
      "--report-path",
      reportPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 3) {
    return { error: `gitleaks failed: ${(result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ")}` };
  }
  const findings = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : [];
  return {
    findings: findings.map((f) => `${path.relative(tree, f.File)}:${f.StartLine} ${f.RuleID}`),
  };
}

function which(name) {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * --self-test: a small tree holding one file per deny-listed name and one
 * string per secret shape the generic rules know, with values that no
 * allowlist excuses; every one of them must be refused, and a clean file
 * must pass. The private names are not part of it (the public repository
 * has no list of them), so this proves the generic checks, not the list. A
 * made-up private-name rule with a wildcard tail (`every-acme-*`, the shape
 * TODO.md uses for a family of Workers) proves the rule file's shape: the
 * loader accepts it, the scrub rewrites the wildcard form and its backticks,
 * and the deny pass refuses it.
 */
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "every-app-public-selftest-"));
  const tree = path.join(tmp, "tree");
  const random = (n) => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < n; i += 1) out += alphabet[(i * 7919 + 13 * n) % alphabet.length];
    return out;
  };
  const names = ["1k", "accounts.json", "providers.env", ".dev.vars", ".dev.vars.staging", ".env", "id_rsa", "secrets.env", "keys/x.pem", "ops/.npmrc"];
  const shapes = {
    "a Cloudflare account API token": `cfat_${random(48)}`,
    "a Cloudflare API token beside the word token": `"token": "${random(40)}"`,
    "an Anthropic key": `sk-ant-api03-${random(60)}`,
    "an OpenAI or OpenRouter key": `sk-or-v1-${random(64)}`,
    "a GitHub token": `ghp_${random(36)}`,
    "a Slack token": `xoxb-${random(24)}`,
    // Built from parts, so this file never contains the shapes it refuses.
    "an AWS access key id": ["AKIA", "JQ3M2V7N5X4KPLZW"].join(""),
    "a private key block": `-----BEGIN PRIVATE KEY-----\n${random(64)}\n${random(64)}\n-----END PRIVATE KEY-----`,
    "a Better Auth secret value": `BETTER_AUTH_SECRET=${random(44)}`,
    "a setup link token": `est_${random(43)}`,
    "a link into a private GitHub repository": ["https://github.com/acme/", "private-thing/blob/main/x.md"].join(""),
    "a T3 thread link": ["t3-thread", "://v1/0123"].join(""),
    "the maintainer's home directory": ["/Users/", "bensenescu/x"].join(""),
  };
  try {
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
      fs.writeFileSync(path.join(tree, name), "x\n");
    }
    fs.mkdirSync(path.join(tree, "docs"), { recursive: true });
    for (const [rule, value] of Object.entries(shapes)) {
      fs.writeFileSync(path.join(tree, "docs", `${rule.replace(/[^a-z]+/gi, "-")}.md`), `# ${rule}\n\n${value}\n`);
    }
    fs.writeFileSync(path.join(tree, "docs", "clean.md"), "# Clean\n\nNothing to see: support@everyapp.dev, a D1 id 11111111-2222-4333-8444-555555555555.\n");
    fs.writeFileSync(path.join(tree, "docs", "wildcard.md"), "# Wildcard\n\nNot `every-acme-openseo` or the `every-acme-*` Workers.\n");
    const files = walk(tree);
    const denied = deniedNames(files);
    const leaks = contentLeaks(tree, files, contentRules(null));
    const problems = [];
    for (const name of names) {
      if (!denied.some((d) => d.startsWith(`${name}:`))) problems.push(`deny list missed ${name}`);
    }
    for (const rule of Object.keys(shapes)) {
      if (!leaks.some((l) => l.includes(`: ${rule}:`))) problems.push(`content check missed ${rule}`);
    }
    if (leaks.some((l) => l.startsWith("docs/clean.md"))) problems.push("content check flagged the clean file");
    const scrubbed = scrub("Mail me@somewhere.example or ben@hi.somewhere.net or git@github.com:x/y.git.", policy.scrub).text;
    if (!/me@somewhere\.example/.test(scrubbed) || !/git@github\.com:x\/y\.git/.test(scrubbed) || /ben@hi\.somewhere\.net/.test(scrubbed)) {
      problems.push(`e-mail scrub wrong: ${scrubbed}`);
    }
    // A private-name rule in private.txt's shape, with a wildcard in the class:
    // `every-acme-*` and `every-acme-openseo` both go, backticks included, and
    // the deny pass refuses the file that still holds them.
    const rulesFile = path.join(tmp, "private.txt");
    fs.writeFileSync(rulesFile, "# made up\n/`?every-acme-[a-z0-9*-]+`?/g\ta Worker of the test account\ta Worker of the test account\n");
    const wildcardRules = loadPrivateNames(rulesFile);
    const wildcard = scrub(fs.readFileSync(path.join(tree, "docs", "wildcard.md"), "utf8"), wildcardRules).text;
    if (/every-acme|`/.test(wildcard)) problems.push(`wildcard private-name scrub wrong: ${JSON.stringify(wildcard)}`);
    const wildcardLeaks = contentLeaks(tree, files, contentRules(wildcardRules)).filter((l) => l.startsWith("docs/wildcard.md:"));
    if (wildcardLeaks.length !== 2) problems.push(`wildcard private-name deny wrong: ${JSON.stringify(wildcardLeaks)}`);
    const plain = plainCitations("See [the log](../docs/launch-2026-10-27.md) and `docs/launch-2026-10-27.md`.\n```\ncat docs/launch-2026-10-27.md\n```\n", ["docs/launch-2026-10-27.md"]);
    if (plain.count !== 3 || /\[the log\]|`docs\/launch|cat docs\//.test(plain.text)) problems.push(`citation rewrite wrong: ${JSON.stringify(plain)}`);
    console.log(`self-test: ${names.length} deny-listed names refused, ${Object.keys(shapes).length} secret shapes refused, the clean file passed, a wildcard private-name rule scrubbed and refused${problems.length ? "" : "."}`);
    for (const problem of problems) console.log(`  FAIL ${problem}`);
    return problems.length ? 1 : 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function print(report, opts, failures) {
  if (opts.json) {
    console.log(JSON.stringify({ ...report, failures, dryRun: !opts.write }, null, 2));
    return;
  }
  const lines = [];
  const { source } = report;
  lines.push(`Public copy of ${source.ref} (${source.sha.slice(0, 12)}, ${source.committedAt})`);
  lines.push("");
  lines.push("Left out:");
  for (const rule of report.excluded) {
    lines.push(`  ${rule.files.length.toString().padStart(3)}  ${rule.why}`);
    for (const file of rule.files.slice(0, 8)) lines.push(`         ${file}`);
    if (rule.files.length > 8) lines.push(`         … ${rule.files.length - 8} more`);
  }
  if (report.replaced.length) {
    lines.push("Replaced:");
    for (const r of report.replaced) lines.push(`  ${r.file} ← ${r.from}`);
  }
  lines.push(`Scrubbed (${report.privateNames} private-name rules${report.privateNames ? "" : `: ${PRIVATE_FILE} is absent`}):`);
  if (report.scrubbed.length === 0) lines.push("  nothing to scrub");
  for (const s of report.scrubbed) {
    lines.push(`  ${s.file}: ${s.applied.map((a) => `${a.count}× ${a.rule}`).join(", ")}`);
  }
  if (report.citations.length) {
    lines.push("Citations of a document left out, now plain text:");
    for (const c of report.citations) lines.push(`  ${c.file}: ${c.count}`);
  }
  lines.push("Checks:");
  for (const c of report.checks) {
    lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
    for (const d of c.details.slice(0, 30)) lines.push(`         ${d}`);
    if (c.details.length > 30) lines.push(`         … ${c.details.length - 30} more`);
  }
  lines.push("");
  lines.push(`Tree   ${report.tree}  (${report.fileCount} files)`);
  lines.push(`Commit ${report.commit}`);
  if (failures.length) {
    lines.push("");
    lines.push(`${failures.length} check(s) failed; nothing written.`);
  } else if (report.out) {
    lines.push(`Written to ${report.out}`);
  } else {
    lines.push("Dry run: nothing written. Add --write to keep the repository.");
  }
  if (report.pushed) lines.push(`Pushed ${report.pushed.commit.slice(0, 12)} to ${report.pushed.remote} main.`);
  console.log(lines.join("\n"));
}

process.exitCode = await main();
