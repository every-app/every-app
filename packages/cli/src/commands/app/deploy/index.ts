import type { LocalContext } from "@/context";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
import { loadEveryAppManifest } from "@/lib/manifest";
import { eventSink, runReported } from "@/lib/output/run";

interface DeployCommandFlags {
  gateway?: string;
  verbose?: boolean;
  yes?: boolean;
  json?: boolean;
  access?: "everyone" | "admins";
  "allow-delete-durable-object-data"?: boolean;
  "allow-delete-workflows"?: boolean;
  "force-dns"?: boolean;
  "no-wait-cert"?: boolean;
}

/**
 * `everyapp app deploy`: no question first. The first line says where the
 * app goes (`todo → https://todo.apps.example.com (Acme)`), and the last
 * that it is live.
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
      const loaded = await loadEveryAppManifest(cwd);
      // --access overrides the manifest. Either only matters the first time
      // the gateway registers the app; after that, access is managed in its UI.
      const manifest = flags.access
        ? { ...loaded, access: flags.access }
        : loaded;
      const result = await deployApp({
        cwd,
        manifest,
        gateway: requestedGatewayUrl(flags.gateway),
        out,
        json: flags.json,
        verbose: flags.verbose,
        allowDeleteDurableObjectData:
          flags["allow-delete-durable-object-data"],
        allowDeleteWorkflows: flags["allow-delete-workflows"],
        forceDns: flags["force-dns"],
        waitForLive: !flags["no-wait-cert"],
      });
      // `app.live` said it to a person already (or a warning, that it goes
      // live on its first visit).
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
