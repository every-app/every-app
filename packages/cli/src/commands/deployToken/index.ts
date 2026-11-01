/**
 * `everyapp deploy-token add|remove`: the Gateway's own Cloudflare token
 * (CF_DEPLOY_TOKEN) and the operator's opt-in beside it
 * (BROWSER_APP_INSTALLS=on), so the Gateway installs apps itself: from
 * Admin → Apps → Install app, or a Deploy to EveryApp button. Both change
 * together, in one new version of the Gateway Worker, through
 * `applyGatewaySettings` (the lease, replaceable-version check and version
 * record of `secret set`). `add` keeps a token the Gateway holds and only
 * turns installs on, so running it again never leaves a second token live
 * in the account; `remove` takes both off, and the token itself is deleted
 * in Cloudflare.
 */
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { askDeployToken } from "@/lib/gateway/deployToken";
import { thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmUnlessYes } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { applyGatewaySettings } from "../secret";
import type { GatewayCommandFlags } from "../flags";

enum DeployTokenSetting {
  Token = "CF_DEPLOY_TOKEN",
  Installs = "BROWSER_APP_INSTALLS",
}

/** Where a removed token is deleted: the account's API tokens. */
const ACCOUNT_TOKENS_URL = "https://dash.cloudflare.com/?to=/:account/api-tokens";

interface DeployTokenOptions {
  flags: GatewayCommandFlags & { yes?: boolean };
  out: EventSink;
}

export async function add(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => addDeployToken({ flags, out }));
}

export async function remove(flags: GatewayCommandFlags & { yes?: boolean }): Promise<void> {
  await runCommand(flags, (out) => removeDeployToken({ flags, out }));
}

/** The Gateway, which of the two settings it holds, and its host. */
async function connect({ flags, out }: DeployTokenOptions) {
  const connection = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
  });
  if (connection.install.deploymentMode === "hosted") {
    throw new EveryAppError(
      "DEPLOY_TOKEN_HOSTED",
      "This Gateway's deploy token can't be changed here\nA hosted Gateway's token deploys every workspace's apps.",
    );
  }
  const held = await listWorkerSecrets(connection.cf, connection.names.worker);
  return { connection, held, host: new URL(connection.gatewayUrl).host };
}

async function addDeployToken(options: DeployTokenOptions): Promise<void> {
  const { flags, out } = options;
  const { connection, held, host } = await connect(options);
  const kept = held.includes(DeployTokenSetting.Token);
  const changes: Record<string, string> = { [DeployTokenSetting.Installs]: "on" };
  if (!kept) {
    if (!canPromptInTerminal(flags.json ?? false)) {
      throw new ActionRequiredError(
        "rerun_interactive",
        `Making ${host}'s deploy token needs you at a terminal\nCloudflare shows the new token once, to paste at a hidden prompt. Nothing changed.`,
        undefined,
        {
          rerun: thisCommand([], { terminal: true }),
          rerunNote: "in a terminal",
          data: { needsTerminal: true },
        },
      );
    }
    changes[DeployTokenSetting.Token] = await askDeployToken({
      gatewayHost: host,
      account: connection.accountName ?? connection.accountId,
      zone: connection.install.zoneName,
    });
  }
  await applyGatewaySettings(connection, changes, { flags, out });
  out.emit({
    type: "done",
    message: `${host} can now install apps using ${kept ? "the existing" : "its own"} token with your authorization.`,
    data: { gateway: connection.gatewayUrl, tokenKept: kept },
  });
}

async function removeDeployToken(options: DeployTokenOptions): Promise<void> {
  const { flags, out } = options;
  const { connection, held, host } = await connect(options);
  const names = Object.values(DeployTokenSetting).filter((name) => held.includes(name));
  if (!names.length) {
    out.emit({
      type: "done",
      message: `${host} holds no deploy token. Nothing changed.`,
      data: { gateway: connection.gatewayUrl, removed: false },
    });
    return;
  }
  await confirmUnlessYes({
    yes: flags.yes,
    interactive: canPromptInTerminal(flags.json ?? false),
    question: `Remove ${host}'s deploy token?`,
    context: ["The Gateway will no longer be able to install apps using its own token. The apps it installed keep running."],
    unattended: "Removing the deploy token needs confirmation at a terminal, or --yes",
  });
  await applyGatewaySettings(connection, Object.fromEntries(names.map((name) => [name, null])), { flags, out });
  out.emit({
    type: "done",
    message: `${host} can no longer install apps using its own token. Delete the token in Cloudflare too: ${ACCOUNT_TOKENS_URL}`,
    data: { gateway: connection.gatewayUrl, removed: true },
  });
}
