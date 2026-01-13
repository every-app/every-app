#!/usr/bin/env node
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { app } from "@/app";
import { startVersionCheck, printUpdateNotice } from "@/lib/version-check";

// Start version check immediately (non-blocking)
const versionCheckPromise = startVersionCheck();

// Run the CLI command
await run(app, process.argv.slice(2), buildContext(process));

// After command completes, show update notice if available
const versionCheckResult = await versionCheckPromise;
printUpdateNotice(versionCheckResult);
