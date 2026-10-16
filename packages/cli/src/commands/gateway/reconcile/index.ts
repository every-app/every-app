import type { LocalContext } from "@/context";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { waitForCertificates } from "@/lib/domains/certWait";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import {
  cliVersion,
  connectToAccount,
  eventSink,
  rememberedInstall,
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
 * Bind exactly the apps the registry lists, redeploying the live gateway
 * release (never upgrading or downgrading it).
 */
export async function reconcile(
  this: LocalContext,
  flags: ReconcileFlags,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      const cached = await rememberedInstall();
      const { cf, account } = await connectToAccount({
        json: flags.json,
        accountId: flags["account-id"],
        remembered: cached?.accountId,
      });
      const result = await reconcileGateway({
        cf,
        out,
        accountId: account.id,
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
