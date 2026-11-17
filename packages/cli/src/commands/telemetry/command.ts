import { buildCommand } from "@stricli/core";
import { USAGE_REPORT_DOCS_URL } from "@every-app/sdk/internal";
import { CLI } from "@/lib/output/command";
import { apiFlags } from "../flags";

/** Turn usage reports on or off, or show them. */
export type TelemetrySetting = "on" | "off" | "show";

function parseSetting(value: string): TelemetrySetting {
  const setting = value.trim().toLowerCase();
  if (setting === "on" || setting === "off" || setting === "show") return setting;
  throw new Error("Use on, off or show.");
}

export const telemetryCommand = buildCommand({
  loader: async () => (await import(".")).telemetry,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "on|off|show",
          brief: "Turn the Gateway's usage reports on or off, or show them with the next report (default)",
          parse: parseSetting,
          optional: true,
        },
      ],
    },
    flags: apiFlags,
  },
  docs: {
    brief: "See the daily usage report this Gateway sends Every App, or turn it off",
    fullDescription: [
      "Once a day a self-hosted Gateway sends Every App a few rounded counts: members, apps, how",
      "many people used each app, AI tool calls, the version. Never a domain, a name, an email or",
      "anything inside an app. `show` prints the exact report that goes next. `off` stops reports at",
      "once and deletes the random ID they carried. The same as Manage workspace → Usage reports.",
      "The CLI itself sends nothing.",
      "",
      `What is sent and why: ${USAGE_REPORT_DOCS_URL}`,
      "",
      "The Gateway tools: everyapp_workspace_telemetry_show to read, everyapp_workspace_telemetry to change.",
      "",
      "Examples:",
      `  ${CLI} telemetry`,
      `  ${CLI} telemetry off`,
      `  ${CLI} telemetry show --json`,
    ].join("\n"),
  },
});
