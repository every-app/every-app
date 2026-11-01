/**
 * Cursor agent CLI (design 4.4 row 5). PROVISIONAL: written from the
 * documented stream-json shape, not from a captured sample; the shell
 * result shape is undocumented. Capture `fixtures/cursor/sample.jsonl` with
 * `CURSOR_API_KEY=… agent -p --force --trust --sandbox disabled
 * --output-format stream-json --model <id> "Print the current directory
 * with pwd, then say DONE"` and tighten this file against it.
 *
 * Documented lines: `{type:"system",subtype:"init",session_id|chatId,model}`,
 * `{type:"user"|"assistant",message:{content:[{type:"text",text}]}}`,
 * `{type:"tool_call",subtype:"started"|"completed",call_id,tool_call:{…}}`,
 * `{type:"result",subtype,duration_ms,result,session_id}`. No timestamps,
 * tokens or cost, so cost is null with source none.
 */
import type { HarnessAdapter, HarnessCommand, NormalizedEvent } from "../types";
import {
  contentText,
  event,
  isRecord,
  parseJsonLine,
  splitCommand,
  str,
} from "./shared";

const CURSOR_DEFAULT_MODEL = "opus-4.5";

const FLAGS = [
  "-p",
  "--force",
  "--trust",
  "--sandbox",
  "disabled",
  "--output-format",
  "stream-json",
];

/** The first shell-looking command inside a tool_call payload, whatever Cursor names the wrapper (shellToolCall, bash, …). */
function findCommand(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  for (const key of ["command", "cmd"]) {
    const found = str(value[key]);
    if (found) return found;
  }
  for (const inner of Object.values(value)) {
    const found = findCommand(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findOutput(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  for (const key of ["output", "stdout", "result", "content"]) {
    const found = value[key];
    if (typeof found === "string") return found;
  }
  for (const inner of Object.values(value)) {
    const found = findOutput(inner, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function createCursorAdapter(): HarnessAdapter {
  return {
    name: "cursor",
    version: "installer",
    status: "provisional",
    providerVar: "CURSOR_API_KEY",
    defaultModel: CURSOR_DEFAULT_MODEL,
    signal: {
      toolCalls: "full",
      toolOutput: "truncated",
      exitCodes: false,
      cost: "none",
      resume: "native",
    },
    permissionBypass: true,
    command(launch): HarnessCommand {
      const model = launch.model ?? CURSOR_DEFAULT_MODEL;
      return {
        argv: [
          "sh",
          "-c",
          `exec agent ${FLAGS.join(" ")} --model ${model} "$(cat ${launch.promptPath})"`,
        ],
      };
    },
    resume(sessionId, replyPath, launch): HarnessCommand | null {
      if (!sessionId) return null;
      const model = launch.model ?? CURSOR_DEFAULT_MODEL;
      return {
        argv: [
          "sh",
          "-c",
          `exec agent ${FLAGS.join(" ")} --resume ${sessionId} --model ${model} "$(cat ${replyPath})"`,
        ],
      };
    },
    normalize(line, stream, receivedAt): NormalizedEvent[] {
      if (stream === "stderr") return [];
      const raw = parseJsonLine(line);
      if (!raw) return [];
      const sessionId =
        str(raw["session_id"]) ?? str(raw["chatId"]) ?? str(raw["chat_id"]);
      const type = raw["type"];
      if (type === "assistant" && isRecord(raw["message"])) {
        const text = contentText(raw["message"]["content"]);
        return text
          ? [
              event("assistant_text", receivedAt, raw, {
                sessionId,
                text,
                model: str(raw["model"]),
              }),
            ]
          : [];
      }
      if (type === "tool_call") {
        const payload = raw["tool_call"];
        const command = findCommand(payload);
        const tool = isRecord(payload) ? Object.keys(payload)[0] : undefined;
        if (raw["subtype"] === "completed") {
          const output = findOutput(payload) ?? "";
          return [
            event("tool_result", receivedAt, raw, {
              sessionId,
              tool,
              text: output,
              outputChars: output.length,
              isError: raw["is_error"] === true ? true : undefined,
            }),
          ];
        }
        return [
          event("tool_call", receivedAt, raw, {
            sessionId,
            tool,
            argv: command ? splitCommand(command) : undefined,
            text: command,
          }),
        ];
      }
      if (type === "result") {
        return [
          event("result", receivedAt, raw, {
            sessionId,
            text: str(raw["result"]),
            isError: raw["is_error"] === true || raw["subtype"] === "error",
            stopReason: str(raw["subtype"]),
          }),
        ];
      }
      return [];
    },
    collectPaths: [],
    fixture: null,
  };
}
