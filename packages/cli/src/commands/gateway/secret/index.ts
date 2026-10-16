import type { LocalContext } from "@/context";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { assertSettableSecret } from "@/lib/gateway/secretsFile";
import { readSecretValue } from "@/lib/secretValue";
import {
  cliVersion,
  connectToAccount,
  eventSink,
  rememberedInstall,
  runReported,
} from "../shared";

interface SecretSetFlags {
  "from-env"?: string;
  "account-id"?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp gateway secret set <NAME>`: change one of the gateway's optional
 * settings. The value comes from a hidden prompt or `--from-env VAR`, never
 * the command line, and ships with a redeploy of the live gateway release
 * (`cf deploy --secrets-file`), so it lands in the same version as the code.
 */
export async function set(
  this: LocalContext,
  flags: SecretSetFlags,
  name: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      assertSettableSecret(name);
      const value = await readSecretValue(name, {
        fromEnv: flags["from-env"],
        json: flags.json,
      });
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
        stagedSecrets: { [name]: value },
        force: true,
      });
      out.emit({
        type: "done",
        message: `Set ${name} on the gateway (version ${result.versionId ?? "unknown"}).`,
        data: { name, versionId: result.versionId },
      });
    },
    { verbose: flags.verbose },
  );
}
