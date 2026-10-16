#!/usr/bin/env node
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { app } from "@/app";
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
} else {
  await run(app, process.argv.slice(2), buildContext(process));
  const exitCode = requestedExitCode();
  if (exitCode !== undefined) process.exitCode = exitCode;
}
