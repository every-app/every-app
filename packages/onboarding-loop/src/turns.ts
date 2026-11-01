/**
 * The harness's turns (design 4.2 steps 5 to 7, 4.5): turn 1 is the
 * adapter's command line with the prompt on a file, stdin at EOF; every
 * stdout and stderr line goes through the adapter's normalizer into
 * events.jsonl as it arrives. When the process exits, the scripted user
 * decides: stop (DONE, BLOCKED, caps), wait (a `setup` is still running in
 * the event log), or a reply, which becomes the next process through the
 * adapter's native resume. A reply decided mid-turn (the domain question
 * in assistant text, or one the driver queued from the event log: "Done,
 * continue" after the subdomain PUT) is delivered when the turn ends,
 * because a `-p` process has no stdin to answer on. The whole run has one
 * deadline; a harness without a budget flag is killed past a token
 * ceiling.
 */
import { parseBlocked, parseDone, type ScriptedUser } from "./scriptedUser";
import type {
  ExecLine,
  ExecResult,
  HarnessAdapter,
  HarnessLaunch,
  NormalizedEvent,
  Resume,
  Sandbox,
  SandboxHandle,
  ScriptedUserAction,
  ScriptedUserTrigger,
} from "./types";

/** Tokens in and out past which a harness with no budget flag is killed (fail-infra: budget). */
export const TOKEN_BUDGET = 4_000_000;
/** How often a held turn re-asks the scripted user while a setup runs. */
const WAIT_POLL_MS = 15_000;

export type TurnsTerminal =
  | "done"
  | "blocked"
  | "caps_exceeded"
  | "fixture_error"
  | "time_cap"
  | "budget"
  | "no_resume";

export interface TurnsResult {
  /** Events per process, in order: turn 1, then each resume. */
  processes: NormalizedEvent[][];
  exits: ExecResult[];
  resumes: Resume[];
  terminal: TurnsTerminal;
  fixtureCode: string | null;
  sessionId: string | null;
  /** The command line of turn 1, as run. */
  commandArgv: string[];
}

export interface TurnsDeps {
  sandbox: Sandbox;
  handle: SandboxHandle;
  adapter: HarnessAdapter;
  launch: HarnessLaunch;
  user: ScriptedUser;
  cwd: string;
  /** The container's own variables beyond the secrets (none today); the adapter's env is added. */
  env?: Record<string, string>;
  /** Puts a reply where the sandbox can read it; returns its path inside. */
  writeReply(index: number, text: string): Promise<string>;
  /** Replies the driver decided from the event log while the turn ran, delivered at its end as expected hand-offs. */
  takeQueuedReplies?(): Promise<string[]>;
  onEvent?(event: NormalizedEvent, processIndex: number): void;
  onRawLine?(line: ExecLine, processIndex: number): void;
  /** A person's answer waiting (`pnpm loop answer`), consumed once per turn end. */
  takePersonAnswer?(): string | null;
  /** Right before a process starts (the first, or a resume): `--claim-after turn-end` closes its gate here. */
  onTurnStart?(processIndex: number): void;
  /** Right after a process exits and before the scripted user decides: `--claim-after turn-end` claims here. */
  onTurnEnd?(): Promise<void>;
  /** Each poll while a reply is held for a running setup: the driver checks the setup's pid is still alive. */
  onWaitPoll?(): Promise<void>;
  /** The run's deadline, epoch ms. */
  deadlineAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Kill past this many tokens for harnesses whose signal.cost is not "harness". */
  tokenBudget?: number;
}

const resumeReason = (trigger: ScriptedUserTrigger): Resume["reason"] =>
  trigger === "harness_exit"
    ? "harness_exit"
    : trigger === "person"
      ? "person"
      : "turn_end_without_done";

/** A result the adapter made up at process exit, not one the harness printed. */
const synthesized = (event: NormalizedEvent): boolean =>
  !!event.raw && typeof event.raw === "object" && "synthesized" in event.raw;

/** The text a turn ended on: the last assistant text and the last result text the harness itself printed. */
function turnText(events: NormalizedEvent[]): string {
  const lastText =
    [...events].reverse().find((e) => e.kind === "assistant_text")?.text ?? "";
  const lastResult =
    [...events].reverse().find((e) => e.kind === "result" && !synthesized(e))
      ?.text ?? "";
  return lastResult && lastResult !== lastText
    ? `${lastText}\n${lastResult}`
    : lastText;
}

export async function runHarnessTurns(deps: TurnsDeps): Promise<TurnsResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budget = deps.tokenBudget ?? TOKEN_BUDGET;
  const processes: NormalizedEvent[][] = [];
  const exits: ExecResult[] = [];
  const resumes: Resume[] = [];
  let sessionId: string | null = null;
  let command = deps.adapter.command(deps.launch);
  const commandArgv = command.argv;
  let index = 0;
  let tokens = 0;

  for (;;) {
    const events: NormalizedEvent[] = [];
    const queued: string[] = [];
    let budgetKill = false;
    const controller = new AbortController();
    const remaining = deps.deadlineAt - now();
    if (remaining <= 0) {
      return {
        processes,
        exits,
        resumes,
        terminal: "time_cap",
        fixtureCode: null,
        sessionId,
        commandArgv,
      };
    }
    const processIndex = index;
    deps.onTurnStart?.(processIndex);
    const result = await deps.sandbox.exec(deps.handle, command.argv, {
      cwd: deps.cwd,
      env: { ...deps.env, ...command.env },
      timeoutMs: remaining,
      signal: controller.signal,
      onLine: (line) => {
        deps.onRawLine?.(line, processIndex);
        for (const event of deps.adapter.normalize(
          line.line,
          line.stream,
          line.receivedAt,
        )) {
          events.push(event);
          deps.onEvent?.(event, processIndex);
          if (event.sessionId) sessionId = event.sessionId;
          if (event.tokens) {
            tokens += (event.tokens.input ?? 0) + (event.tokens.output ?? 0);
            if (deps.adapter.signal.cost !== "harness" && tokens > budget) {
              budgetKill = true;
              controller.abort();
            }
          }
          if (event.kind === "assistant_text" && event.text) {
            const action = deps.user.onInput({
              kind: "assistant_text",
              text: event.text,
            });
            if (action?.type === "reply") queued.push(action.text);
          }
        }
      },
    });
    const exitAt = new Date(now()).toISOString();
    for (const event of deps.adapter.onExit?.(result.exitCode, exitAt) ?? []) {
      events.push(event);
      deps.onEvent?.(event, processIndex);
    }
    processes.push(events);
    exits.push(result);
    await deps.onTurnEnd?.();
    const finish = (
      terminal: TurnsTerminal,
      fixtureCode: string | null = null,
    ): TurnsResult => ({
      processes,
      exits,
      resumes,
      terminal,
      fixtureCode,
      sessionId,
      commandArgv,
    });

    if (budgetKill) return finish("budget");
    if (result.killed) return finish("time_cap");

    const text = turnText(events);
    // A result the harness printed, or a clean exit (0) after a stream with no closing event
    // (`opencode run` ends on its last text line): both are a turn end, not a crash.
    const hadResultEvent = events.some(
      (e) => e.kind === "result" && (!synthesized(e) || result.exitCode === 0),
    );
    const person = deps.takePersonAnswer?.() ?? null;
    queued.push(...((await deps.takeQueuedReplies?.()) ?? []));
    const ended = parseDone(text).done || parseBlocked(text) !== null;

    let action: ScriptedUserAction | null;
    if (person) {
      action = deps.user.onInput({ kind: "person", text: person });
    } else if (queued.length > 0 && !ended) {
      // The answer was decided mid-turn: it is the reply, and no nudge is counted.
      action = {
        type: "reply",
        trigger: "turn_end_without_done",
        text: queued.join("\n"),
        expected: true,
      };
    } else {
      action = deps.user.onInput({ kind: "turn_end", text, hadResultEvent });
      // Held while a setup runs in the harness: re-ask until it ends, is found dead, or the wait is over.
      while (action?.type === "wait") {
        if (now() >= deps.deadlineAt) return finish("time_cap");
        const until = Math.min(action.untilMs, deps.deadlineAt);
        await sleep(Math.max(1, Math.min(WAIT_POLL_MS, until - now())));
        await deps.onWaitPoll?.();
        action = deps.user.onInput({ kind: "turn_end", text, hadResultEvent });
      }
    }

    if (!action) return finish("no_resume");
    if (action.type === "stop") return finish(action.reason);
    if (action.type === "fixture_error")
      return finish("fixture_error", action.code);
    // A turn end yields a reply, a stop, a fixture error or (above) a wait; the subdomain PUT is
    // decided from the event log mid-turn and its "Done, continue" arrives through takeQueuedReplies.
    if (action.type !== "reply") return finish("no_resume");
    const reply: { text: string; trigger: ScriptedUserTrigger } = {
      text: action.text,
      trigger: action.trigger,
    };

    index += 1;
    const replyPath = await deps.writeReply(index, reply.text);
    const next = deps.adapter.resume(sessionId, replyPath, deps.launch);
    if (!next) return finish("no_resume");
    resumes.push({
      at: new Date(now()).toISOString(),
      reason: resumeReason(reply.trigger),
      how: "native",
      sessionId,
    });
    command = next;
  }
}
