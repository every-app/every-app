/**
 * Claude Code (design 4.4 row 2). Turn 1 is `claude -p … --output-format
 * stream-json` reading the prompt from stdin; turn end is process exit; the
 * stream is one JSON object per line: `system` (init carries session_id and
 * model), `assistant` (content blocks: text, tool_use), `user` (tool_result
 * blocks), `result` (total_cost_usd, usage, permission_denials, is_error).
 * Several `result` events per process are normal. Mode `defaults` resumes
 * with `--resume <session_id>`; mode `raised` is a long-lived
 * `--input-format stream-json` process and is built by the driver, not here.
 *
 * Shapes checked against /tmp/ea-loop/harness-probe/claude/out2.jsonl
 * (2.1.309, 2026-10-23).
 */
import type {
  HarnessAdapter,
  HarnessCommand,
  HarnessLaunch,
  NormalizedEvent,
} from "../types";
import {
  contentText,
  event,
  isRecord,
  num,
  parseJsonLine,
  splitCommand,
  str,
} from "./shared";

const CLAUDE_VERSION = "2.1.309";
const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
const CLAUDE_MAX_BUDGET_USD = 15;

/** The strings Claude Code prints when its Bash tool times out (hesitation kinds moved_to_background and background_killed). */
export const CLAUDE_BACKGROUND_MOVED =
  /Command did not complete within its \d+s timeout and was moved to the background/;
export const CLAUDE_BACKGROUND_KILLED =
  /background (task|command|process) .*?(was )?killed|killed after \d+/i;

const ENV = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

function baseArgs(launch: HarnessLaunch): string[] {
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--max-budget-usd",
    String(CLAUDE_MAX_BUDGET_USD),
    "--model",
    launch.model ?? CLAUDE_DEFAULT_MODEL,
  ];
}

function usageTokens(usage: unknown) {
  if (!isRecord(usage)) return undefined;
  const tokens = {
    input: num(usage["input_tokens"]),
    output: num(usage["output_tokens"]),
    cacheRead: num(usage["cache_read_input_tokens"]),
    cacheWrite: num(usage["cache_creation_input_tokens"]),
  };
  return Object.values(tokens).some((v) => v !== undefined)
    ? tokens
    : undefined;
}

export function createClaudeAdapter(): HarnessAdapter {
  return {
    name: "claude",
    version: CLAUDE_VERSION,
    status: "measured",
    providerVar: "ANTHROPIC_API_KEY",
    defaultModel: CLAUDE_DEFAULT_MODEL,
    signal: {
      toolCalls: "full",
      toolOutput: "truncated",
      exitCodes: true,
      cost: "harness",
      resume: "native",
    },
    permissionBypass: true,
    command(launch): HarnessCommand {
      // The prompt comes in on stdin: `claude -p` with no prompt argument reads it.
      return {
        argv: [
          "sh",
          "-c",
          `exec claude -p ${baseArgs(launch).join(" ")} < ${launch.promptPath}`,
        ],
        env: ENV,
      };
    },
    resume(sessionId, replyPath, launch): HarnessCommand | null {
      if (!sessionId) return null;
      return {
        argv: [
          "sh",
          "-c",
          `exec claude -p --resume ${sessionId} ${baseArgs(launch).join(" ")} < ${replyPath}`,
        ],
        env: ENV,
      };
    },
    normalize(line, stream, receivedAt): NormalizedEvent[] {
      if (stream === "stderr") return [];
      const raw = parseJsonLine(line);
      if (!raw) return [];
      const sessionId = str(raw["session_id"]);
      const ts = str(raw["timestamp"]);
      const type = raw["type"];
      if (type === "system") {
        return [];
      }
      if (type === "assistant" && isRecord(raw["message"])) {
        const message = raw["message"];
        const model = str(message["model"]);
        const content = Array.isArray(message["content"])
          ? message["content"]
          : [];
        const out: NormalizedEvent[] = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block["type"] === "text") {
            out.push(
              event("assistant_text", receivedAt, raw, {
                ts,
                sessionId,
                text: str(block["text"]),
                model,
                isError:
                  raw["is_api_error_message"] === true ? true : undefined,
              }),
            );
          } else if (block["type"] === "tool_use") {
            const input = isRecord(block["input"]) ? block["input"] : {};
            const command = str(input["command"]);
            out.push(
              event("tool_call", receivedAt, raw, {
                ts,
                sessionId,
                tool: str(block["name"]),
                argv: command ? splitCommand(command) : undefined,
                text:
                  command ?? str(input["file_path"]) ?? str(input["question"]),
                model,
              }),
            );
          }
        }
        return out;
      }
      if (type === "user" && isRecord(raw["message"])) {
        const content = raw["message"]["content"];
        if (!Array.isArray(content)) return [];
        const out: NormalizedEvent[] = [];
        for (const block of content) {
          if (!isRecord(block) || block["type"] !== "tool_result") continue;
          const text = contentText(block["content"]);
          out.push(
            event("tool_result", receivedAt, raw, {
              ts,
              sessionId,
              text,
              outputChars: text.length,
              isError: block["is_error"] === true,
              truncated:
                /\(output truncated\)|\.\.\. \[\d+ more (lines|chars)\]|output too large/i.test(
                  text,
                )
                  ? true
                  : undefined,
            }),
          );
        }
        return out;
      }
      if (type === "result") {
        return [
          event("result", receivedAt, raw, {
            ts,
            sessionId,
            text: str(raw["result"]),
            isError: raw["is_error"] === true,
            tokens: usageTokens(raw["usage"]),
            costUsd: num(raw["total_cost_usd"]),
            stopReason: str(raw["terminal_reason"]) ?? str(raw["subtype"]),
          }),
        ];
      }
      return [];
    },
    collectPaths: [".claude/projects", ".claude/tool-results"],
    fixture: "fixtures/claude/sample.jsonl",
  };
}
