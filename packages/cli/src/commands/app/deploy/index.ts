import enquirer from "enquirer";
import type { LocalContext } from "@/context";
import { checkIsEveryAppProject } from "@/commands/app/deploy/steps/checkIsEveryAppProject";
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

export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      await checkIsEveryAppProject();
      const cwd = process.cwd();
      const loaded = await loadEveryAppManifest(cwd);
      // --access overrides the manifest. Either only matters the first time
      // the gateway registers the app; after that, access is managed in its UI.
      const manifest = flags.access
        ? { ...loaded, access: flags.access }
        : loaded;
      const gatewayUrl = await resolveGatewayUrl(flags.gateway);

      if (!flags.yes && canPromptInTerminal(flags.json ?? false)) {
        const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
          type: "confirm",
          name: "confirmed",
          message: `Deploy ${manifest.id} to ${gatewayUrl}?`,
          initial: false,
        });
        if (!confirmed) {
          out.emit({ type: "done", message: "Deployment cancelled." });
          return;
        }
      }

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
      out.emit({
        type: "done",
        message: `${manifest.id} is live at ${result.liveUrl}`,
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
