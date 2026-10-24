import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, NormalizedEventKind } from "../types";
import { PACKAGE_ROOT } from "../prompt";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createCursorAdapter } from "./cursor";
import { createHermesAdapter, HERMES_TOOL_OUTPUT_CAP } from "./hermes";
import {
  createHarness,
  HARNESS_BINARIES,
  HARNESS_NAMES,
  isHarnessName,
} from "./index";
import { createOpencodeAdapter, OPENCODE_CHEAP_MODEL } from "./opencode";
import {
  createScriptAdapter,
  scriptFor,
  SCRIPT_PATH,
  SCRIPT_TEMPLATE,
} from "./script";
import {
  commandLineString,
  parseJsonLine,
  splitCommand,
  toIso,
} from "./shared";

const AT = "2026-10-25T14:00:00.000Z";
const launch = {
  promptPath: "/loop/prompt.txt",
  zone: "everyapp-loop1.com",
  loopDir: "/loop",
};

function counts(
  events: NormalizedEvent[],
): Record<NormalizedEventKind, number> {
  const out: Record<NormalizedEventKind, number> = {
    assistant_text: 0,
    tool_call: 0,
    tool_result: 0,
    turn_end: 0,
    result: 0,
  };
  for (const event of events) out[event.kind] += 1;
  return out;
}

/** The fixture when lane A captured it, else the inline sample (then the test is provisional and says so). */
function sample(
  harness: string,
  inline: string[],
): { lines: string[]; source: "fixture" | "inline" } {
  const path = join(PACKAGE_ROOT, "fixtures", harness, "sample.jsonl");
  if (existsSync(path))
    return { lines: readFileSync(path, "utf8").split("\n"), source: "fixture" };
  return { lines: inline, source: "inline" };
}

function normalizeAll(
  adapter: ReturnType<typeof createHarness>,
  lines: string[],
  exitCode = 0,
): NormalizedEvent[] {
  const events = lines.flatMap((line) => adapter.normalize(line, "stdout", AT));
  return [...events, ...(adapter.onExit?.(exitCode, AT) ?? [])];
}

describe("shared", () => {
  it("splits a command like a shell for the common cases", () => {
    expect(
      splitCommand(`pnpm everyapp setup --domain "apps.example.com" --json`),
    ).toEqual([
      "pnpm",
      "everyapp",
      "setup",
      "--domain",
      "apps.example.com",
      "--json",
    ]);
    expect(splitCommand(`sh -c 'echo "a b"' x`)).toEqual([
      "sh",
      "-c",
      'echo "a b"',
      "x",
    ]);
    expect(splitCommand("")).toEqual([]);
  });
  it("parses only JSON objects", () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine("Reading additional input from stdin...")).toBeNull();
    expect(parseJsonLine("[1]")).toBeNull();
    expect(parseJsonLine("{broken")).toBeNull();
  });
  it("turns ms and ISO into ISO", () => {
    expect(toIso(1792814716692)).toBe("2026-10-24T04:05:16.692Z");
    expect(toIso("2026-10-24T04:05:16.692Z")).toBe("2026-10-24T04:05:16.692Z");
    expect(toIso("nope")).toBeUndefined();
  });
  it("renders a command line a person could paste", () => {
    expect(commandLineString(["claude", "-p", "--model", "x", "a b"])).toBe(
      "claude -p --model x 'a b'",
    );
  });
});

describe("registry", () => {
  it("knows the six harnesses and a binary per harness", () => {
    expect(HARNESS_NAMES).toEqual([
      "script",
      "claude",
      "codex",
      "opencode",
      "cursor",
      "hermes",
    ]);
    for (const name of HARNESS_NAMES) {
      expect(isHarnessName(name)).toBe(true);
      expect(HARNESS_BINARIES[name]).toBeTruthy();
      const adapter = createHarness(name);
      expect(adapter.name).toBe(name);
      expect(adapter.permissionBypass).toBe(true);
      expect(adapter.signal).toBeTruthy();
    }
    expect(isHarnessName("gemini")).toBe(false);
  });
  it("gives a fresh adapter per call", () => {
    expect(createHarness("codex")).not.toBe(createHarness("codex"));
  });
});

describe("claude adapter", () => {
  const adapter = createClaudeAdapter();
  it("writes the turn-1 line per design 4.4 with the prompt on stdin", () => {
    const command = adapter.command(launch);
    const line = command.argv.join(" ");
    for (const flag of [
      "claude -p",
      "--output-format stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--max-budget-usd 15",
      "--model claude-opus-5-5",
      "< /loop/prompt.txt",
    ]) {
      expect(line).toContain(flag);
    }
    expect(command.env).toEqual({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(
      adapter.command({ ...launch, model: "claude-fable-5-1" }).argv.join(" "),
    ).toContain("--model claude-fable-5-1");
  });
  it("resumes natively and refuses without a session", () => {
    expect(
      adapter.resume("sess-1", "/loop/reply-1.txt", launch)?.argv.join(" "),
    ).toContain("--resume sess-1");
    expect(adapter.resume(null, "/loop/reply-1.txt", launch)).toBeNull();
  });
  it("normalizes the sample into one of each kind", () => {
    const { lines, source } = sample("claude", [
      '{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-5-5"}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}]},"session_id":"s1","timestamp":"2026-10-24T04:55:36.000Z"}',
      '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"/work","is_error":false}]},"session_id":"s1","timestamp":"2026-10-24T04:55:36.696Z"}',
      '{"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[{"type":"text","text":"`/work`\\n\\nDONE"}]},"session_id":"s1"}',
      '{"type":"result","subtype":"success","is_error":false,"session_id":"s1","total_cost_usd":0.112,"usage":{"input_tokens":4,"output_tokens":92,"cache_read_input_tokens":42934,"cache_creation_input_tokens":20137},"permission_denials":[],"terminal_reason":"completed","result":"`/work`\\n\\nDONE"}',
    ]);
    const events = normalizeAll(adapter, lines);
    expect(counts(events), `${source} sample`).toEqual({
      assistant_text: 1,
      tool_call: 1,
      tool_result: 1,
      turn_end: 0,
      result: 1,
    });
    const call = events.find((e) => e.kind === "tool_call")!;
    expect(call.tool).toBe("Bash");
    expect(call.argv).toEqual(["pwd"]);
    expect(call.sessionId).toBeTruthy();
    const result = events.find((e) => e.kind === "result")!;
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.tokens?.output).toBeGreaterThan(0);
    expect(result.text).toContain("DONE");
    expect(result.stopReason).toBe("completed");
    expect(events.find((e) => e.kind === "assistant_text")?.model).toMatch(
      /^claude-/,
    );
  });
  it("ignores stderr and non-JSON", () => {
    expect(adapter.normalize('{"type":"result"}', "stderr", AT)).toEqual([]);
    expect(adapter.normalize("Not logged in", "stdout", AT)).toEqual([]);
  });
  it("marks an API error message as an error", () => {
    const [event] = adapter.normalize(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]},"error":"authentication_failed","is_api_error_message":true}',
      "stdout",
      AT,
    );
    expect(event?.isError).toBe(true);
  });
});

describe("codex adapter", () => {
  it("writes the turn-1 line per design 4.4", () => {
    const line = createCodexAdapter().command(launch).argv.join(" ");
    for (const flag of [
      "codex exec -",
      "--json",
      "-m gpt-5.3-codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-o /loop/last-message.txt",
      "< /loop/prompt.txt",
    ]) {
      expect(line).toContain(flag);
    }
    expect(
      createCodexAdapter()
        .resume("thr-1", "/loop/reply.txt", launch)
        ?.argv.join(" "),
    ).toContain("codex exec resume thr-1");
  });
  it("normalizes the sample and threads the id from thread.started", () => {
    const adapter = createCodexAdapter();
    const { lines, source } = sample("codex", [
      '{"type":"thread.started","thread_id":"01a16c15-7552-7ac0-82f5-60eba37135e3"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Running pwd."}}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/work\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"/work\\n\\nDONE"}}',
      '{"type":"turn.completed","usage":{"input_tokens":40717,"cached_input_tokens":33408,"cache_write_input_tokens":0,"output_tokens":79}}',
    ]);
    const events = normalizeAll(adapter, lines);
    expect(counts(events), `${source} sample`).toEqual({
      assistant_text: 2,
      tool_call: 1,
      tool_result: 1,
      turn_end: 0,
      result: 1,
    });
    expect(
      events.every(
        (e) =>
          e.sessionId === "01a16c15-7552-7ac0-82f5-60eba37135e3" ||
          e.sessionId?.length,
      ),
    ).toBe(true);
    const result = events.find((e) => e.kind === "result")!;
    expect(result.tokens?.input).toBeGreaterThan(0);
    expect(result.tokens?.cacheRead).toBeGreaterThan(0);
    expect(result.costUsd).toBeUndefined();
    const toolResult = events.find((e) => e.kind === "tool_result")!;
    expect(toolResult.isError).toBe(false);
    expect(toolResult.outputChars).toBeGreaterThan(0);
  });
  it("drops the stderr progress line", () => {
    expect(
      createCodexAdapter().normalize(
        "Reading additional input from stdin...",
        "stderr",
        AT,
      ),
    ).toEqual([]);
  });
});

describe("opencode adapter", () => {
  it("writes the turn-1 line per design 4.4 with --standalone", () => {
    const line = createOpencodeAdapter().command(launch).argv.join(" ");
    for (const flag of [
      "opencode run",
      "--standalone",
      "-m opencode/glm-5.3",
      "--format json",
      "--auto",
      "$(cat /loop/prompt.txt)",
    ])
      expect(line).toContain(flag);
    expect(
      createOpencodeAdapter()
        .resume("ses_1", "/loop/reply.txt", launch)
        ?.argv.join(" "),
    ).toContain("-s ses_1");
    // The development and canary model is a paid flash tier, never a free one (design 4.4).
    expect(OPENCODE_CHEAP_MODEL).toBe("opencode/glm-5.3-flash");
    expect(OPENCODE_CHEAP_MODEL).not.toMatch(/free/);
  });
  it("normalizes the sample and synthesizes the result at exit", () => {
    const adapter = createOpencodeAdapter();
    const { lines, source } = sample("opencode", [
      '{"type":"step_start","timestamp":1792814716692,"sessionID":"ses_1","part":{"type":"step-start"}}',
      '{"type":"tool_use","timestamp":1792814717157,"sessionID":"ses_1","part":{"type":"tool","tool":"shell","state":{"status":"completed","input":{"command":"pwd"},"output":"/work\\n","metadata":{"metadata":{"status":"completed","truncated":false,"exit":0}}}}}',
      '{"type":"step_finish","timestamp":1792814717160,"sessionID":"ses_1","part":{"type":"step-finish","reason":"tool-calls","cost":0.001,"tokens":{"input":9185,"output":78,"reasoning":0,"cache":{"read":256,"write":0}}}}',
      '{"type":"step_start","timestamp":1792814717622,"sessionID":"ses_1","part":{"type":"step-start"}}',
      '{"type":"text","timestamp":1792814717885,"sessionID":"ses_1","part":{"type":"text","text":"/work\\n\\nDONE"}}',
    ]);
    const streamed = lines.flatMap((line) =>
      adapter.normalize(line, "stdout", AT),
    );
    expect(counts(streamed), `${source} sample`).toEqual({
      assistant_text: 1,
      tool_call: 1,
      tool_result: 1,
      turn_end: 1,
      result: 0,
    });
    expect(streamed[0]?.ts).toMatch(/^2026-10-24T/);
    expect(streamed.every((e) => e.sessionId?.startsWith("ses_"))).toBe(true);
    const turnEnd = streamed.find((e) => e.kind === "turn_end")!;
    expect(turnEnd.tokens?.input).toBeGreaterThan(0);
    expect(turnEnd.costUsd).toBeTypeOf("number");
    const exit = adapter.onExit!(0, AT);
    expect(exit).toHaveLength(1);
    expect(exit[0]!.kind).toBe("result");
    expect(exit[0]!.text).toContain("DONE");
    expect(exit[0]!.isError).toBe(false);
  });
  it("does not synthesize a second result after an error event", () => {
    const adapter = createOpencodeAdapter();
    const events = adapter.normalize(
      '{"type":"error","sessionID":"ses_2","error":{"name":"ProviderAuthError","data":{"message":"401 invalid key"}}}',
      "stdout",
      AT,
    );
    expect(events[0]?.kind).toBe("result");
    expect(events[0]?.isError).toBe(true);
    expect(adapter.onExit!(1, AT)).toEqual([]);
  });
});

describe("cursor adapter (provisional)", () => {
  const adapter = createCursorAdapter();
  it("is labelled provisional with no fixture and cost none", () => {
    expect(adapter.status).toBe("provisional");
    expect(adapter.fixture).toBeNull();
    expect(adapter.signal.cost).toBe("none");
  });
  it("writes the documented command line", () => {
    const line = adapter.command(launch).argv.join(" ");
    for (const flag of [
      "agent -p",
      "--force",
      "--trust",
      "--sandbox disabled",
      "--output-format stream-json",
      "--model",
    ])
      expect(line).toContain(flag);
    expect(
      adapter.resume("chat-1", "/loop/reply.txt", launch)?.argv.join(" "),
    ).toContain("--resume chat-1");
  });
  it("normalizes the documented shape (inline sample, provisional)", () => {
    const { lines } = sample("cursor", [
      '{"type":"system","subtype":"init","session_id":"c1","model":"opus-4.5"}',
      '{"type":"tool_call","subtype":"started","call_id":"1","session_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pwd"}}}}',
      '{"type":"tool_call","subtype":"completed","call_id":"1","session_id":"c1","tool_call":{"shellToolCall":{"args":{"command":"pwd"},"result":{"output":"/work"}}}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"DONE"}]},"session_id":"c1"}',
      '{"type":"result","subtype":"success","duration_ms":1200,"result":"DONE","session_id":"c1"}',
    ]);
    const events = normalizeAll(adapter, lines);
    expect(counts(events)).toEqual({
      assistant_text: 1,
      tool_call: 1,
      tool_result: 1,
      turn_end: 0,
      result: 1,
    });
    expect(events.find((e) => e.kind === "tool_call")?.argv).toEqual(["pwd"]);
    expect(events.find((e) => e.kind === "tool_result")?.text).toBe("/work");
  });
});

describe("hermes adapter (provisional)", () => {
  const adapter = createHermesAdapter();
  it("is labelled provisional and prices from tokens", () => {
    expect(adapter.status).toBe("provisional");
    expect(adapter.signal.cost).toBe("tokens_x_list");
  });
  it("writes the documented command line with the yolo env", () => {
    const command = adapter.command(launch);
    const line = command.argv.join(" ");
    for (const flag of [
      "hermes chat",
      "--query-file /loop/prompt.txt",
      "--oneshot",
      "--format stream-json",
      "--yolo",
      "--provider anthropic",
      "-m claude-sonnet-5-5",
    ])
      expect(line).toContain(flag);
    expect(command.env).toMatchObject({
      HERMES_YOLO_MODE: "1",
      TERMINAL_TIMEOUT: "1800",
    });
    expect(
      adapter.resume("h1", "/loop/reply.txt", launch)?.argv.join(" "),
    ).toContain("-r h1");
  });
  it("normalizes the documented shape and flags the 5000-char cap (inline sample, provisional)", () => {
    const big = "x".repeat(HERMES_TOOL_OUTPUT_CAP);
    const { lines } = sample("hermes", [
      '{"type":"system","session_id":"h1","model":"claude-sonnet-5-5","timestamp":"2026-10-24T04:00:00Z"}',
      '{"type":"tool_use","name":"terminal","input":{"command":"pwd"},"session_id":"h1","timestamp":"2026-10-24T04:00:01Z"}',
      `{"type":"tool_result","name":"terminal","output":"${big}","session_id":"h1","timestamp":"2026-10-24T04:00:02Z"}`,
      '{"type":"text","text":"DONE","session_id":"h1","timestamp":"2026-10-24T04:00:03Z"}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":20},"session_id":"h1","timestamp":"2026-10-24T04:00:04Z"}',
    ]);
    const events = normalizeAll(adapter, lines);
    expect(counts(events)).toEqual({
      assistant_text: 1,
      tool_call: 1,
      tool_result: 1,
      turn_end: 0,
      result: 1,
    });
    expect(events.find((e) => e.kind === "tool_result")?.truncated).toBe(true);
    expect(events.find((e) => e.kind === "result")?.tokens).toEqual({
      input: 100,
      output: 20,
    });
  });
});

describe("script control", () => {
  it("follows the prompt literally: install, setup --domain apps.<zone> --json, create hello, deploy from apps/hello, DONE", () => {
    const script = scriptFor({ zone: "everyapp-loop1.com", loopDir: "/loop" });
    expect(script).toContain('ZONE="everyapp-loop1.com"');
    expect(script).toContain("pnpm install");
    expect(script).toContain(
      'pnpm everyapp setup --domain "apps.$ZONE" --json',
    );
    expect(script).toContain("pnpm everyapp create hello --json");
    expect(script).toContain("cd apps/hello");
    expect(script).toContain("pnpm everyapp deploy --json");
    expect(script).toContain('echo "DONE $GATEWAY_URL"');
    expect(script).not.toContain("create --deploy");
    expect(script).not.toContain("npx");
    expect(script).not.toContain("{{");
    expect(SCRIPT_TEMPLATE).toContain("{{ZONE}}");
  });
  it("refuses a zone that is not a hostname", () => {
    expect(() => scriptFor({ zone: "a b; rm -rf /" })).toThrow(/zone/);
    expect(() => scriptFor({})).toThrow(/zone/);
  });
  it("turns its markers into tool events, passes CLI NDJSON through, ends on DONE", () => {
    const adapter = createScriptAdapter();
    expect(adapter.command(launch).argv).toEqual(["bash", SCRIPT_PATH]);
    expect(adapter.resume("x", "/loop/r", launch)).toBeNull();
    const lines = [
      "LOOP_CMD pnpm install",
      "Progress: resolved 1200",
      "LOOP_EXIT 0",
      "LOOP_CMD pnpm everyapp setup --domain apps.everyapp-loop1.com --json",
      '{"v":1,"ts":"2026-10-25T14:10:00.000Z","type":"action_required","action":"claim_owner","message":"Open this link","data":{"url":"https://apps.everyapp-loop1.com/setup#token=est_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}}',
      '{"v":1,"ts":"2026-10-25T14:12:00.000Z","type":"done","data":{"gatewayUrl":"https://apps.everyapp-loop1.com"}}',
      "LOOP_EXIT 0",
      "DONE https://apps.everyapp-loop1.com",
    ];
    const events = normalizeAll(adapter, lines);
    expect(counts(events)).toEqual({
      assistant_text: 1,
      tool_call: 2,
      tool_result: 2,
      turn_end: 0,
      result: 1,
    });
    expect(events.filter((e) => e.kind === "tool_call")[1]!.argv).toEqual([
      "pnpm",
      "everyapp",
      "setup",
      "--domain",
      "apps.everyapp-loop1.com",
      "--json",
    ]);
    expect(events.find((e) => e.kind === "result")?.text).toBe(
      "DONE https://apps.everyapp-loop1.com",
    );
  });
  it("synthesizes an error result when the script dies without DONE or BLOCKED", () => {
    const adapter = createScriptAdapter();
    adapter.normalize("LOOP_CMD pnpm install", "stdout", AT);
    const exit = adapter.onExit!(137, AT);
    expect(exit[0]?.kind).toBe("result");
    expect(exit[0]?.isError).toBe(true);
    const blocked = createScriptAdapter();
    blocked.normalize("BLOCKED: setup exited 1", "stdout", AT);
    expect(blocked.onExit!(1, AT)).toEqual([]);
  });
});
