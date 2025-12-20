#!/usr/bin/env node
import { run } from "@stricli/core";
import { buildContext } from "@/context";
import { app } from "@/app";
await run(app, process.argv.slice(2), buildContext(process));
