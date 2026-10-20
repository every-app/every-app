import { buildCommand } from "@stricli/core";
import { jsonFlag, verboseFlag } from "../flags";

export const loginCommand = buildCommand({
  loader: async () => {
    const { login } = await import(".");
    return login;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Log in to Cloudflare",
    fullDescription: [
      "Log in to Cloudflare",
      "",
      "At a terminal, Cloudflare's own login runs (open its link and enter the code). Piped, or",
      "with --json, the link and code are printed and the run waits for the login to be approved.",
      "Already logged in, it says as whom. Unattended runs can set CLOUDFLARE_API_TOKEN and",
      "CLOUDFLARE_ACCOUNT_ID instead.",
    ].join("\n"),
  },
});
