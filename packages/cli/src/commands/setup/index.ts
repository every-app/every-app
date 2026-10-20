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
        setupDeps({
          out,
          json: flags.json,
          verbose: flags.verbose,
          release: flags.release,
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
    },
    { verbose: flags.verbose },
  );
}
