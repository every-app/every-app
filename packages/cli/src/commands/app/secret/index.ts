import enquirer from "enquirer";
import type { LocalContext } from "@/context";
import { checkIsEveryAppProject } from "@/commands/app/deploy/steps/checkIsEveryAppProject";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { assertAppSecretName } from "@/lib/app/secrets";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { resolveGatewayUrl } from "@/lib/gateway/resolve";
import { loadEveryAppManifest } from "@/lib/manifest";
import { eventSink, runReported } from "@/lib/output/run";
import { readSecretValue } from "@/lib/secretValue";

interface AppSecretSetFlags {
  "from-env"?: string;
  gateway?: string;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp app secret set <NAME>`: set one of the app's own secrets (an
 * API key it calls out with, say). The value comes from a hidden prompt or
 * `--from-env VAR`, never the command line, and ships with a deploy of the
 * app in this directory, so it lands in a version everyapp uploaded and
 * recorded: later unattended deploys go on as usual, where a secret set
 * with cf directly makes them stop and ask. Later deploys keep it. That
 * deploy is a whole one, code and pending migrations included, so at a
 * terminal it asks first (`--yes` skips the question).
 */
export async function set(
  this: LocalContext,
  flags: AppSecretSetFlags,
  name: string,
): Promise<void> {
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      assertAppSecretName(name);
      await checkIsEveryAppProject();
      const cwd = process.cwd();
      const manifest = await loadEveryAppManifest(cwd);
      const value = await readSecretValue(name, {
        fromEnv: flags["from-env"],
        json: flags.json,
      });
      const gatewayUrl = await resolveGatewayUrl(flags.gateway);

      // The secret ships with a deploy of this directory, code and
      // migrations alike, as `everyapp app deploy` would.
      if (!flags.yes && canPromptInTerminal(flags.json ?? false)) {
        const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
          type: "confirm",
          name: "confirmed",
          message: `Set ${name} by deploying ${manifest.id} from this directory (its code and pending migrations) to ${gatewayUrl}?`,
          initial: false,
        });
        if (!confirmed) {
          out.emit({ type: "done", message: "Nothing set." });
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
        secrets: { [name]: value },
      });
      out.emit({
        type: "done",
        message: `Set ${name} on ${manifest.id} (version ${result.versionId}).`,
        data: { name, appId: manifest.id, versionId: result.versionId },
      });
    },
    { verbose: flags.verbose },
  );
}
