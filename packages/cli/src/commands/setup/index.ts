import chalk from "chalk";
import type { LocalContext } from "@/context";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts } from "@/lib/output/table";
import { duration } from "@/lib/output/time";
import {
  runSetup,
  setupDeps,
  type SetupDeps,
  type SetupFlags,
  type SetupResult,
} from "./runSetup";

export async function setup(
  this: LocalContext,
  flags: SetupFlags,
): Promise<void> {
  await runGatewayCommand(flags, (out, deps) => runSetup(flags, out, deps));
}

/** `setup` or `gateway deploy`, run with their dependencies, then what it did to the Gateway. */
export async function runGatewayCommand(
  flags: SetupFlags,
  run: (out: EventSink, deps: SetupDeps) => Promise<SetupResult>,
): Promise<void> {
  const began = Date.now();
  await runCommand(flags, async (out) => {
    const gateway = gatewayReleaseSource({ release: flags.release, out, verbose: flags.verbose });
    const result = await run(
      out,
      setupDeps({
        gateway: { openRelease: gateway.open, source: gateway.describe },
        interactive: canPromptInTerminal(flags.json ?? false),
      }),
    );
    const { gatewayUrl, organizationName, release, releaseName, owner } = result;
    const adminUrl = `${gatewayUrl}/admin`;
    const data = {
      gatewayUrl,
      adminUrl,
      organizationName,
      owner,
      release,
      gateway: result.gateway,
    };
    const gatewayFact = { label: "Gateway", value: gatewayUrl };

    // An upgrade says what it upgraded to, in how long.
    if (result.gateway === "upgraded" && !result.ownerCreated) {
      out.emit({
        type: "done",
        message: `Upgraded to ${releaseName}`,
        data,
        display: [
          ...formatFacts([{ label: "Gateway", value: chalk.cyan(gatewayUrl) }]),
          chalk.dim(`Upgraded to ${releaseName} in ${duration(Date.now() - began)}`),
        ].join("\n"),
      });
      return;
    }
    // Nobody to claim it (CI): where it is; the warning said the rest.
    if (!owner) {
      out.emit({ type: "done", data: { ...data, facts: [gatewayFact] } });
      return;
    }
    // A new Gateway, or its owner just made: what to do next.
    if (result.gateway === "installed" || result.ownerCreated) {
      out.emit({
        type: "done",
        data: {
          ...data,
          facts: [
            gatewayFact,
            { label: "Admin", value: adminUrl, note: "invite people, choose who opens which app" },
          ],
          next: [
            { command: `${CLI} create my-app`, note: "start your first app" },
            { command: `${CLI} secret set OPENAI_API_KEY`, note: "turn on AI for apps" },
            {
              command: `${CLI} secret set EMAIL_FROM`,
              note: "email invites; needs Cloudflare Email Sending",
            },
          ],
        },
      });
      return;
    }
    // Up to date, or repaired: where it is, and where to look next.
    out.emit({
      type: "done",
      data: {
        ...data,
        facts: [gatewayFact],
        ...(result.gateway === "up-to-date"
          ? { next: [{ command: `${CLI} status`, note: "see apps, domains and certificates" }] }
          : {}),
      },
    });
  });
}
