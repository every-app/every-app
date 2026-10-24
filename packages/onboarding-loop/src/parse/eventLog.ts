/**
 * Pure functions over the CLI's event log (design 4.5): the everyapp
 * commands a run made, with their flags, exit codes and the events each
 * emitted; the setup step's status and reruns; where the owner link was
 * emitted. Everything the record needs that no harness stream can
 * truncate.
 */
import { claimLinkOf, parseEventLogLine } from "../claim";
import type { EventLogLine, EveryappCommand } from "../types";

export const PARSER_VERSION = 1;

export function parseEventLog(text: string): EventLogLine[] {
  return text.split("\n").flatMap((line) => {
    const parsed = parseEventLogLine(line);
    return parsed ? [parsed] : [];
  });
}

/** Everything the log says about one everyapp process, in order. */
export interface CommandTrace extends EveryappCommand {
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  events: EveryappCommand["events"] & {
    steps: Array<{ step: string; status: string; ts: string }>;
    done: boolean;
    doneData: Record<string, unknown> | null;
  };
  /** The claim link's ts, when this process emitted one. */
  linkEmittedAt: string | null;
}

/** A launcher word in front of the command: node, a script path, pnpm/npx/exec/dlx, or everyapp itself. */
const LAUNCHER =
  /(^|\/)node(\d+)?$|\.(c|m)?[jt]s$|(^|\/)everyapp$|^(pnpm|npx|npm|exec|dlx|run)$/;

/** The argv after the launcher: `pnpm everyapp setup --json` and `node …/cli.js setup --json` → ["setup","--json"]. */
export function everyappArgv(argv: string[]): string[] {
  let start = 0;
  while (start < argv.length && LAUNCHER.test(argv[start]!)) start += 1;
  return argv.slice(start);
}

/**
 * Group the log into commands: an `invocation` opens one, events with the
 * same pid (or, lacking pids, the current open command) attach to it, an
 * `exit` closes it. A command with no exit ended by a kill or is still
 * running: `endedBy: unknown`.
 */
export function everyappCommandsFrom(lines: EventLogLine[]): CommandTrace[] {
  const commands: CommandTrace[] = [];
  const open = new Map<number | null, CommandTrace>();
  let current: CommandTrace | null = null;
  for (const line of lines) {
    if (line.type === "invocation") {
      const trace: CommandTrace = {
        pid: line.pid,
        argv: everyappArgv(line.argv),
        cwd: line.cwd,
        json: line.json,
        ci: line.ci,
        exit: null,
        ms: null,
        events: {
          warnings: [],
          actions: [],
          errors: [],
          steps: [],
          done: false,
          doneData: null,
        },
        endedBy: "unknown",
        startedAt: line.ts,
        endedAt: null,
        linkEmittedAt: null,
      };
      commands.push(trace);
      open.set(line.pid, trace);
      current = trace;
      continue;
    }
    const pid = "pid" in line && typeof line.pid === "number" ? line.pid : null;
    const trace = (pid !== null ? open.get(pid) : undefined) ?? current;
    if (!trace) continue;
    if (line.type === "exit") {
      trace.exit = line.code;
      trace.ms = line.ms;
      trace.endedBy = "exit";
      trace.endedAt = line.ts;
      open.delete(trace.pid);
      if (current === trace) current = null;
      continue;
    }
    switch (line.type) {
      case "warning":
        trace.events.warnings.push(line.code);
        break;
      case "error":
        trace.events.errors.push(line.code);
        break;
      case "action_required":
        trace.events.actions.push(line.action);
        if (claimLinkOf(line)) trace.linkEmittedAt = line.ts;
        break;
      case "step":
        trace.events.steps.push({
          step: line.step,
          status: line.status,
          ts: line.ts,
        });
        break;
      case "done":
        trace.events.done = true;
        trace.events.doneData = line.data ?? null;
        break;
      default:
        break;
    }
  }
  return commands;
}

/** The record's everyappCommands[], without the parser-only fields. */
export function toEveryappCommands(traces: CommandTrace[]): EveryappCommand[] {
  return traces.map((trace) => ({
    argv: trace.argv,
    cwd: trace.cwd,
    json: trace.json,
    ci: trace.ci,
    exit: trace.exit,
    ms: trace.ms,
    events: {
      warnings: trace.events.warnings,
      actions: trace.events.actions,
      errors: trace.events.errors,
    },
    endedBy: trace.endedBy,
  }));
}

function isCommand(
  trace: Pick<EveryappCommand, "argv">,
  name: string,
): boolean {
  return trace.argv[0] === name;
}

/** The setup step as the record carries it: done, error, stopped on an action, or never run; reruns = runs after the first. */
export function setupSummary(traces: CommandTrace[]): {
  status: "done" | "error" | "action_required" | "never_ran";
  reruns: number;
} {
  const setups = traces.filter((trace) => isCommand(trace, "setup"));
  if (setups.length === 0) return { status: "never_ran", reruns: 0 };
  const last = setups[setups.length - 1]!;
  const status = setups.some((s) => s.events.done)
    ? "done"
    : last.exit === 1 || last.events.errors.length > 0
      ? "error"
      : "action_required";
  return { status, reruns: setups.length - 1 };
}

/** The app the harness created and deployed, from the event log alone. */
export function appFrom(traces: CommandTrace[]): {
  created: string | null;
  deployed: boolean;
  url: string | null;
} {
  const create = traces
    .filter((trace) => isCommand(trace, "create") && trace.events.done)
    .at(-1);
  const created = create
    ? (create.argv.find((word, i) => i > 0 && !word.startsWith("-")) ?? null)
    : null;
  const deploy = traces
    .filter((trace) => isCommand(trace, "deploy") && trace.events.done)
    .at(-1);
  const url =
    deploy && typeof deploy.events.doneData?.["url"] === "string"
      ? (deploy.events.doneData["url"] as string)
      : null;
  return { created, deployed: deploy !== undefined, url };
}

/** The actions, warnings and errors over every command, deduplicated in order. */
export function codesSeen(traces: CommandTrace[]): string[] {
  const seen: string[] = [];
  for (const trace of traces) {
    for (const code of [
      ...trace.events.actions,
      ...trace.events.warnings,
      ...trace.events.errors,
    ]) {
      if (!seen.includes(code)) seen.push(code);
    }
  }
  return seen;
}

/** Why OWNER_NOT_CLAIMED happened: the agent dropped --json, or set CI. */
export function ownerNotClaimedCause(
  traces: CommandTrace[],
): "dropped_json_flag" | "ci_set_by_harness" | null {
  const culprit = traces.find((trace) =>
    trace.events.warnings.includes("OWNER_NOT_CLAIMED"),
  );
  if (!culprit) return null;
  if (culprit.ci) return "ci_set_by_harness";
  if (!culprit.json) return "dropped_json_flag";
  return null;
}

/** Phases from the CLI's own timestamps: install is the harness's, the rest come from here. */
export function phasesFrom(
  traces: CommandTrace[],
): Array<{ name: string; startedAt: string; durationS: number }> {
  const phases: Array<{ name: string; startedAt: string; durationS: number }> =
    [];
  for (const trace of traces) {
    if (!trace.startedAt) continue;
    const name = trace.argv[0] ?? "everyapp";
    if (!["setup", "create", "deploy", "access"].includes(name)) continue;
    const durationS =
      trace.ms !== null
        ? Math.round(trace.ms / 1000)
        : trace.endedAt
          ? Math.round(
              (Date.parse(trace.endedAt) - Date.parse(trace.startedAt)) / 1000,
            )
          : 0;
    phases.push({ name, startedAt: trace.startedAt, durationS });
    if (name === "setup") {
      // Sub-phases from step timestamps: gateway (start→ok) and owner (link→ok).
      const steps = trace.events.steps;
      const gatewayStart = steps.find(
        (s) => s.step === "setup.gateway" && s.status === "start",
      );
      const gatewayOk = steps
        .filter((s) => s.step === "setup.gateway" && s.status === "ok")
        .at(-1);
      if (gatewayStart && gatewayOk) {
        phases.push({
          name: "setup.gateway",
          startedAt: gatewayStart.ts,
          durationS: Math.round(
            (Date.parse(gatewayOk.ts) - Date.parse(gatewayStart.ts)) / 1000,
          ),
        });
      }
      const ownerOk = steps.find(
        (s) => s.step === "setup.owner" && s.status === "ok",
      );
      if (trace.linkEmittedAt && ownerOk) {
        phases.push({
          name: "setup.owner",
          startedAt: trace.linkEmittedAt,
          durationS: Math.round(
            (Date.parse(ownerOk.ts) - Date.parse(trace.linkEmittedAt)) / 1000,
          ),
        });
      }
    }
  }
  return phases;
}
