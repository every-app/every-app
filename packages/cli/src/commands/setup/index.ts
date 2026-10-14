import path from "node:path";
import enquirer from "enquirer";
import type { LocalContext } from "@/context";
import {
  cliVersion,
  eventSink,
  openGatewayRelease,
  runReported,
} from "@/commands/gateway/shared";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { checkoutRoot } from "@/lib/checkout";
import { createCfRunner } from "@/lib/cf/runner";
import { normalizeHostname } from "@/lib/domains/hostnames";
import { GatewayClient } from "@/lib/gateway/api";
import { openInBrowser } from "@/lib/gateway/setup-link";
import { runSetup, type SetupFlags } from "./runSetup";

export async function setup(
  this: LocalContext,
  flags: SetupFlags,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      const { gatewayUrl, organizationName } = await runSetup(flags, out, {
        createCf: (accountId) => createCfRunner({ accountId }),
        gatewayClient: (gatewayUrl) => new GatewayClient({ gatewayUrl }),
        openRelease: () => openGatewayRelease({ out }),
        interactive: canPromptInTerminal(flags.json ?? false),
        prompts: terminalPrompts,
        openBrowser: openInBrowser,
        cliVersion,
      });
      const todoApp =
        path.relative(process.cwd(), path.join(checkoutRoot(), "apps", "todo-app")) || ".";
      const next: Array<[string, string]> = [
        [`cd ${todoApp} && pnpm run deploy`, "deploy an app from this repository"],
        ["everyapp app create", "start a new app in apps/"],
        [`${gatewayUrl}/admin`, "invite people, decide who opens which app"],
      ];
      const width = Math.max(...next.map(([command]) => command.length));
      out.emit({
        type: "done",
        message: [
          "Every App is ready.",
          `  Gateway:  ${gatewayUrl}${organizationName ? ` (${organizationName})` : ""}`,
          "",
          "Next:",
          ...next.map(([command, what]) => `  ${command.padEnd(width)}   ${what}`),
        ].join("\n"),
        data: { gatewayUrl, organizationName },
      });
    },
    { verbose: flags.verbose },
  );
}

const terminalPrompts = {
  async confirm(message: string): Promise<boolean> {
    const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message,
      initial: true,
    });
    return confirmed;
  },
  async pickZone(zones: string[]): Promise<string> {
    const { zone } = await enquirer.prompt<{ zone: string }>({
      type: "select",
      name: "zone",
      message: "Which of your domains should Every App live under?",
      choices: zones,
    });
    return zone;
  },
  async hostname(zone: string): Promise<string> {
    const { hostname } = await enquirer.prompt<{ hostname: string }>({
      type: "input",
      name: "hostname",
      message: `The gateway's address (apps live one level below it; a subdomain keeps the rest of ${zone} out of it)`,
      initial: `apps.${zone}`,
      validate: (value: string) => {
        try {
          const host = normalizeHostname(value);
          return host === zone || host.endsWith(`.${zone}`)
            ? true
            : `Use ${zone} or a name under it`;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    return hostname;
  },
};
