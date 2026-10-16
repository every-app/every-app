import type { LocalContext } from "@/context";
import { CLI } from "@/lib/output/command";
import { eventSink, runReported } from "@/lib/output/run";
import { runSetup, setupDeps, type SetupFlags } from "./runSetup";

export async function setup(
  this: LocalContext,
  flags: SetupFlags,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const result = await runSetup(
        flags,
        out,
        setupDeps({ out, json: flags.json, verbose: flags.verbose }),
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
          message: `Your Gateway is ready: ${gatewayUrl}${organizationName ? ` (${organizationName})` : ""}`,
          data: {
            ...data,
            next: [
              `${CLI} create my-app`,
              `Invite people, and decide who opens which app: ${gatewayUrl}/admin`,
              `AI for apps, any time: ${CLI} secret set OPENAI_API_KEY --for gateway`,
              `Email for invitations and password resets (until then they are links to share): onboard the domain for Cloudflare Email Sending, then ${CLI} secret set EMAIL_FROM --for gateway`,
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
    },
    { verbose: flags.verbose },
  );
}
