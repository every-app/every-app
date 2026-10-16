import path from "node:path";
import type { LocalContext } from "@/context";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { eventSink, runReported } from "@/lib/output/run";
import { registerApp } from "./registerApp";

interface RegisterCommandFlags {
  worker: string;
  manifest: string;
  shared?: boolean;
  gateway?: string;
  "account-id"?: string;
  "force-dns"?: boolean;
  "no-wait"?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp register <appId> --worker <name> --shared --manifest <path>`:
 * the first line says where the app goes, the last that it is live.
 */
export async function registerCommandHandler(
  this: LocalContext,
  flags: RegisterCommandFlags,
  appId: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const result = await registerApp({
        appId,
        workerName: flags.worker,
        manifestPath: path.resolve(process.cwd(), flags.manifest),
        shared: flags.shared ?? false,
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
          url: result.liveUrl,
          workerName: result.workerName,
          versionId: result.versionId,
          live: result.live,
        },
      });
    },
    { verbose: flags.verbose },
  );
}
