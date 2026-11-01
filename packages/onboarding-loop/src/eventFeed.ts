/**
 * The CLI's event log, read live (design 4.2 steps 5 and 6): each line the
 * tail delivers is kept for the record and turned into the inputs the
 * scripted user reacts to: a `setup` starting (then wait, do not reply),
 * ending (done, error, or stopped on an action), an action_required, an
 * error code, a deploy's done. Processes are told apart by pid, as the log
 * writes them. The claim never comes from here: claim.ts has its own
 * reader of the same lines.
 */
import { parseEventLogLine } from "./claim";
import { everyappArgv } from "./parse/eventLog";
import type { EventLogLine, ScriptedUserInput } from "./types";

interface EventFeedHooks {
  onInput(input: ScriptedUserInput): void;
  /** A `setup` process started: its pid, for /proc/<pid>/environ. */
  onSetupInvocation?(pid: number): void;
}

interface ProcessState {
  command: string;
  done: boolean;
  error: boolean;
  action: boolean;
}

export interface EventFeed {
  /** One line of /loop/everyapp-events.ndjson as it arrives. */
  onLine(line: string): void;
  /** Every parsed line, in order. */
  readonly lines: EventLogLine[];
  /** The raw lines, in order (already redacted by the sandbox). */
  readonly raw: string[];
  /** The pids of `setup` processes that started and have not written an exit line. */
  inFlightSetupPids(): number[];
  /** The driver found the process gone: the setup ended `killed` and the scripted user stops waiting for it. */
  markSetupKilled(pid: number): void;
}

export function createEventFeed(hooks: EventFeedHooks): EventFeed {
  const lines: EventLogLine[] = [];
  const raw: string[] = [];
  const processes = new Map<number | null, ProcessState>();
  let current: number | null = null;

  const stateOf = (pid: number | null): ProcessState | undefined =>
    processes.get(pid) ?? (pid === null ? undefined : processes.get(current));

  return {
    lines,
    raw,
    inFlightSetupPids: () =>
      [...processes]
        .filter(
          ([pid, state]) =>
            typeof pid === "number" && state.command === "setup",
        )
        .map(([pid]) => pid as number),
    markSetupKilled(pid) {
      const state = processes.get(pid);
      if (!state || state.command !== "setup") return;
      processes.delete(pid);
      if (current === pid) current = null;
      hooks.onInput({ kind: "setup_ended", status: "killed" });
    },
    onLine(line) {
      if (line.trim() === "") return;
      raw.push(line);
      const event = parseEventLogLine(line);
      if (!event) return;
      lines.push(event);
      if (event.type === "invocation") {
        const command = everyappArgv(event.argv)[0] ?? "";
        processes.set(event.pid, {
          command,
          done: false,
          error: false,
          action: false,
        });
        current = event.pid;
        if (command === "setup") {
          hooks.onInput({ kind: "setup_started" });
          hooks.onSetupInvocation?.(event.pid);
        }
        return;
      }
      const pid =
        "pid" in event && typeof event.pid === "number" ? event.pid : null;
      const state = stateOf(pid);
      switch (event.type) {
        case "action_required":
          if (state) state.action = true;
          hooks.onInput({
            kind: "action_required",
            action: event.action,
            data: event.data,
          });
          return;
        case "error":
          if (state) state.error = true;
          hooks.onInput({ kind: "cli_error", code: event.code });
          return;
        case "done":
          if (state) state.done = true;
          if (state?.command === "deploy")
            hooks.onInput({ kind: "app_deployed" });
          return;
        case "exit": {
          if (!state) return;
          if (state.command === "setup") {
            hooks.onInput({
              kind: "setup_ended",
              status: state.done
                ? "done"
                : state.error || event.code === 1
                  ? "error"
                  : "action_required",
            });
          }
          processes.delete(pid ?? current);
          if (current === pid) current = null;
          return;
        }
        default:
          return;
      }
    },
  };
}
