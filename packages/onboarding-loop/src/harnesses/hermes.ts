/**
 * Hermes Agent (design 4.4 row 6). PROVISIONAL: written from the documented
 * `--format stream-json` shape (system, text, tool_use, tool_result,
 * result), not from a captured sample. Capture `fixtures/hermes/sample.jsonl`
 * with `ANTHROPIC_API_KEY=… hermes chat --oneshot -q "Print the current
 * directory with pwd, then say DONE" --format stream-json --yolo --provider
 * anthropic -m <model>` once the key exists and tighten this file.
 *
 * `tool_result.output` is capped at 5000 characters by Hermes, so the event
 * log, not the stream, is the source for everyapp commands. Tokens, no USD.
 * A `clarify` tool_use is a hesitation: the driver kills the process group
 * and resumes with `-r <session_id>`.
 */
import type { HarnessAdapter, HarnessCommand, NormalizedEvent } from "../types";
import {
  event,
  isRecord,
  num,
  parseJsonLine,
  splitCommand,
  str,
  toIso,
} from "./shared";

const HERMES_DEFAULT_MODEL = "claude-sonnet-5-5";
export const HERMES_TOOL_OUTPUT_CAP = 5000;
/** Hermes's ask-the-user tool; seeing it called is `asked_user`. */
export const HERMES_CLARIFY_TOOL = "clarify";

const ENV = {
  HERMES_YOLO_MODE: "1",
  TERMINAL_TIMEOUT: "1800",
};

function flags(model: string): string {
  return `--oneshot --format stream-json --yolo --provider anthropic -m ${model}`;
}

export function createHermesAdapter(): HarnessAdapter {
  return {
    name: "hermes",
    version: "installer",
    status: "provisional",
    providerVar: "ANTHROPIC_API_KEY",
    defaultModel: HERMES_DEFAULT_MODEL,
    signal: {
      toolCalls: "full",
      toolOutput: "truncated",
      exitCodes: false,
      cost: "tokens_x_list",
      resume: "native",
    },
    permissionBypass: true,
    command(launch): HarnessCommand {
      const model = launch.model ?? HERMES_DEFAULT_MODEL;
      return {
        argv: [
          "sh",
          "-c",
          `exec hermes chat --query-file ${launch.promptPath} ${flags(model)}`,
        ],
        env: ENV,
      };
    },
    resume(sessionId, replyPath, launch): HarnessCommand | null {
      if (!sessionId) return null;
      const model = launch.model ?? HERMES_DEFAULT_MODEL;
      return {
        argv: [
          "sh",
          "-c",
          `exec hermes chat -r ${sessionId} --query-file ${replyPath} ${flags(model)}`,
        ],
        env: ENV,
      };
    },
    normalize(line, stream, receivedAt): NormalizedEvent[] {
      if (stream === "stderr") return [];
      const raw = parseJsonLine(line);
      if (!raw) return [];
      const sessionId = str(raw["session_id"]) ?? str(raw["sessionId"]);
      const ts = toIso(raw["timestamp"]);
      const type = raw["type"];
      if (type === "text") {
        return [
          event("assistant_text", receivedAt, raw, {
            ts,
            sessionId,
            text: str(raw["text"]),
            model: str(raw["model"]),
          }),
        ];
      }
      if (type === "tool_use") {
        const input = isRecord(raw["input"]) ? raw["input"] : {};
        const command = str(input["command"]);
        return [
          event("tool_call", receivedAt, raw, {
            ts,
            sessionId,
            tool: str(raw["name"]) ?? str(raw["tool"]),
            argv: command ? splitCommand(command) : undefined,
            text: command ?? str(input["question"]) ?? str(input["path"]),
          }),
        ];
      }
      if (type === "tool_result") {
        const output = str(raw["output"]) ?? str(raw["content"]) ?? "";
        return [
          event("tool_result", receivedAt, raw, {
            ts,
            sessionId,
            tool: str(raw["name"]) ?? str(raw["tool"]),
            text: output,
            outputChars: output.length,
            truncated:
              output.length >= HERMES_TOOL_OUTPUT_CAP ? true : undefined,
            isError: raw["is_error"] === true ? true : undefined,
          }),
        ];
      }
      if (type === "result") {
        const usage = isRecord(raw["usage"]) ? raw["usage"] : raw;
        return [
          event("result", receivedAt, raw, {
            ts,
            sessionId,
            text: str(raw["result"]) ?? str(raw["text"]),
            isError: raw["is_error"] === true,
            tokens: {
              input: num(usage["input_tokens"]) ?? num(usage["prompt_tokens"]),
              output:
                num(usage["output_tokens"]) ?? num(usage["completion_tokens"]),
              cacheRead: num(usage["cache_read_input_tokens"]),
            },
            stopReason: str(raw["subtype"]) ?? str(raw["stop_reason"]),
          }),
        ];
      }
      return [];
    },
    collectPaths: [],
    fixture: null,
  };
}
