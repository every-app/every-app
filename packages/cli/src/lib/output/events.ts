/**
 * Progress events for commands that agents and scripts drive.
 *
 * With `--json`, stdout carries only these events, one JSON object per line
 * (NDJSON), each `{ v: 1, ts, type, … }`. People get the same events as
 * plain lines instead. A run ends with exit code 0 when done, 2 when it
 * stopped on `action_required` (re-run the same command to resume once the
 * action is taken), and 1 after an error, whatever came before it.
 *
 * An `action_required` with `data.waiting: true` is one the run waits for
 * (a login to approve, a setup link to open): pass its `url` and `code` to
 * a person and keep reading. If it is taken in time the run goes on and
 * ends `done` (exit 0), or with an error (exit 1) like any run; if not, a
 * last `action_required` ends it (exit 2).
 */
import chalk from "chalk";

type EventData = Record<string, unknown>;

type StepStatus = "start" | "ok" | "skip" | "fail";

/** Something only a person can do before the command can continue. */
export type RequiredAction =
  | "cloudflare_login"
  | "register_workers_subdomain"
  | "claim_owner"
  | "upgrade_workers_paid"
  | "rerun_interactive"
  | "add_domain"
  | "create_deploy_token";

interface ActionData extends EventData {
  url?: string;
  /** A one-time code to enter at `url` (device login). */
  code?: string;
  expiresAt?: string;
  /** The run waits for it, rather than stopping. */
  waiting?: boolean;
}

interface EventBase {
  v: 1;
  ts: string;
}

type EveryAppEvent = EventBase &
  (
    | {
        type: "step";
        step: string;
        status: StepStatus;
        message?: string;
        data?: EventData;
      }
    | { type: "progress"; step: string; message: string; data?: EventData }
    | {
        type: "warning";
        code: string;
        message: string;
        step?: string;
        data?: EventData;
      }
    | {
        type: "action_required";
        action: RequiredAction;
        message: string;
        step?: string;
        data?: ActionData;
      }
    | {
        type: "error";
        code: string;
        message: string;
        retryable: boolean;
        step?: string;
        data?: EventData;
      }
    | { type: "done"; message?: string; data?: EventData }
  );

/** Distributes over the union so each variant keeps its own fields. */
type EventInput<E> = E extends EveryAppEvent ? Omit<E, "v" | "ts"> : never;

export interface EventSink {
  emit(event: EventInput<EveryAppEvent>): void;
  /**
   * 1 once an error was emitted; else 2 once the run stopped on an action,
   * or while it waits for one (until it is done); else 0.
   */
  readonly exitCode: number;
}

/** Emit events as NDJSON lines on `write` (stdout by default). */
export function createNdjsonSink(
  write: (line: string) => void = (line) => process.stdout.write(line),
  now: () => Date = () => new Date(),
): EventSink {
  return trackExitCode((event) => {
    write(`${JSON.stringify({ v: 1, ts: now().toISOString(), ...event })}\n`);
  });
}

/**
 * Print events for a person: progress as plain lines on stdout, warnings and
 * errors highlighted on stderr.
 */
export function createHumanSink(
  log: (line: string) => void = (line) => console.log(line),
  logProblem: (line: string) => void = (line) => console.error(line),
): EventSink {
  return trackExitCode((event) => {
    switch (event.type) {
      case "step":
        if (event.message) {
          log(
            event.status === "fail"
              ? chalk.red(event.message)
              : event.status === "start"
                ? chalk.dim(event.message)
                : event.message,
          );
        }
        return;
      case "progress":
        log(chalk.dim(event.message));
        return;
      case "warning":
        logProblem(chalk.yellow(event.message));
        return;
      case "action_required":
        log(chalk.yellow(event.message));
        if (event.data?.url) log(`  ${chalk.cyan(event.data.url)}`);
        if (event.data?.code) log(`  Code: ${chalk.bold(event.data.code)}`);
        return;
      case "error":
        logProblem(chalk.red(event.message));
        return;
      case "done":
        if (event.message) log(chalk.green(event.message));
        return;
    }
  });
}

function trackExitCode(
  write: (event: EventInput<EveryAppEvent>) => void,
): EventSink {
  let failed = false;
  let stopped = false;
  let waiting = false;
  return {
    emit(event) {
      if (event.type === "error") failed = true;
      else if (event.type === "action_required") {
        if (event.data?.waiting) waiting = true;
        else stopped = true;
      }
      // Done after the actions it waited for were taken.
      else if (event.type === "done") waiting = false;
      write(event);
    },
    get exitCode() {
      if (failed) return 1;
      return stopped || waiting ? 2 : 0;
    },
  };
}
