import type { LocalContext } from "@/context";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { assertAppSecretName } from "@/lib/app/secrets";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { requestedGatewayUrl } from "@/lib/gateway/connect";
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
 * deploy is a whole one, code and pending migrations included, which its
 * first line says (`Redeploying todo with GITHUB_TOKEN (code and pending
 * migrations from this directory)`); nothing asks first.
 */
export async function set(
  this: LocalContext,
  flags: AppSecretSetFlags,
  name: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      assertAppSecretName(name);
      const cwd = process.cwd();
      const manifest = await loadEveryAppManifest(cwd);
      const value = await readSecretValue(name, {
        fromEnv: flags["from-env"],
        json: flags.json,
      });
      const result = await deployApp({
        cwd,
        manifest,
        gateway: requestedGatewayUrl(flags.gateway),
        out,
        json: flags.json,
        verbose: flags.verbose,
        secrets: { [name]: value },
      });
      // `app.live` said it to a person already.
      out.emit({
        type: "done",
        data: { name, appId: manifest.id, versionId: result.versionId },
      });
    },
    { verbose: flags.verbose },
  );
}
