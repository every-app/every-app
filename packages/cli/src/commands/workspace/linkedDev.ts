/**
 * `everyapp workspace linked-dev on|off|show`: whether owners and admins
 * may sign `everyapp dev --gateway` in to the organization's apps
 * (lib/gateway/linkedDev.ts does the reading and writing).
 */
import chalk from "chalk";
import { readLinkedDev, setLinkedDev } from "@/lib/gateway/linkedDev";
import { CLI } from "@/lib/output/command";
import { runCommand } from "@/lib/output/run";
import type { LinkedDevSetting } from "./command";
import { connect, type WorkspaceFlags, type WorkspaceOptions } from "./shared";

export async function linkedDev(flags: WorkspaceFlags, setting: LinkedDevSetting = "show"): Promise<void> {
  await runCommand(flags, (out) => linkedDevCommand({ flags, out }, setting));
}

export async function linkedDevCommand(options: WorkspaceOptions, setting: LinkedDevSetting): Promise<void> {
  const { out } = options;
  const { ws, gatewayUrl } = await connect(options);
  const org = ws.organization;
  if (setting === "show") {
    const on = await readLinkedDev(ws);
    out.emit({
      type: "done",
      message: `Linked dev is ${on ? "on" : "off"} for ${org.name}`,
      display: on
        ? `Linked dev is ${chalk.green("on")} for ${org.name}: owners and admins can run ${chalk.cyan(`${CLI} dev --gateway ${gatewayUrl}`)} in an app's directory.`
        : `Linked dev is ${chalk.dim("off")} for ${org.name}. ${chalk.dim(`Turn it on with ${CLI} workspace linked-dev on.`)}`,
      data: { organization: org, linkedDev: on },
    });
    return;
  }
  const on = setting === "on";
  const change = await setLinkedDev(ws, on);
  const changed = change.on !== change.was;
  out.emit({
    type: "done",
    message: changed
      ? `Linked dev is now ${on ? "on" : "off"} for ${org.name}`
      : `Linked dev was already ${on ? "on" : "off"} for ${org.name}. Nothing changed.`,
    display: [
      changed
        ? `Linked dev is now ${on ? chalk.green("on") : chalk.dim("off")} for ${org.name}.`
        : `Linked dev was already ${on ? "on" : "off"} for ${org.name}. Nothing changed.`,
      on
        ? chalk.dim(
            `Owners and admins can run ${CLI} dev --gateway ${gatewayUrl} in an app's directory; the app's AI, email, providers and members then go through this Gateway and bill ${org.name}'s providers.`,
          )
        : chalk.dim("Linked dev tokens already issued stop working on their next call."),
    ].join("\n"),
    data: { organization: org, linkedDev: on, was: change.was, changed },
  });
}
