#!/usr/bin/env node
import chalk from "chalk";
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { buildApp, groupHelp, rootHelp, versionLine } from "@/app";
import { requestedExitCode } from "@/lib/exit-code";
import { logExit, logInvocation } from "@/lib/output/eventLog";
import type { EventSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { eventSink } from "@/lib/output/run";
import { colorEnabled } from "@/lib/output/terminal";
import { unsupportedRuntime } from "@/lib/runtime";

/**
 * What everyapp reads from the arguments before any command does: `--json`
 * (stays for the command; parse errors are NDJSON then too), the global
 * `--no-color` (taken out: no command declares it), and stricli's
 * `--help-all`/`-H`, read as `--help` so there is one help, not a second
 * root help in stricli's format. Arguments after `--` are a command's own.
 */
function globalOptions(argv: readonly string[]): {
  args: string[];
  json: boolean;
  noColor: boolean;
} {
  const end = argv.indexOf("--");
  const options = end < 0 ? argv : argv.slice(0, end);
  const own = (index: number) => end >= 0 && index > end;
  return {
    args: argv
      .filter((arg, index) => arg !== "--no-color" || own(index))
      .map((arg, index) => ((arg === "--help-all" || arg === "-H") && !own(index) ? "--help" : arg)),
    json: options.includes("--json"),
    noColor: options.includes("--no-color"),
  };
}

const { args, json, noColor } = globalOptions(process.argv.slice(2));
// With EVERYAPP_EVENT_LOG set, the process's start and end bracket its events there.
const started = Date.now();
logInvocation({ argv: process.argv.slice(2), json });
process.on("exit", (code) => logExit(code, Date.now() - started));
const color = colorEnabled(noColor);
if (!color) chalk.level = 0;
// What everyapp runs (cf attached to the terminal) doesn't color either.
if (noColor) process.env["NO_COLOR"] = "1";

const helpRequested = args.some((arg) => arg === "--help" || arg === "-h");
const runtimeProblem = unsupportedRuntime();
if (runtimeProblem) {
  // Refuse before any command starts a child that would fail obscurely,
  // through the one error path every command reports through.
  const out = eventSink(json);
  reportFailure(out, runtimeProblem);
  process.exitCode = out.exitCode;
} else if (args.length === 0 || (args.length === 1 && helpRequested)) {
  process.stdout.write(rootHelp());
} else if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  process.stdout.write(versionLine());
} else {
  const help = groupHelp(args);
  if (help) {
    process.stdout.write(help);
  } else {
    await runCommand();
  }
}

/**
 * Run the command through stricli. Whatever it refuses is reported
 * through the run's sink (`buildApp`): stricli's own writes to stderr are
 * dropped, and its exit code (251, 252) kept.
 */
async function runCommand(): Promise<void> {
  let out: EventSink | undefined;
  const app = buildApp({
    color,
    args,
    report: (problem) => {
      out ??= eventSink(json);
      out.emit({ type: "error", retryable: false, ...problem });
    },
  });
  const stricliProcess = {
    stdout: process.stdout,
    stderr: { write: () => true },
    env: process.env,
    exitCode: undefined as number | undefined,
  };
  await run(app, args, buildContext(stricliProcess as unknown as NodeJS.Process));
  const exitCode = requestedExitCode() ?? stricliProcess.exitCode;
  if (exitCode !== undefined) process.exitCode = exitCode;
}
