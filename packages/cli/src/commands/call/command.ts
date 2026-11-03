import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { apiFlags } from "../flags";

export const callCommand = buildCommand({
  loader: async () => (await import(".")).call,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "tool",
          brief: "The tool's name, as --list shows it (everyapp_workspace_users, crm_list_contacts)",
          parse: String,
          optional: true,
        },
        {
          placeholder: "json",
          brief: "The tool's arguments as one JSON object (default {}); - reads them from stdin",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      list: { kind: "boolean", optional: true, brief: "List every tool you can call, with its title, instead of calling one" },
      ...apiFlags,
    },
  },
  docs: {
    brief: "Call one of the Gateway's tools: every admin action (everyapp_*) and every app's tools",
    fullDescription: [
      "The Gateway's tools are its one admin API: the same services as Manage workspace and the",
      "same tools an AI app gets on <gateway>/mcp, run as you. The workspace, events and ai",
      "commands are each one of them; this reaches all of them, and the apps' tools too. The",
      "answer is printed as the tool gives it; --json puts it in the done event's data.",
      "",
      "As whom: EVERYAPP_TOKEN (a personal access token from Manage workspace → Tokens), else the",
      `sign-in ${CLI} login --gateway stored, else a sign-in now in the browser.`,
      "",
      "Examples:",
      `  ${CLI} call --list`,
      `  ${CLI} call everyapp_workspace_users`,
      `  ${CLI} call everyapp_workspace_invite '{"email":"ann@example.com","role":"admin"}'`,
      `  echo '{"query":"contacts"}' | ${CLI} call everyapp_search_tools - --json`,
    ].join("\n"),
  },
});
