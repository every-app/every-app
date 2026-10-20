import type { LocalContext } from "@/context";
import { gatewayReleaseSource } from "@/lib/gateway/source";
import { CLI } from "@/lib/output/command";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { runSetup, setupDeps, type SetupFlags } from "./runSetup";

export async function setup(
  this: LocalContext,
  flags: SetupFlags,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const gateway = gatewayReleaseSource({ release: flags.release, out, verbose: flags.verbose });
    const result = await runSetup(
      flags,
      out,
      setupDeps({
        gateway: { openRelease: gateway.open, source: gateway.describe },
        interactive: canPromptInTerminal(flags.json ?? false),
      }),
    );
    const { gatewayUrl, organizationName, release } = result;
    const data = {
      gatewayUrl,
      organizationName,
      release,
      gateway: result.gateway,
    };
    // A new Gateway, or its owner just made: what to do next, then what
    // can come any time. An upgrade or a repair says it is up to date;
    // nothing to do was said by the step already.
    if (result.gateway === "installed" || result.ownerCreated) {
      out.emit({
        type: "done",
        data: {
          ...data,
          facts: [
            { label: "Gateway", value: gatewayUrl },
            {
              label: "Admin",
              value: `${gatewayUrl}/admin`,
              note: "invite people, choose who opens which app",
            },
          ],
          next: [
            { command: `${CLI} create my-app`, note: "start your first app" },
            { command: `${CLI} secret set OPENAI_API_KEY`, note: "turn on AI for apps" },
            {
              command: `${CLI} secret set EMAIL_FROM`,
              note: "email invites and password resets; needs Cloudflare Email Sending",
            },
          ],
        },
      });
      return;
    }
    out.emit({
      type: "done",
      message:
        result.gateway === "upgraded"
          ? `Gateway ${release} at ${gatewayUrl} is up to date.`
          : undefined,
      data,
    });
  });
}
