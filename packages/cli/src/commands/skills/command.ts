import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { jsonFlag } from "../flags";

const updateCommand = buildCommand({
  loader: async () => {
    const { update } = await import(".");
    return update;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Replace this app's copies of the skills with the ones this CLI ships",
    fullDescription: [
      "Replace the app's copies of the skills with the ones this CLI ships",
      "",
      "Run in the app's directory (the one with everyapp.config.ts). Each skill the CLI ships",
      "(everyapp, build-every-app) is copied to .claude/skills/<name> and .agents/skills/<name>,",
      "as create does: a copy that differs is replaced whole, so files no longer shipped go too,",
      "and a missing skill is added. Other directories under those folders are left alone.",
      "AGENTS.md gets a line for any skill it doesn't mention. Prints what was added, updated",
      "or left unchanged; with --json, done carries each copy's files added, updated and removed.",
      "",
      "EXAMPLES",
      `  $ ${CLI} skills update`,
      `  $ ${CLI} skills update --json`,
    ].join("\n"),
  },
});

export const skillsRoutes = buildRouteMap({
  routes: {
    update: updateCommand,
  },
  docs: {
    brief: "Keep the agent skills in an app up to date with the CLI",
  },
});
