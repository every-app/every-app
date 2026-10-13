#!/usr/bin/env node
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { app } from "@/app";
import { requestedExitCode } from "@/lib/exit-code";
import { unsupportedRuntimeReason } from "@/lib/runtime";
import { initVersionCheck, printUpdateNoticeIfAvailable } from "@/lib/version-check";

// Refuse before any command starts a child that would fail obscurely.
const runtimeProblem = unsupportedRuntimeReason();
if (runtimeProblem) {
  console.error(runtimeProblem);
  process.exit(1);
}

// Start version check immediately (non-blocking)
initVersionCheck();

// Run the CLI command
await run(app, process.argv.slice(2), buildContext(process));
const exitCode = requestedExitCode();
if (exitCode !== undefined) process.exitCode = exitCode;

// After command completes normally, show update notice if available — but
// never in --json mode, where stdout carries only NDJSON events.
if (!process.argv.includes("--json")) {
  await printUpdateNoticeIfAvailable();
}
