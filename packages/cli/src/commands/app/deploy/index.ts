import type { LocalContext } from "@/context";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { resolveGatewayUrl } from "@/lib/gateway/resolve";
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
      const gatewayUrl = await resolveGatewayUrl(flags.gateway);

      const result = await deployApp({
        cwd,
        manifest,
        gatewayUrl,
        out,
        json: flags.json,
        verbose: flags.verbose,
        allowDeleteDurableObjectData:
          flags["allow-delete-durable-object-data"],
        allowDeleteWorkflows: flags["allow-delete-workflows"],
        forceDns: flags["force-dns"],
        waitForCertificate: !flags["no-wait-cert"],
      });
      // `app.live` said it to a person already.
      out.emit({
        type: "done",
        data: {
          url: result.liveUrl,
          workerName: result.workerName,
          versionId: result.versionId,
        },
      });
    },
    { verbose: flags.verbose },
  );
}
