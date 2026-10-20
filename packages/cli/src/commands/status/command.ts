import { buildCommand } from "@stricli/core";
import { accountFlag, jsonFlag, verboseFlag } from "../flags";

export const statusCommand = buildCommand({
  loader: async () => {
    const { status } = await import(".");
    return status;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Show the Gateway, its apps and anything to fix",
    fullDescription: [
      "One screen, all of it from the Gateway's D1 database and cf, nothing asked of the Gateway:",
      "its URL and release (and whether this checkout builds it), its owner, the apps its registry",
      "lists and whether the live Gateway binds them, each hostname's certificate, any deploy in",
      "progress, and what to run when something is off. With --json, the `done` event's data has",
      "all of it, `fixes` included: the one state query an agent needs.",
    ].join("\n"),
  },
});
