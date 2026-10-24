/**
 * Hesitation detectors (design 4.9), pure functions over events.jsonl and
 * the event log's commands. Each kind is a versioned rule; a harness
 * upgrade that changes a stream breaks a fixture test here, not a run.
 */
import {
  CLAUDE_BACKGROUND_KILLED,
  CLAUDE_BACKGROUND_MOVED,
} from "../harnesses/claude";
import { HERMES_CLARIFY_TOOL } from "../harnesses/hermes";
import type {
  EveryappCommand,
  HarnessTimeout,
  Hesitation,
  NormalizedEvent,
} from "../types";
import { parseBlocked, parseDone } from "../scriptedUser";
import { everyappArgv } from "./eventLog";

export const RULES_VERSION = 1;

const ASKED_USER_TOOLS = new Set([
  "AskUserQuestion",
  HERMES_CLARIFY_TOOL,
  "ask_user",
  "question",
]);
/** A text rule for "I need you to…" at the end of a turn; versioned with RULES_VERSION. */
const ASKED_USER_TEXT =
  /\b(let me know|could you (please )?(tell|confirm|provide|share)|please (tell|confirm|provide|share)|which .{0,40}\?|do you want me to|should i proceed|waiting for (you|your))/i;
const DOCS_PATH =
  /(^|\/)(landing-page\/content\/(agent|docs)\/|docs\/|README\.md|SKILL\.md|llms(-full)?\.txt)/;
const CLI_SOURCE_PATH = /(^|\/)packages\/cli\/src\//;
const READ_TOOLS = new Set(["Read", "read", "view", "cat", "ReadFile"]);

function excerptOf(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The everyapp command just before `at`, when there was one. */
function precededBy(
  commands: EveryappCommand[],
  events: NormalizedEvent[],
  index: number,
): Hesitation["precededBy"] {
  // Walk back through tool calls to the last one that ran everyapp.
  for (let i = index - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "tool_call") continue;
    const argv = everyappArgv(event.argv ?? []);
    const words = [...(event.argv ?? []), ...(event.text ?? "").split(/\s+/)];
    if (!words.some((w) => w === "everyapp" || w.endsWith("/everyapp")))
      continue;
    const matching = commands.find((c) => c.argv.join(" ") === argv.join(" "));
    return { argv: matching?.argv ?? argv, exit: matching?.exit ?? null };
  }
  return null;
}

/** The file a read-like tool call touched, from argv or text. */
function readPath(event: NormalizedEvent): string | null {
  if (event.kind !== "tool_call") return null;
  const tool = event.tool ?? "";
  if (READ_TOOLS.has(tool)) return event.text ?? null;
  const argv = event.argv ?? [];
  if (["cat", "less", "head", "tail", "sed", "bat"].includes(argv[0] ?? ""))
    return argv.find((w, i) => i > 0 && !w.startsWith("-")) ?? null;
  return null;
}

export function detectHesitations(
  events: NormalizedEvent[],
  commands: EveryappCommand[],
): Hesitation[] {
  const found: Hesitation[] = [];
  const docsRead = new Set<string>();
  const push = (
    kind: Hesitation["kind"],
    index: number,
    text: string | undefined,
    triage: Hesitation["triage"],
  ) => {
    const event = events[index]!;
    found.push({
      kind,
      at: event.ts ?? event.receivedAt,
      excerpt: excerptOf(text),
      precededBy: precededBy(commands, events, index),
      triage,
    });
  };

  events.forEach((event, index) => {
    if (event.kind === "tool_call") {
      if (event.tool && ASKED_USER_TOOLS.has(event.tool))
        push("asked_user", index, event.text, "prompt");
      const path = readPath(event);
      if (path) {
        if (CLI_SOURCE_PATH.test(path))
          push("source_read", index, path, "docs");
        else if (DOCS_PATH.test(path)) {
          if (docsRead.has(path)) push("docs_reread", index, path, "docs");
          docsRead.add(path);
        }
      }
      return;
    }
    if (event.kind === "tool_result") {
      const text = event.text ?? "";
      if (CLAUDE_BACKGROUND_MOVED.test(text))
        push(
          "moved_to_background",
          index,
          text.match(CLAUDE_BACKGROUND_MOVED)?.[0],
          "harness",
        );
      else if (CLAUDE_BACKGROUND_KILLED.test(text))
        push(
          "background_killed",
          index,
          text.match(CLAUDE_BACKGROUND_KILLED)?.[0],
          "harness",
        );
      if (event.truncated)
        push(
          "tool_output_truncated",
          index,
          `${event.tool ?? "tool"} output cut at ${event.outputChars ?? "?"} chars`,
          "harness",
        );
      return;
    }
    if (event.kind === "result") {
      const raw = event.raw as Record<string, unknown> | string | null;
      const denials =
        raw &&
        typeof raw === "object" &&
        Array.isArray(raw["permission_denials"])
          ? raw["permission_denials"]
          : [];
      if (denials.length > 0)
        push(
          "asked_user",
          index,
          `permission_denials: ${denials.length}`,
          "harness",
        );
      const text = event.text ?? "";
      const lastText =
        [...events.slice(0, index)]
          .reverse()
          .find((e) => e.kind === "assistant_text")?.text ?? "";
      const turnText = `${lastText}\n${text}`;
      if (
        !parseDone(turnText).done &&
        !parseBlocked(turnText) &&
        !event.isError
      ) {
        push(
          "ended_turn_without_done",
          index,
          lastText || text,
          ASKED_USER_TEXT.test(turnText) ? "prompt" : "unknown",
        );
        if (ASKED_USER_TEXT.test(turnText))
          push(
            "asked_user",
            index,
            turnText.match(ASKED_USER_TEXT)?.[0],
            "prompt",
          );
      }
    }
  });

  // From the event log: the same command run again right after it failed (exit 2 is the prompt's own rerun), and setup without --json.
  for (let i = 1; i < commands.length; i++) {
    const prev = commands[i - 1]!;
    const cur = commands[i]!;
    if (
      prev.argv[0] !== undefined &&
      prev.argv[0] === cur.argv[0] &&
      prev.exit !== 0 &&
      prev.exit !== 2
    ) {
      found.push({
        kind: "repeated_command",
        at: "",
        excerpt: excerptOf(cur.argv.join(" ")),
        precededBy: { argv: prev.argv, exit: prev.exit },
        triage: "cli",
      });
    }
  }
  for (const command of commands) {
    if (
      ["setup", "create", "deploy", "status"].includes(command.argv[0] ?? "") &&
      !command.json
    ) {
      found.push({
        kind: "dropped_json_flag",
        at: "",
        excerpt: excerptOf(command.argv.join(" ")),
        precededBy: { argv: command.argv, exit: command.exit },
        triage: command.argv[0] === "setup" ? "cli" : "prompt",
      });
    }
  }
  return found;
}

/** Harness-side timeouts acting on long commands, from the same strings. */
export function detectHarnessTimeouts(
  events: NormalizedEvent[],
): HarnessTimeout[] {
  const timeouts: HarnessTimeout[] = [];
  events.forEach((event, index) => {
    if (event.kind !== "tool_result") return;
    const text = event.text ?? "";
    const moved =
      /did not complete within its (\d+)s timeout and was moved to the background/.exec(
        text,
      );
    const call = [...events.slice(0, index)]
      .reverse()
      .find((e) => e.kind === "tool_call");
    const what = everyappArgv(call?.argv ?? [])[0] ?? call?.tool ?? "command";
    if (moved)
      timeouts.push({
        at: event.ts ?? event.receivedAt,
        what,
        limitS: Number(moved[1]),
        action: "backgrounded",
      });
    else if (CLAUDE_BACKGROUND_KILLED.test(text))
      timeouts.push({
        at: event.ts ?? event.receivedAt,
        what,
        limitS: 600,
        action: "killed",
      });
    else if (
      /yield(ed|ing) after|exceeded .* and was (terminated|killed)/i.test(text)
    )
      timeouts.push({
        at: event.ts ?? event.receivedAt,
        what,
        limitS: 300,
        action: "killed",
      });
  });
  return timeouts;
}

/** `gap_over_60s`: between a tool result and the next tool call with no tool in flight (design 4.8). */
export function gapsOver60s(events: NormalizedEvent[]): number {
  let gaps = 0;
  let lastResult: number | null = null;
  for (const event of events) {
    const at = Date.parse(event.ts ?? event.receivedAt);
    if (event.kind === "tool_result") lastResult = at;
    else if (event.kind === "tool_call") {
      if (lastResult !== null && at - lastResult > 60_000) gaps += 1;
      lastResult = null;
    }
  }
  return gaps;
}
