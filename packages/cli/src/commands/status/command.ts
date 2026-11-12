import { buildCommand } from "@stricli/core";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

export const statusCommand = buildCommand({
  loader: async () => {
    const { status } = await import(".");
    return status;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": accountFlag,
      gateway: gatewayFlag,
      json: jsonFlag,
      verbose: verboseFlag,
      all: {
        kind: "boolean",
        brief: "List every app setting, set or not (by default only the ones an app is waiting for)",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Show the Gateway, its apps and anything to fix",
    fullDescription: [
      "One screen, all of it from the Gateway's D1 database and cf, nothing asked of the Gateway:",
      "its URL and release (and whether this checkout builds it), its owner, the apps its registry",
      "lists and whether the live Gateway binds them, each hostname's certificate, any deploy in",
      "progress, the settings an app is waiting for (--all lists every setting), and what to run",
      "when something is off. With --json, the `done` event's data has",
      "all of it, `fixes` included: the one state query an agent needs. An account with several",
      "Gateways: --gateway <url|name> says which.",
    ].join("\n"),
  },
});
