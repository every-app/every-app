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
      gateway: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "url",
        brief: "Sign in to this Gateway instead: its admin API, which the workspace, events, ai and call commands use",
      },
      "sign-out": {
        kind: "boolean",
        optional: true,
        brief: "With --gateway: revoke this machine's sign-in there and forget it",
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Log in to Cloudflare, or sign in to a Gateway with --gateway",
    fullDescription: [
      "Log in to Cloudflare",
      "",
      "At a terminal, Cloudflare's own login runs (open its link and enter the code). Piped, or",
      "with --json, the link and code are printed and the run waits for the login to be approved.",
      "Already logged in, it says as whom. Unattended runs can set CLOUDFLARE_API_TOKEN and",
      "CLOUDFLARE_ACCOUNT_ID instead.",
      "",
      "Sign in to a Gateway (--gateway <url>)",
      "",
      "The workspace, events, ai and call commands are the Gateway's own tools, run as you. This",
      "opens the Gateway's consent page in the browser (under --json the link is in a progress",
      "event and the run waits): choose read & write and all apps for the admin commands. The",
      "grant is kept in ~/.config/everyapp/gateways.json (0600) and refreshed when stale; revoke",
      "it under Your connections there, or with --sign-out. Scripts and CI set",
      "EVERYAPP_TOKEN to a personal access token (Manage workspace → Tokens) instead.",
    ].join("\n"),
  },
});
