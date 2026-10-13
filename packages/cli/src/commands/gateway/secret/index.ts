import enquirer from "enquirer";
import type { LocalContext } from "@/context";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { EveryAppError } from "@/lib/errors";
import { confirmLeaseBreak } from "@/lib/gateway/lease";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { bundledReleaseTarball } from "@/lib/gateway/release";
import { assertSettableSecret } from "@/lib/gateway/secretsFile";
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
  "break-lease"?: boolean;
  yes?: boolean;
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
  const out = eventSink(flags.json);
  await runReported(
    out,
    async () => {
      assertSettableSecret(name);
      const value = await readValue(name, flags);
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
        breakLease: confirmLeaseBreak({
          breakLease: flags["break-lease"],
          yes: flags.yes,
          interactive: canPromptInTerminal(flags.json ?? false),
        }),
        bundledTarball: bundledReleaseTarball(),
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

async function readValue(name: string, flags: SecretSetFlags): Promise<string> {
  const variable = flags["from-env"];
  if (variable) {
    const value = process.env[variable];
    if (!value) {
      throw new EveryAppError(
        "SECRET_EMPTY",
        `${variable} is empty or unset in this environment.`,
      );
    }
    return value;
  }
  if (!canPromptInTerminal(flags.json ?? false)) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      `Pass the value through an environment variable: --from-env <VAR>.`,
    );
  }
  const { value } = await enquirer.prompt<{ value: string }>({
    type: "password",
    name: "value",
    message: `${name}`,
    validate: (input: string) => (input.trim() ? true : "Enter a value"),
  });
  return value.trim();
}
