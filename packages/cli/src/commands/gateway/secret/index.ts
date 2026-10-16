import type { LocalContext } from "@/context";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { assertSettableSecret } from "@/lib/gateway/secretsFile";
import { readSecretValue } from "@/lib/secretValue";
import {
  cliVersion,
  eventSink,
  existingGateway,
  openGatewayRelease,
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
 * the command line, and ships with a redeploy of the gateway this checkout
 * builds (`cf deploy --secrets-file`), so it lands in the same version as
 * the code.
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
