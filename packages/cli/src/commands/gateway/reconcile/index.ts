import type { LocalContext } from "@/context";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { waitForCertificates } from "@/lib/domains/certWait";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import {
  cliVersion,
  eventSink,
  existingGateway,
  openGatewayRelease,
  runReported,
} from "../shared";

interface ReconcileFlags {
  "account-id"?: string;
  "dry-run"?: boolean;
  force?: boolean;
  "force-dns"?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * Bind exactly the apps the registry lists, redeploying the gateway this
 * checkout builds (an upgrade, when the checkout is newer than the live
 * release; never a downgrade).
 */
export async function reconcile(
  this: LocalContext,
  flags: ReconcileFlags,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const { cf, account, databaseId } = await existingGateway({
        json: flags.json,
        out,
        accountId: flags["account-id"],
        installed: true,
      });
      const result = await reconcileGateway({
        cf,
        out,
        accountId: account.id,
        databaseId,
        openRelease: () => openGatewayRelease({ out, verbose: flags.verbose }),
        interactive: canPromptInTerminal(flags.json ?? false),
        cliVersion,
        dryRun: flags["dry-run"],
        force: flags.force,
        forceDns: flags["force-dns"],
      });
      if (result.dryRunOutput !== undefined) {
        out.emit({
          type: "done",
          message: `Dry run: the gateway would bind ${result.appWorkers.length ? result.appWorkers.join(", ") : "no apps"} and serve ${result.domains.join(", ")}${result.newHosts.length ? ` (new: ${result.newHosts.join(", ")})` : ""}.\n${result.dryRunOutput.trim()}`,
          data: {
            appWorkers: result.appWorkers,
            domains: result.domains,
            newHosts: result.newHosts,
          },
        });
        return;
      }
      await waitForCertificates({
        hosts: result.newHosts,
        out,
        step: "gateway.tls",
      });
      out.emit({
        type: "done",
        message: result.changed
          ? `The gateway binds ${result.appWorkers.length} app${result.appWorkers.length === 1 ? "" : "s"} (version ${result.versionId ?? "unknown"}).`
          : undefined,
        data: {
          changed: result.changed,
          versionId: result.versionId,
          appWorkers: result.appWorkers,
          domains: result.domains,
        },
      });
    },
    { verbose: flags.verbose },
  );
}
