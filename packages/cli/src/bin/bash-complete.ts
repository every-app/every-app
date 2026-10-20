#!/usr/bin/env node
import { proposeCompletions } from "@stricli/core";
import { buildContext } from "@/context";
import { completionApp } from "@/app";
const inputs = process.argv.slice(3);
if (process.env["COMP_LINE"]?.endsWith(" ")) {
  inputs.push("");
}
try {
  for (const { completion } of await proposeCompletions(
    completionApp,
    inputs,
    buildContext(process),
  )) {
    process.stdout.write(`${completion}\n`);
  }
} catch {
  // ignore
}
