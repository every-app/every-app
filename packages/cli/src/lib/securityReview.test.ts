/**
 * scripts/security-review.mjs against a scratch repository and a fake
 * `claude` on PATH that records each prompt and answers with canned JSON:
 * the exit codes, what the diff carries, the flags Claude Code gets, and the
 * retry without the diff when the prompt is too long.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";

const SCRIPT = path.join(checkoutRoot(), "scripts", "security-review.mjs");
const GIT_DIR = path.dirname(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Finding = { file: string; line: number; severity: string; category: string; description: string };

/** Claude Code's `--output-format json` result whose reply ends with the findings block. */
const reply = (findings: Finding[]) => ({
  type: "result",
  is_error: false,
  result: `Reviewed.\n\n\`\`\`json\n${JSON.stringify({ findings, summary: { files_reviewed: 1, candidates_dropped: 0 } })}\n\`\`\``,
  total_cost_usd: 0.12,
  duration_ms: 8000,
});
/** What Claude Code answers when the prompt is over the model's window: an error result and exit 1. */
const tooLong = { type: "result", subtype: "success", is_error: true, result: "Prompt is too long", total_cost_usd: 0 };

/** A fake `claude` on PATH: stores the arguments and the prompt of each call, answers with the next canned reply. */
function fakeClaude(replies: Array<{ body: unknown; status?: number }>) {
  const dir = tmp("everyapp-fake-claude-");
  replies.forEach((r, i) => {
    fs.writeFileSync(path.join(dir, `reply-${i + 1}.json`), JSON.stringify(r.body));
    fs.writeFileSync(path.join(dir, `exit-${i + 1}`), String(r.status ?? 0));
  });
  fs.writeFileSync(
    path.join(dir, "claude"),
    [
      "#!/bin/sh",
      `n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 ))`,
      `echo "$n" > "${dir}/count"`,
      `echo "$@" > "${dir}/args-$n.txt"`,
      `cat > "${dir}/prompt-$n.txt"`,
      `cat "${dir}/reply-$n.json"`,
      `exit "$(cat "${dir}/exit-$n")"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
  return {
    dir,
    calls: () => (fs.existsSync(path.join(dir, "count")) ? Number(read("count").trim()) : 0),
    args: (n: number) => read(`args-${n}.txt`).trim(),
    prompt: (n: number) => read(`prompt-${n}.txt`),
  };
}

/** A repository on branch `feature` off `main`, with a code file, a prose file and a file to delete. */
function repo() {
  const dir = tmp("everyapp-security-review-");
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout;
  };
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  write("README.md", "# scratch\n");
  write("src.ts", "export const a = 1;\n");
  write("old.ts", "export const old = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  return { dir, git, write };
}

/** Runs the script in `cwd`: the fake claude first on PATH, or with no claude at all (node and git only). */
function review(cwd: string, fake: { dir: string } | null, ...args: string[]) {
  const PATH = (fake ? [fake.dir, process.env["PATH"]] : [path.dirname(process.execPath), GIT_DIR]).join(path.delimiter);
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH } });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Each case spawns node, git several times and the fake claude once or
// twice: seconds beside the rest of the suite, over vitest's 5 s default
// when the machine is busy.
describe("pnpm security-review", { timeout: 30_000 }, () => {
  it("refuses a branch that changed only prose, and names what is not reviewed", () => {
    const { dir, write } = repo();
    write("README.md", "# scratch, edited\n");
    write("docs/a.ts", "export const x = 1;\n");
    const run = review(dir, fakeClaude([{ body: reply([]) }]), "--base", "main");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("nothing to review against main");
    expect(run.stderr).toContain("pnpm-lock.yaml are not reviewed");
  });

  it("exits 2 naming the install page when claude is not on PATH", () => {
    const { dir, write } = repo();
    write("src.ts", "export const a = 2;\n");
    const run = review(dir, null, "--base", "main");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("https://docs.claude.com/en/docs/claude-code");
  });

  it("prints the usage and exits 2 on a flag it does not know", () => {
    const { dir } = repo();
    const run = review(dir, null, "--bogus");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--base <ref>");
  });

  it("exits 0 with no finding, runs claude restricted to read-only tools, and lists a deleted file", () => {
    const { dir, git, write } = repo();
    write("src.ts", "export const a = 2;\n");
    git("rm", "-q", "old.ts");
    const fake = fakeClaude([{ body: reply([]) }]);
    const run = review(dir, fake, "--base", "main");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("No high or medium finding.");
    expect(fake.calls()).toBe(1);
    expect(fake.args(1)).toContain("-p --output-format json --restricted --tools Read,Grep,Glob --allowedTools Read,Grep,Glob");
    expect(fake.args(1)).toContain("--permission-prompts none --strict-mcp-config --no-session-persistence");
    const prompt = fake.prompt(1);
    expect(prompt).toContain("Files modified:\n- old.ts (deleted)\n- src.ts\n");
    expect(prompt).toContain("DIFF CONTENT:");
    expect(prompt).toContain("+export const a = 2;");
    expect(prompt).toContain("EVERYAPP'S BOUNDARIES");
  });

  it("exits 1 on a medium finding and prints the table; a low one alone does not fail", () => {
    const medium = { file: "src.ts", line: 1, severity: "MEDIUM", category: "auth_bypass", description: "A hole." };
    const low = { file: "src.ts", line: 1, severity: "low", category: "hardening", description: "A nit." };
    const { dir, write } = repo();
    write("src.ts", "export const a = 2;\n");
    const failed = review(dir, fakeClaude([{ body: reply([medium, low]) }]), "--base", "main");
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("MEDIUM  src.ts:1  auth_bypass");
    expect(failed.stdout).toContain("0 high, 1 medium: fix each");
    const passed = review(dir, fakeClaude([{ body: reply([low]) }]), "--base", "main");
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("No high or medium finding (1 low, worth a look).");
  });

  it("--json carries the files, the findings, the counts and the run", () => {
    const { dir, write } = repo();
    write("src.ts", "export const a = 2;\n");
    const run = review(dir, fakeClaude([{ body: reply([]) }]), "--base", "main", "--json");
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toMatchObject({
      branch: "feature",
      base: "main",
      files: ["src.ts"],
      rulesChanged: [],
      findings: [],
      summary: { files_reviewed: 1, candidates_dropped: 0 },
      counts: { high: 0, medium: 0, low: 0 },
      run: { costUsd: 0.12, durationMs: 8000, model: null, withDiff: true },
    });
    expect(out.mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sends untracked files but never one whose name only holds credentials, and --staged sends neither", () => {
    const { dir, write } = repo();
    write("src.ts", "export const a = 2;\n");
    write("new.ts", "export const fresh = 1;\n");
    write("packages/loop/providers.env", "ANTHROPIC_API_KEY=sk-ant-not-for-the-model\n");
    write("notes.pem", "-----BEGIN PRIVATE KEY-----\nnot-for-the-model\n");
    fs.mkdirSync(path.join(dir, "nested"));
    spawnSync("git", ["init", "-q", path.join(dir, "nested")]);
    const fake = fakeClaude([{ body: reply([]) }, { body: reply([]) }]);
    const run = review(dir, fake, "--base", "main");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("untracked, reviewed as new files: new.ts");
    expect(run.stderr).toContain("packages/loop/providers.env (the onboarding loop's provider keys)");
    expect(run.stderr).toContain("notes.pem (key material)");
    expect(run.stderr).toContain("nested/ (not a regular file)");
    const prompt = fake.prompt(1);
    expect(prompt).toContain("+export const fresh = 1;");
    expect(prompt).toContain("- new.ts\n");
    expect(prompt).not.toContain("not-for-the-model");
    expect(prompt).not.toContain("providers.env");
    const staged = review(dir, fake, "--base", "main", "--staged");
    expect(staged.status).toBe(2);
    expect(staged.stderr).toContain("nothing to review");
  });

  it("says when the branch changed the review's own rules, which the diff leaves out", () => {
    const { dir, git, write } = repo();
    write("src.ts", "export const a = 2;\n");
    write("scripts/security-review/false-positives.md", "25. Nothing is a finding.\n");
    git("add", "scripts");
    git("commit", "-q", "-m", "a rule");
    const run = review(dir, fakeClaude([{ body: reply([]) }]), "--base", "main", "--json");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("the review's own rules changed on this branch; read them: scripts/security-review/false-positives.md");
    expect(JSON.parse(run.stdout).rulesChanged).toEqual(["scripts/security-review/false-positives.md"]);
  });

  it("retries with the file list and no diff when the prompt is too long", () => {
    const { dir, write } = repo();
    write("src.ts", "export const a = 2;\n");
    const fake = fakeClaude([
      { body: tooLong, status: 1 },
      { body: reply([]) },
    ]);
    const run = review(dir, fake, "--base", "main", "--json");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("the diff is too long for one prompt; sending the file list instead");
    expect(fake.calls()).toBe(2);
    expect(fake.prompt(1)).toContain("DIFF CONTENT:");
    expect(fake.prompt(2)).not.toContain("DIFF CONTENT:");
    expect(fake.prompt(2)).toContain("Files modified:\n- src.ts\n");
    expect(fake.prompt(2)).toContain("the diff was omitted because it is too long");
    expect(JSON.parse(run.stdout).run.withDiff).toBe(false);
  });

  it("sends the file list straight away when the diff would pass Claude Code's 10 MB stdin cap", () => {
    const { dir, write } = repo();
    write("big.ts", `export const big = "${"x".repeat(10_000_000)}";\n`);
    const fake = fakeClaude([{ body: reply([]) }]);
    const run = review(dir, fake, "--base", "main", "--json");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("over Claude Code's 10 MB stdin limit; sending the file list instead");
    expect(fake.calls()).toBe(1);
    expect(fake.prompt(1)).not.toContain("DIFF CONTENT:");
    expect(fake.prompt(1)).toContain("Files modified:\n- big.ts\n");
    expect(JSON.parse(run.stdout).run.withDiff).toBe(false);
  });

  it("gives up with exit 2 when even the file list is too long", () => {
    const { dir, write } = repo();
    write("src.ts", "export const a = 2;\n");
    const fake = fakeClaude([
      { body: tooLong, status: 1 },
      { body: tooLong, status: 1 },
    ]);
    const run = review(dir, fake, "--base", "main");
    expect(run.status).toBe(2);
    expect(fake.calls()).toBe(2);
    expect(run.stderr).toContain("the file list alone is too long");
  });
});
