import { buildCommand, buildRouteMap } from "@stricli/core";
import { accountFlag, gatewayFlag, resultJsonFlag } from "../flags";

const workflowArgument = {
  brief: "The Workflow: its binding in everyapp.config.ts, its class or its name",
  parse: String,
  placeholder: "workflow",
};
const instanceArgument = {
  brief: "The instance id",
  parse: String,
  placeholder: "instance-id",
};
const workflowFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: resultJsonFlag,
} as const;

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: workflowFlags,
  },
  docs: {
    brief: "List the app's Workflows and how many instances each has, by status",
  },
});

const instancesCommand = buildCommand({
  loader: async () => {
    const { instances } = await import(".");
    return instances;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [workflowArgument] },
    flags: {
      ...workflowFlags,
      status: {
        kind: "enum",
        values: [
          "queued",
          "running",
          "paused",
          "waiting",
          "waitingForPause",
          "errored",
          "terminated",
          "complete",
          "rollingBack",
        ],
        brief: "Only instances with this status",
        optional: true,
      },
      limit: {
        kind: "parsed",
        parse: (value: string) => {
          const limit = Number(value);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("--limit must be a whole number from 1 to 100");
          }
          return limit;
        },
        brief: "How many to list (1-100, default 25)",
        optional: true,
      },
    },
  },
  docs: { brief: "List a Workflow's instances" },
});

const getCommand = buildCommand({
  loader: async () => {
    const { get } = await import(".");
    return get;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [workflowArgument, instanceArgument],
    },
    flags: workflowFlags,
  },
  docs: {
    brief: "Show an instance: its status, params, steps, output and error",
  },
});

const startCommand = buildCommand({
  loader: async () => {
    const { start } = await import(".");
    return start;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [workflowArgument] },
    flags: {
      ...workflowFlags,
      params: {
        kind: "parsed",
        parse: String,
        brief: "The instance's params, as JSON",
        optional: true,
      },
      id: {
        kind: "parsed",
        parse: String,
        brief: "The instance id (default: one Cloudflare picks)",
        optional: true,
      },
    },
  },
  docs: { brief: "Start an instance of a Workflow" },
});

function statusCommand(status: "pause" | "resume" | "restart", brief: string) {
  return buildCommand({
    loader: async () => (await import("."))[status],
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [workflowArgument, instanceArgument],
      },
      flags: workflowFlags,
    },
    docs: { brief },
  });
}

const terminateCommand = buildCommand({
  loader: async () => {
    const { terminate } = await import(".");
    return terminate;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [workflowArgument, instanceArgument],
    },
    flags: {
      ...workflowFlags,
      yes: { kind: "boolean", brief: "Skip the confirmation", optional: true },
    },
    aliases: { y: "yes" },
  },
  docs: { brief: "Stop an instance for good (asks first)" },
});

export const workflowsRoutes = buildRouteMap({
  routes: {
    list: listCommand,
    instances: instancesCommand,
    get: getCommand,
    start: startCommand,
    pause: statusCommand("pause", "Pause an instance"),
    resume: statusCommand("resume", "Resume a paused instance"),
    terminate: terminateCommand,
    restart: statusCommand("restart", "Run an instance again from the start"),
  },
  docs: {
    brief: "List and control the app's Workflows",
  },
});
