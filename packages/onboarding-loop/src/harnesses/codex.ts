/**
 * Codex CLI (design 4.4 row 3). `codex exec - --json` reads the prompt from
 * stdin and prints JSONL: `thread.started` (thread_id), `turn.started`,
 * `item.started|completed` (agent_message, command_execution with the full
 * aggregated_output and exit_code, reasoning), `turn.completed` with token
 * usage. No timestamps, no USD. Progress and MCP noise go to stderr. Resume
 * is `codex exec resume <thread_id>` with the reply as the prompt argument.
 *
 * Shapes checked against a local probe run (Codex CLI 0.163.0,
 * 2026-10-23).
 */
import type { HarnessAdapter, HarnessCommand, NormalizedEvent } from "../types";
import {
  event,
  isRecord,
  num,
  parseJsonLine,
  splitCommand,
  str,
} from "./shared";

const CODEX_VERSION = "0.163.0";
// Codex CLI 0.163.0's own default (its session log names it when no -m is given); the stream
// never names the model, so this pin must follow the CLI's default, not the design-time one.
const CODEX_DEFAULT_MODEL = "gpt-6.1-sol";

const FLAGS = [
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
];

export function createCodexAdapter(): HarnessAdapter {
  // The thread id arrives once, on the first line; later events carry it.
  let threadId: string | undefined;
  return {
    name: "codex",
    version: CODEX_VERSION,
    status: "measured",
    providerVar: "CODEX_API_KEY",
    defaultModel: CODEX_DEFAULT_MODEL,
    signal: {
      toolCalls: "full",
      toolOutput: "full",
      exitCodes: true,
      cost: "tokens_x_list",
      resume: "native",
    },
    permissionBypass: true,
    command(launch): HarnessCommand {
      const model = launch.model ?? CODEX_DEFAULT_MODEL;
      const lastMessage = `${launch.loopDir ?? "/loop"}/last-message.txt`;
      return {
        argv: [
          "sh",
          "-c",
          `exec codex exec - ${FLAGS.join(" ")} -m ${model} -o ${lastMessage} < ${launch.promptPath}`,
        ],
      };
    },
    resume(sessionId, replyPath): HarnessCommand | null {
      if (!sessionId) return null;
      return {
        argv: [
          "sh",
          "-c",
          `exec codex exec resume ${sessionId} ${FLAGS.join(" ")} "$(cat ${replyPath})"`,
        ],
      };
    },
    normalize(line, stream, receivedAt): NormalizedEvent[] {
      if (stream === "stderr") return [];
      const raw = parseJsonLine(line);
      if (!raw) return [];
      const type = raw["type"];
      if (type === "thread.started") {
        threadId = str(raw["thread_id"]) ?? threadId;
        return [];
      }
      const sessionId = threadId;
      if (
        (type === "item.started" || type === "item.completed") &&
        isRecord(raw["item"])
      ) {
        const item = raw["item"];
        const itemType = item["type"];
        if (itemType === "command_execution") {
          const command = str(item["command"]) ?? "";
          if (type === "item.started") {
            return [
              event("tool_call", receivedAt, raw, {
                sessionId,
                tool: "shell",
                argv: splitCommand(command),
                text: command,
              }),
            ];
          }
          const output = str(item["aggregated_output"]) ?? "";
          const exit = num(item["exit_code"]);
          return [
            event("tool_result", receivedAt, raw, {
              sessionId,
              tool: "shell",
              text: output,
              outputChars: output.length,
              isError: exit !== undefined && exit !== 0,
            }),
          ];
        }
        if (itemType === "agent_message" && type === "item.completed") {
          return [
            event("assistant_text", receivedAt, raw, {
              sessionId,
              text: str(item["text"]),
            }),
          ];
        }
        return [];
      }
      if (type === "turn.completed") {
        const usage = isRecord(raw["usage"]) ? raw["usage"] : {};
        return [
          event("result", receivedAt, raw, {
            sessionId,
            tokens: {
              input: num(usage["input_tokens"]),
              output: num(usage["output_tokens"]),
              cacheRead: num(usage["cached_input_tokens"]),
              cacheWrite: num(usage["cache_write_input_tokens"]),
            },
            stopReason: "turn.completed",
          }),
        ];
      }
      if (type === "turn.failed" || type === "error") {
        return [
          event("result", receivedAt, raw, {
            sessionId,
            isError: true,
            text:
              str(raw["message"]) ??
              str(
                (isRecord(raw["error"]) && raw["error"]["message"]) ||
                  undefined,
              ),
            stopReason: String(type),
          }),
        ];
      }
      return [];
    },
    collectPaths: [".codex/sessions"],
    fixture: "fixtures/codex/sample.jsonl",
  };
}
