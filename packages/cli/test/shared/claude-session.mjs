/**
 * One `claude -p` session the harnesses drive: stream-json in and out,
 * kept alive on stdin between the person's turns. Every event lands in
 * `<runDir>/events.jsonl`; the run log collects the init event, each
 * assistant message's text, every tool call (`log.toolUses`: sequence,
 * time, tool, a trimmed input) and, for convenience, every Bash command
 * (`log.bashCommands`). Spawned asynchronously: with `--input-format
 * stream-json` the process waits for the next user line, so a spawnSync
 * would never return.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/** A tool input kept for the report: paths and commands whole, long strings cut. */
function trimInput(input) {
  const kept = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") kept[key] = key === "file_path" || key === "path" || value.length <= 400 ? value : `${value.slice(0, 400)}…(${value.length} chars)`;
    else if (Array.isArray(value)) kept[key] = `[${value.length} items]`;
    else if (value && typeof value === "object") kept[key] = "{…}";
    else kept[key] = value;
  }
  return kept;
}

/**
 * Starts claude in `cwd`. `options`: model, maxTurns, fullSettings (keep
 * the user's settings, plugins and MCP servers), pathPrepend (a directory
 * of stubs put first on PATH). Returns { send(text), nextResult(timeoutMs),
 * close() }; `nextResult` resolves with { text, allText, result } for the
 * next `result` event, or null on a timeout or exit.
 */
export function startClaude({ cwd, runDir, log, model, maxTurns, fullSettings = false, pathPrepend = null }) {
  const env = { ...process.env, PATH: `${pathPrepend ? `${pathPrepend}:` : ""}${process.env["PATH"] ?? ""}` };
  // A nested session is refused while these say one is running.
  delete env["CLAUDECODE"];
  delete env["CLAUDE_CODE_ENTRYPOINT"];
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns", String(maxTurns),
    "--model", model,
    ...(fullSettings
      ? []
      : ["--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
  ];
  fs.writeFileSync(path.join(runDir, "claude-args.txt"), `cwd ${cwd}\nclaude ${args.map((a) => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = fs.createWriteStream(path.join(runDir, "events.jsonl"));
  const stderr = fs.createWriteStream(path.join(runDir, "claude-stderr.log"));
  child.stderr.on("data", (chunk) => stderr.write(chunk));
  log.toolUses ??= [];
  log.bashCommands ??= [];
  log.assistantText ??= [];

  let waiting = null;
  let turnTexts = [];
  let lastMessageTexts = [];
  let exited = null;
  let seq = 0;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    if (waiting) {
      waiting.resolve(null);
      waiting = null;
    }
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    events.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "system" && event.subtype === "init") {
      log.init = { model: event.model, skills: event.skills, cwd: event.cwd, permissionMode: event.permissionMode };
      return;
    }
    if (event.type === "assistant") {
      const content = event.message?.content ?? [];
      const texts = content.filter((block) => block.type === "text").map((block) => block.text);
      if (texts.length) {
        lastMessageTexts = texts;
        turnTexts.push(...texts);
      }
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const ts = new Date().toISOString();
        log.toolUses.push({ seq: ++seq, ts, name: block.name, input: trimInput(block.input) });
        if (block.name === "Bash") {
          log.bashCommands.push({ ts, command: block.input?.command ?? "", description: block.input?.description ?? "" });
        }
      }
      return;
    }
    if (event.type === "result") {
      const text = lastMessageTexts.length ? lastMessageTexts.join("\n") : typeof event.result === "string" ? event.result : "";
      log.assistantText.push(text);
      const turn = { text, allText: turnTexts.join("\n"), result: event };
      turnTexts = [];
      lastMessageTexts = [];
      if (waiting) {
        waiting.resolve(turn);
        waiting = null;
      }
    }
  });

  return {
    send(text) {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    },
    nextResult(timeoutMs) {
      if (exited) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting = null;
          resolve(null);
        }, timeoutMs);
        waiting = { resolve: (turn) => { clearTimeout(timer); resolve(turn); } };
      });
    },
    async close() {
      if (!exited) child.stdin.end();
      await new Promise((resolve) => {
        if (exited) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, 20_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      events.end();
      stderr.end();
    },
  };
}
