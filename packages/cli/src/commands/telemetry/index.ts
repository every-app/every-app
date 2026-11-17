/**
 * `everyapp telemetry [on|off|show]`: the Gateway's daily usage report to
 * Every App (https://everyapp.com/docs/telemetry), read and switched through
 * the Gateway's own tools as Manage workspace → Usage reports does. The CLI
 * sends nothing itself; this only shows and changes what the Gateway does.
 */
import { runTool, type ToolCommandFlags } from "@/lib/gatewayApi/command";
import type { JsonObject } from "@/lib/gatewayApi";
import { CLI } from "@/lib/output/command";
import { commandLines } from "@/lib/output/result";
import type { TelemetrySetting } from "./command";

const str = (value: unknown) => (typeof value === "string" ? value : "");
const obj = (value: unknown): JsonObject | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null);

/** Why reports are off, as a person reads it. */
function whyOff(reason: string): string {
  switch (reason) {
    case "setting":
      return "The TELEMETRY_DISABLED setting is set, so nothing is sent and reports can't be turned on.";
    case "unpublished":
      return "This Gateway was built from source, so it sends nothing.";
    case "unavailable":
      return "This Gateway doesn't send usage reports.";
    default:
      return "Nothing is sent.";
  }
}

/** The lines under the headline: where things stand, the next report, and the one command that changes it. */
function blocks(answer: JsonObject): string[][] {
  const on = answer["usageReports"] === "on";
  const notice = obj(answer["notice"]);
  const lastDay = str(answer["lastReportedDay"]);
  const next = obj(answer["nextReport"]);
  const state = on
    ? notice
      ? [str(notice["headline"])]
      : [lastDay ? `The last report was for ${lastDay}.` : "No report has been sent yet."]
    : [whyOff(str(answer["reason"]))];
  const change =
    answer["canChange"] === false
      ? []
      : on || answer["reason"] === "unpublished"
        ? commandLines("Turn them off", [`${CLI} telemetry off`])
        : commandLines("Turn them on", [`${CLI} telemetry on`]);
  return [state, next ? ["The next report, exactly as it is sent:", ...JSON.stringify(next, null, 2).split("\n")] : [], change];
}

export const telemetry = (flags: ToolCommandFlags, setting: TelemetrySetting = "show") =>
  runTool(flags, {
    tool: setting === "show" ? "everyapp_workspace_telemetry_show" : "everyapp_workspace_telemetry",
    args: setting === "show" ? {} : { on: setting === "on" },
    done: (answer) => `Usage reports are ${str(answer["usageReports"]) || "off"}`,
    display: () => "",
    short: (answer) => {
      const state = str(answer["usageReports"]) || "off";
      if (setting === "show") return { headline: `Usage reports are ${state}`, ticked: false, blocks: blocks(answer) };
      // The Gateway may still send nothing after "on" (a build from source): say what is true.
      const turned = state === setting || (setting === "on" && answer["reason"] === "unpublished");
      const headline = !turned ? `Usage reports are ${state}` : answer["changed"] === true ? `Turned ${setting} usage reports` : `Usage reports are already ${setting}`;
      return { headline, blocks: setting === "off" ? [["Nothing more is sent. The random ID the reports carried is deleted."]] : blocks(answer).slice(0, 1) };
    },
  });
