import type { LocalContext } from "@/context";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { runCommand } from "@/lib/output/run";
import { liveDone } from "../appGateway";
import type { GatewayCommandFlags } from "../flags";
import { registerApp } from "./registerApp";

interface RegisterCommandFlags extends GatewayCommandFlags {
  worker: string;
  manifest: string;
  "force-dns"?: boolean;
  "no-wait"?: boolean;
}

/**
 * `everyapp register <appId> --worker <name> --manifest <path>`: the first
 * line says where the app goes, the last where it is (`Live`, or its URL
 * and why it isn't live yet).
 */
export async function registerCommandHandler(
  this: LocalContext,
  flags: RegisterCommandFlags,
  appId: string,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const result = await registerApp({
      appId,
      workerName: flags.worker,
      manifest: flags.manifest,
      gateway: requestedGatewayUrl(flags.gateway),
      accountId: flags["account-id"],
      out,
      json: flags.json,
      verbose: flags.verbose,
      forceDns: flags["force-dns"],
      waitForLive: !flags["no-wait"],
    });
    out.emit({
      type: "done",
      data: {
        ...liveDone(result),
        // `app.live` shows `Live` once it is.
        ...(result.live
          ? {}
          : {
              facts: [
                {
                  label: "URL",
                  value: result.liveUrl,
                  note: flags["no-wait"] ? "goes live on its first visit" : "not live yet",
                },
              ],
            }),
      },
    });
  });
}
