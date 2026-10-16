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
import { checkoutSource } from "@/lib/gateway/checkoutRelease";
import { openInBrowser } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import { handTerminalOver } from "@/lib/output/terminal";
import { runSetup, type SetupFlags } from "./runSetup";

export async function setup(
  this: LocalContext,
  flags: SetupFlags,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const { gatewayUrl, organizationName } = await runSetup(flags, out, {
        createCf: (accountId) => createCfRunner({ accountId }),
        openRelease: () => openGatewayRelease({ out, verbose: flags.verbose }),
        source: () => checkoutSource(checkoutRoot()),
        interactive: canPromptInTerminal(flags.json ?? false),
        prompts: terminalPrompts,
        openBrowser: openInBrowser,
        cliVersion,
      });
      const todoApp =
        path.relative(process.cwd(), path.join(checkoutRoot(), "apps", "todo-app")) || ".";
      out.emit({
        type: "done",
        message: `Your Gateway is ready: ${gatewayUrl}${organizationName ? ` (${organizationName})` : ""}`,
        data: {
          gatewayUrl,
          organizationName,
          // Said once, here: what to do next, then what can come any time.
          next: [
            `${CLI} app create my-app`,
            `Deploy the todo app from this repository: cd ${todoApp} && pnpm run deploy`,
            `Invite people, and decide who opens which app: ${gatewayUrl}/admin`,
            `AI for apps, any time: ${CLI} gateway secret set OPENAI_API_KEY`,
            `Email for invitations and password resets (until then they are links to share): onboard the domain for Cloudflare Email Sending, then ${CLI} gateway secret set EMAIL_FROM`,
          ],
        },
      });
    },
    { verbose: flags.verbose },
  );
}

const terminalPrompts = {
  async pickZone(zones: string[]): Promise<string> {
    handTerminalOver();
    const { zone } = await enquirer.prompt<{ zone: string }>({
      type: "select",
      name: "zone",
      message: "Which of your domains should Every App live under?",
      choices: zones,
    });
    return zone;
  },
  async hostname(zone: string): Promise<string> {
    handTerminalOver();
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
