#!/usr/bin/env node
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { app, rootHelp } from "@/app";
import { EveryAppError } from "@/lib/errors";
import { requestedExitCode } from "@/lib/exit-code";
import { reportFailure } from "@/lib/output/report";
import { eventSink } from "@/lib/output/run";
import { unsupportedRuntimeReason } from "@/lib/runtime";

// Refuse before any command starts a child that would fail obscurely,
// through the one error path every command reports through.
const runtimeProblem = unsupportedRuntimeReason();
if (runtimeProblem) {
  const out = eventSink(process.argv.includes("--json"));
  reportFailure(out, new EveryAppError("UNSUPPORTED_RUNTIME", runtimeProblem));
  process.exitCode = out.exitCode;
} else if (isRootHelp(process.argv.slice(2))) {
  process.stdout.write(rootHelp());
} else {
  await run(app, process.argv.slice(2), buildContext(process));
  const exitCode = requestedExitCode();
  if (exitCode !== undefined) process.exitCode = exitCode;
}

/** No command, or just --help: everyapp's own overview, grouped. */
function isRootHelp(args: readonly string[]): boolean {
  return args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"));
}
