import type { LocalContext } from "@/context";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { loadEveryAppManifest } from "@/lib/manifest";
import { eventSink, runReported } from "@/lib/output/run";
import { deployApp } from "./deployApp";
import { deployToGateway, hostedDeployTarget } from "./deployToGateway";

interface DeployCommandFlags {
  gateway?: string;
  "account-id"?: string;
  verbose?: boolean;
  yes?: boolean;
  json?: boolean;
  "allow-delete-durable-object-data"?: boolean;
  "allow-delete-workflows"?: boolean;
  "force-dns"?: boolean;
  "enable-email-routing"?: boolean;
  "no-wait"?: boolean;
  shared?: boolean;
}

/**
 * `everyapp deploy`: with EVERYAPP_DEPLOY_TOKEN, through a hosted gateway's deploy
 * API (deployToGateway.ts); otherwise no question first (unless there is no Gateway yet:
 * then it offers to install one). The first line says where the app goes
 * (`todo → https://todo.apps.example.com (Acme)`), and the last that it is
 * live.
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const cwd = process.cwd();
      const hosted = hostedDeployTarget({
        ...flags,
        gateway: requestedGatewayUrl(flags.gateway),
      });
      if (hosted) {
        const result = await deployToGateway({
          cwd,
          manifest: await loadEveryAppManifest(cwd),
          ...hosted,
          out,
          verbose: flags.verbose,
          wait: !flags["no-wait"],
        });
        out.emit({
          type: "done",
          data: {
            url: result.liveUrl,
            workerName: result.workerName,
            versionId: result.versionId,
            jobId: result.jobId,
            status: result.status,
            live: false,
          },
        });
        return;
      }
      const result = await deployApp({
        cwd,
        manifest: await loadEveryAppManifest(cwd),
        gateway: requestedGatewayUrl(flags.gateway),
        accountId: flags["account-id"],
        out,
        json: flags.json,
        verbose: flags.verbose,
        allowDeleteDurableObjectData:
          flags["allow-delete-durable-object-data"],
        allowDeleteWorkflows: flags["allow-delete-workflows"],
        forceDns: flags["force-dns"],
        // TODO(integration): PR 6 passes its flag through; deploy/index.ts isn't on its file list.
        enableEmailRouting: flags["enable-email-routing"],
        shared: flags.shared,
        waitForLive: !flags["no-wait"],
        offerInstall: { yes: flags.yes },
      });
      // `app.live` said it to a person already (or that it goes live on its
      // first visit).
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
