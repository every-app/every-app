import path from "node:path";
import type { LocalContext } from "@/context";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { runCommand } from "@/lib/output/run";
import { liveDone } from "../appGateway";
import type { GatewayCommandFlags } from "../flags";
import { registerApp } from "./registerApp";

interface RegisterCommandFlags extends GatewayCommandFlags {
  worker: string;
  manifest: string;
  shared?: boolean;
  "force-dns"?: boolean;
  "no-wait"?: boolean;
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
  await runCommand(flags, async (out) => {
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
    out.emit({ type: "done", data: liveDone(result) });
  });
}
