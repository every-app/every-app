import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

export const configureCommand = buildCommand({
  loader: async () => {
    const { configure } = await import(".");
    return configure;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "The app to configure (default: the app in this directory)",
          parse: String,
          placeholder: "app",
          optional: true,
        },
      ],
    },
    flags: {
      "from-env": {
        kind: "boolean",
        brief:
          "Take each unset setting's value, optional ones too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal",
        optional: true,
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Set up an app: asks for each setting it needs, required ones first, then the optional ones",
    fullDescription: [
      "Reads what the app's everyapp.config.ts declares (AI providers, capabilities, its own",
      "secrets) and what is set, then asks for each required setting that isn't (hidden input,",
      "with where to get it beside each), offers the optional ones (Enter skips them all), and",
      "says whether the app is ready. One member of an any-of group is enough: it asks which.",
      "Run it again any time: it shows what is set (names only, never values) and lets you",
      "change one.",
      "",
      "Where they go: an AI provider's key or a capability's client is a Gateway setting, held",
      "once for every app on the Gateway Worker; the app's own secrets go on its Worker, after",
      "its first deploy. Changes are live at once; no deploy needed.",
      "",
      "For a script or a coding agent, which can't answer a prompt: pipe NAME=value lines in",
      "(one per line; # starts a comment only at the start of a line; a value is taken as it is,",
      "one pair of quotes around it dropped), or export the variables under the settings' own",
      "names and add --from-env (then stdin isn't read). A value never goes on the command line.",
      "",
      "Examples:",
      `  ${CLI} configure crm`,
      `  ${CLI} configure                       (in the app's directory)`,
      `  ${CLI} configure crm --from-env --json`,
      `  printf 'OPENROUTER_API_KEY=%s\\n' "$OPENROUTER_API_KEY" | ${CLI} configure crm --json`,
      "",
      `One setting at a time, by name: ${CLI} secret set <NAME> [--app <id>]`,
    ].join("\n"),
  },
});
