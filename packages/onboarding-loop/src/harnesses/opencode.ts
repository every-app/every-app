/**
 * OpenCode on OpenCode Zen (design 4.4 row 4). `opencode run --format json`
 * prints NDJSON with a `timestamp` (ms), `sessionID` and a `part`:
 * `step_start`, `text`, `tool_use` (part.state has input.command, output,
 * metadata.truncated and metadata.exit), `step_finish` (reason, cost,
 * tokens). Each step is one model call; the harness's cost is the sum of
 * the steps. Resume is `-s <sessionID>`.
 *
 * Shapes checked against a local probe run (OpenCode 2.1.3, 2026-10-23).
 * `--standalone` keeps the server inside the exec.
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

const OPENCODE_VERSION = "2.1.3";
const OPENCODE_DEFAULT_MODEL = "opencode/glm-5.3";
/** For developing the pipeline and the nightly canary (4.13); never the free tiers. */
export const OPENCODE_CHEAP_MODEL = "opencode/glm-5.3-flash";

function tokensOf(value: unknown) {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value["cache"]) ? value["cache"] : {};
  return {
    input: num(value["input"]),
    output: num(value["output"]),
    cacheRead: num(cache["read"]),
    cacheWrite: num(cache["write"]),
  };
}

export function createOpencodeAdapter(): HarnessAdapter {
  // `opencode run` ends on its last `text` line with no closing event (fixtures/opencode/sample.jsonl):
  // the last text and tokens are kept so onExit can synthesize the result.
  let lastText: string | undefined;
  let lastSession: string | undefined;
  let sawResult = false;
  return {
    name: "opencode",
    version: OPENCODE_VERSION,
    status: "measured",
    providerVar: "OPENCODE_API_KEY",
    defaultModel: OPENCODE_DEFAULT_MODEL,
    signal: {
      toolCalls: "full",
      toolOutput: "truncated",
      exitCodes: true,
      cost: "harness",
      resume: "native",
    },
    permissionBypass: true,
    command(launch): HarnessCommand {
      const model = launch.model ?? OPENCODE_DEFAULT_MODEL;
      return {
        argv: [
          "sh",
          "-c",
          `exec opencode run --standalone -m ${model} --format json --auto "$(cat ${launch.promptPath})"`,
        ],
      };
    },
    resume(sessionId, replyPath, launch): HarnessCommand | null {
      if (!sessionId) return null;
      const model = launch.model ?? OPENCODE_DEFAULT_MODEL;
      return {
        argv: [
          "sh",
          "-c",
          `exec opencode run --standalone -s ${sessionId} -m ${model} --format json --auto "$(cat ${replyPath})"`,
        ],
      };
    },
    normalize(line, stream, receivedAt): NormalizedEvent[] {
      if (stream === "stderr") return [];
      const raw = parseJsonLine(line);
      if (!raw) return [];
      const type = raw["type"];
      const ts = toIso(raw["timestamp"]);
      const sessionId = str(raw["sessionID"]);
      const part = isRecord(raw["part"]) ? raw["part"] : {};
      if (sessionId) lastSession = sessionId;
      if (type === "text") {
        lastText = str(part["text"]);
        return [
          event("assistant_text", receivedAt, raw, {
            ts,
            sessionId,
            text: lastText,
          }),
        ];
      }
      if (type === "tool_use") {
        const state = isRecord(part["state"]) ? part["state"] : {};
        const input = isRecord(state["input"]) ? state["input"] : {};
        const command = str(input["command"]);
        const tool = str(part["tool"]);
        const call = event("tool_call", receivedAt, raw, {
          ts,
          sessionId,
          tool,
          argv: command ? splitCommand(command) : undefined,
          text: command ?? str(input["filePath"]) ?? str(input["path"]),
        });
        if (state["status"] !== "completed" && state["status"] !== "error")
          return [call];
        const metadata = isRecord(state["metadata"]) ? state["metadata"] : {};
        const inner = isRecord(metadata["metadata"])
          ? metadata["metadata"]
          : metadata;
        const output = str(state["output"]) ?? "";
        const exit = num(inner["exit"]);
        return [
          call,
          event("tool_result", receivedAt, raw, {
            ts,
            sessionId,
            tool,
            text: output,
            outputChars: output.length,
            truncated: inner["truncated"] === true ? true : undefined,
            isError:
              state["status"] === "error" || (exit !== undefined && exit !== 0),
          }),
        ];
      }
      if (type === "step_finish") {
        const reason = str(part["reason"]);
        const fields = {
          ts,
          sessionId,
          tokens: tokensOf(part["tokens"]),
          costUsd: num(part["cost"]),
          stopReason: reason,
        };
        const out = [event("turn_end", receivedAt, raw, fields)];
        if (reason !== undefined && reason !== "tool-calls") {
          sawResult = true;
          out.push(
            event("result", receivedAt, raw, { ...fields, text: lastText }),
          );
        }
        return out;
      }
      if (type === "error") {
        const error = isRecord(raw["error"]) ? raw["error"] : {};
        const data = isRecord(error["data"]) ? error["data"] : {};
        sawResult = true;
        return [
          event("result", receivedAt, raw, {
            ts,
            sessionId,
            isError: true,
            text:
              str(data["message"]) ?? str(error["name"]) ?? str(raw["message"]),
            stopReason: "error",
          }),
        ];
      }
      return [];
    },
    onExit(exitCode, receivedAt): NormalizedEvent[] {
      if (sawResult) return [];
      return [
        event(
          "result",
          receivedAt,
          { synthesized: "process_exit", exitCode },
          {
            sessionId: lastSession,
            text: lastText,
            isError: exitCode !== 0,
            stopReason:
              exitCode === 0 ? "process_exit" : `exit_${exitCode ?? "signal"}`,
          },
        ),
      ];
    },
    // `opencode session export` is run by the collector; the store is under ~/.local/share/opencode.
    collectPaths: [".local/share/opencode/storage"],
    fixture: "fixtures/opencode/sample.jsonl",
  };
}
