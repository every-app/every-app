/**
 * A dormant tee of everything a run emits, for test harnesses and bug
 * reports. With `EVERYAPP_EVENT_LOG=<path>` in the environment, every
 * everyapp process appends to that file, one JSON object per line, whether
 * or not it was run with --json:
 *
 *   {type:"invocation", pid, ts, argv, cwd, json, isatty:{stdin,stdout,stderr}, ci}
 *   {v:1, ts, type:"step"|"progress"|…, …, pid}      each event, as the sink emitted it
 *   {type:"exit", pid, ts, code, ms}
 *
 * Events are logged as the run's sink saw them (`emitter` in events.ts), so
 * they are the --json lines a person's run would have produced: a warning
 * said once, `done` with its `durationMs` and without `display`. What a
 * command never emits is not here either: setup mints its owner link only
 * when `maySetupLinkBeShown` allows, so the link is absent exactly when a
 * person would not have seen it (CI set, or piped without --json).
 *
 * Every line is one `fs.appendFileSync` (O_APPEND, never buffered), so the
 * processes that share one file (`pnpm run deploy` runs everyapp as a child,
 * so does `npx everyapp`) interleave whole lines, each stamped with its
 * `pid`. The file is created mode 600 (it holds the owner link, which is a
 * password). A path that can't be written is said once on stderr and the run
 * goes on: the log never fails a command. Without the variable, nothing
 * here runs.
 */
import fs from "node:fs";

const VARIABLE = "EVERYAPP_EVENT_LOG";

interface Log {
  append(line: Record<string, unknown>): void;
}

let opened: { path: string; log: Log } | undefined;

/** The log the environment names, or null when `EVERYAPP_EVENT_LOG` is unset or empty. */
function eventLog(): Log | null {
  const path = process.env[VARIABLE];
  if (!path) return null;
  if (opened?.path !== path) opened = { path, log: open(path) };
  return opened.log;
}

function open(path: string): Log {
  let broken = false;
  return {
    append(line) {
      if (broken) return;
      try {
        // Created readable by this user only: it holds the owner link (`est_…`), a password.
        const text = `${JSON.stringify({ ...line, pid: process.pid })}\n`;
        fs.appendFileSync(path, text, { mode: 0o600 });
      } catch (error) {
        broken = true;
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`everyapp: can't write ${VARIABLE}=${path} (${reason}); not logging\n`);
      }
    },
  };
}

/** Once per process, before any command runs. */
export function logInvocation({ argv, json }: { argv: readonly string[]; json: boolean }): void {
  eventLog()?.append({
    type: "invocation",
    ts: new Date().toISOString(),
    argv: [...argv],
    cwd: process.cwd(),
    json,
    isatty: {
      stdin: Boolean(process.stdin.isTTY),
      stdout: Boolean(process.stdout.isTTY),
      stderr: Boolean(process.stderr.isTTY),
    },
    ci: Boolean(process.env["CI"]),
  });
}

/** An event, as a sink emitted it: the same object its --json line would carry. */
export function logEvent(event: Record<string, unknown>, ts: Date): void {
  eventLog()?.append({ v: 1, ts: ts.toISOString(), ...event });
}

/**
 * The process's exit code and how long it ran, from `process.on("exit")`.
 * Node hands the listener the code as a signed byte (251 arrives as -5);
 * the log says what the shell sees.
 */
export function logExit(code: number, ms: number): void {
  eventLog()?.append({ type: "exit", ts: new Date().toISOString(), code: ((code % 256) + 256) % 256, ms });
}
