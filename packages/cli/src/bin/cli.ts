#!/usr/bin/env node
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { app } from "@/app";
import { initVersionCheck, printUpdateNoticeIfAvailable } from "@/lib/version-check";

// Start version check immediately (non-blocking)
initVersionCheck();

// Run the CLI command
await run(app, process.argv.slice(2), buildContext(process));

// After command completes normally, show update notice if available
await printUpdateNoticeIfAvailable();
