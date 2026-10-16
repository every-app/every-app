/**
 * `everyapp secret set|unset|list`: the secrets of the app in this
 * directory, or with `--for gateway`, the Gateway's optional settings.
 *
 * A value comes from a hidden prompt or `--from-env VAR`, never the
 * command line, and ships with a deploy, so it lands in a version everyapp
 * uploaded and recorded: later unattended deploys go on as usual, where a
 * secret set with cf directly makes them stop and ask. For an app that
 * deploy is a whole one from this directory, code and pending migrations
 * included, which its first line says (`Redeploying todo with GITHUB_TOKEN
 * (code and pending migrations from this directory)`); for the Gateway, a
 * redeploy of the Gateway this checkout builds. Later deploys keep it.
 * `unset` deletes the secret (`cf workers secrets delete`), then redeploys
 * the same way; `list` prints names, never values.
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { version as cliVersion } from "../../../package.json";
import type { LocalContext } from "@/context";
import { deployApp } from "@/commands/deploy/deployApp";
import { assertAppSecretName } from "@/lib/app/secrets";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { openGatewayRelease } from "@/lib/gateway/checkoutRelease";
import {
  connectToGateway,
  existingGateway,
  requestedGatewayUrl,
} from "@/lib/gateway/connect";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { readApp } from "@/lib/gateway/registry";
import { assertSettableSecret } from "@/lib/gateway/secretsFile";
import { deviceLoginAction } from "@/lib/cf/account";
import { loadEveryAppManifest } from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";
import { readSecretValue } from "@/lib/secretValue";

interface SecretFlags {
  for?: "gateway";
  gateway?: string;
  "account-id"?: string;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
}

export async function set(
  this: LocalContext,
  flags: SecretFlags & { "from-env"?: string },
  name: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      if (flags.for === "gateway") assertSettableSecret(name);
      else assertAppSecretName(name);
      const value = await readSecretValue(name, {
        fromEnv: flags["from-env"],
        json: flags.json,
      });
      if (flags.for === "gateway") {
        const versionId = await redeployGateway(flags, out, {
          stagedSecrets: { [name]: value },
        });
        out.emit({
          type: "done",
          message: `Set ${name} on the gateway (version ${versionId ?? "unknown"}).`,
          data: { name, for: "gateway", versionId },
        });
        return;
      }
      const result = await redeployApp(flags, out, { secrets: { [name]: value } });
      // `app.live` said it to a person already.
      out.emit({
        type: "done",
        data: { name, appId: result.appId, versionId: result.versionId },
      });
    },
    { verbose: flags.verbose },
  );
}

export async function unset(
  this: LocalContext,
  flags: SecretFlags,
  name: string,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      if (flags.for === "gateway") {
        assertSettableSecret(name);
        const versionId = await redeployGateway(flags, out, { unsetSecrets: [name] });
        out.emit({
          type: "done",
          message: `Removed ${name} from the gateway (version ${versionId ?? "unknown"}).`,
          data: { name, for: "gateway", versionId },
        });
        return;
      }
      assertAppSecretName(name);
      const result = await redeployApp(flags, out, { unsetSecrets: [name] });
      out.emit({
        type: "done",
        data: { name, appId: result.appId, versionId: result.versionId },
      });
    },
    { verbose: flags.verbose },
  );
}

export async function list(
  this: LocalContext,
  flags: Omit<SecretFlags, "yes">,
): Promise<void> {
  const out = eventSink(flags.json, flags.verbose);
  await runReported(
    out,
    async () => {
      const { cf, workerName } =
        flags.for === "gateway"
          ? {
              cf: (
                await existingGateway({
                  json: flags.json,
                  out,
                  accountId: flags["account-id"],
                  installed: true,
                })
              ).cf,
              workerName: GATEWAY_WORKER_NAME,
            }
          : await appWorker(flags, out);
      const names = await listWorkerSecrets(cf, workerName);
      out.emit({
        type: "done",
        message: names.length > 0 ? names.join("\n") : `${workerName} has no secrets.`,
        data: { workerName, names },
      });
    },
    { verbose: flags.verbose },
  );
}

/** The app in this directory, deployed again with this change to its secrets. */
async function redeployApp(
  flags: SecretFlags,
  out: EventSink,
  change: { secrets?: Record<string, string>; unsetSecrets?: string[] },
): Promise<{ appId: string; versionId: string }> {
  const cwd = process.cwd();
  const manifest = await loadEveryAppManifest(cwd);
  const result = await deployApp({
    cwd,
    manifest,
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    out,
    json: flags.json,
    verbose: flags.verbose,
    ...change,
  });
  return { appId: manifest.id, versionId: result.versionId };
}

/** The Gateway this checkout builds, deployed again with this change to its settings. */
async function redeployGateway(
  flags: SecretFlags,
  out: EventSink,
  change: { stagedSecrets?: Record<string, string>; unsetSecrets?: string[] },
): Promise<string | null> {
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
    force: true,
    ...change,
  });
  return result.versionId;
}

/** The deployed Worker of the app in this directory, and cf in its account. */
async function appWorker(flags: SecretFlags, out: EventSink) {
  const manifest = await loadEveryAppManifest(process.cwd());
  const { cf, db } = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    onDeviceLogin: flags.json ? deviceLoginAction(out, "app.login") : undefined,
  });
  const { workerName } = await readApp(db, manifest.id);
  return { cf, workerName };
}
