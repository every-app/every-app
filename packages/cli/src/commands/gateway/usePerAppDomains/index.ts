import type { LocalContext } from "@/context";
import { cfD1Database } from "@/lib/cf/d1";
import { canPromptInTerminal, confirmAtTerminal } from "@/lib/cf/deploy";
import { waitForCertificates } from "@/lib/domains/certWait";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { notDeployedByEveryapp } from "@/lib/gateway/apply";
import {
  readDesiredState,
  workerExistence,
} from "@/lib/gateway/desiredState";
import {
  assertUpgradedSinceAdopted,
  readInstall,
} from "@/lib/gateway/install";
import { confirmLeaseBreak } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { bundledReleaseTarball } from "@/lib/gateway/release";
import { findGatewayDatabase } from "@/lib/gateway/resources";
import {
  cliVersion,
  connectToAccount,
  eventSink,
  rememberedInstall,
  runReported,
} from "../shared";

interface UsePerAppDomainsFlags {
  "account-id"?: string;
  "dry-run"?: boolean;
  "force-dns"?: boolean;
  "break-lease"?: boolean;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp gateway use-per-app-domains`: move an install served through
 * its wildcard route to per-app Workers Custom Domains. Every app keeps its
 * hostname, now published on the gateway one by one (checked first like
 * any new hostname), and new apps get `<app>.<host>`. The wildcard route
 * and DNS record keep working until the operator removes them.
 */
export async function usePerAppDomains(
  this: LocalContext,
  flags: UsePerAppDomainsFlags,
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
      const databaseId = await findGatewayDatabase(cf);
      const db = databaseId ? cfD1Database(cf, databaseId) : null;
      const install = db ? await readInstall(db) : null;
      if (!db || !install) throw notDeployedByEveryapp();
      assertUpgradedSinceAdopted(install);
      if (install.routing === "custom-domains") {
        out.emit({
          type: "done",
          message: `The gateway at https://${install.gatewayHost} already publishes each app as its own Custom Domain.`,
          data: { routing: install.routing },
        });
        return;
      }
      const desired = await readDesiredState(db, workerExistence(cf));
      const hosts = desired.appHosts.filter((host) =>
        isOneLabelBelow(host, install.appBaseDomain),
      );
      out.emit({
        type: "step",
        step: "gateway.domains",
        status: "start",
        message: `Publishing ${hosts.length === 0 ? "no app hostnames yet" : hosts.join(", ")} as Workers Custom Domains on the gateway, next to https://${install.gatewayHost}. New apps will get <app>.${install.appBaseDomain}.`,
        data: { hosts },
      });

      const interactive = canPromptInTerminal(flags.json ?? false);
      if (
        !flags["dry-run"] &&
        !flags.yes &&
        interactive &&
        !(await confirmAtTerminal(
          `Publish ${hosts.length} app hostname${hosts.length === 1 ? "" : "s"} as Custom Domains (cf may ask about the wildcard DNS record they ride on now: yes)?`,
        ))
      ) {
        out.emit({ type: "done", message: "Nothing changed." });
        return;
      }
      const result = await reconcileGateway({
        cf,
        out,
        accountId: account.id,
        interactive,
        cliVersion,
        routing: "custom-domains",
        force: true,
        forceDns: flags["force-dns"],
        dryRun: flags["dry-run"],
        breakLease: confirmLeaseBreak({
          breakLease: flags["break-lease"],
          yes: flags.yes,
          interactive,
        }),
        bundledTarball: bundledReleaseTarball(),
      });
      if (result.dryRunOutput !== undefined) {
        out.emit({
          type: "done",
          message: `Dry run: the gateway would serve ${result.domains.join(", ")}; nothing changed.\n${result.dryRunOutput.trim()}`,
          data: { domains: result.domains, newHosts: result.newHosts },
        });
        return;
      }
      await waitForCertificates({ hosts: result.newHosts, out, step: "gateway.tls" });
      out.emit({
        type: "done",
        message: [
          `Every app of https://${install.gatewayHost} is its own Custom Domain now.`,
          "Once each one answers at its address, remove what they rode on before:",
          `  the * record (Cloudflare dashboard → ${install.zoneName} → DNS)`,
          `  the *.${install.gatewayHost}/* route (Workers & Pages → every-app-gateway → Settings → Domains & Routes)`,
        ].join("\n"),
        data: { routing: "custom-domains", domains: result.domains },
      });
    },
    { verbose: flags.verbose },
  );
}
