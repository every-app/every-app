#!/usr/bin/env node
import { proposeCompletions } from "@stricli/core";
import { buildContext } from "@/context";
import { app } from "@/app";
const inputs = process.argv.slice(3);
if (process.env["COMP_LINE"]?.endsWith(" ")) {
  inputs.push("");
}
await proposeCompletions(app, inputs, buildContext(process));
try {
  for (const { completion } of await proposeCompletions(
    app,
    inputs,
    buildContext(process),
  )) {
    process.stdout.write(`${completion}\n`);
  }
} catch {
  // ignore
}
