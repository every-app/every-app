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
          "Take each unset setting's value, optional features' too, from the environment variable of its name (DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY; multi-line values such as a PEM are kept); a set name is never replaced; stdin isn't read; the rest are asked for at a terminal",
        optional: true,
      },
      gateway: gatewayFlag,
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Set up an app: asks for what it needs, feature by feature, with each feature's steps",
    fullDescription: [
      "Reads what the app's everyapp.config.ts declares (AI providers, capabilities, its own",
      "secrets and settings, grouped into features) and what is set. It asks for each top-level",
      "value that isn't set (hidden input, with where to get it beside each), then walks each",
      "required feature: its numbered steps, then each value with where it lives. Then it asks",
      "\"Set up <name>?\" for each optional feature that's off. A generated secret is made for",
      "you (and shown once when you paste it somewhere); a file's prompt takes its path.",
      "Run it again any time: it shows what is set (names only, never values). Once everything",
      "is set it asks nothing and exits; to change a set value, use secret set (below). With",
      "--json, the done event's data.features has every feature's steps, values and state.",
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
      `Change a set value, by name: ${CLI} secret set <NAME> --app <id> (a Gateway setting`,
      "changes for every app).",
    ].join("\n"),
  },
});
