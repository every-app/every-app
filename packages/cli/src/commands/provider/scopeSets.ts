/**
 * `everyapp provider scope-set add|remove`: scope sets an operator adds
 * to a built-in OAuth client (Google, Microsoft, Slack), so an app can
 * list a set the catalog doesn't ship (Gmail send, Drive read) without a
 * platform release. A set is a JSON file (`{ "name", "label", "access",
 * "scopes", "routes" }`), checked by the rules a built-in set is checked
 * by (lib/gateway/providers.ts, the SDK's `resolveScopeSetRow`), written
 * to the Gateway's D1 under the Cloudflare login and served within 30
 * seconds. The client's authorize scopes grow by the set's: the OAuth
 * client at the provider's console must be allowed them, and people
 * connect again to grant them.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { addScopeSet, gatewayRegistry, removeScopeSet } from "@/lib/gateway/providers";
import { CLI } from "@/lib/output/command";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { listed } from "@/lib/output/text";
import type { GatewayCommandFlags } from "../flags";
import { readSpecSource, type ProviderOptions } from "./index";

export async function scopeSetAdd(
  flags: GatewayCommandFlags & { replace?: boolean },
  provider: string,
  spec: string,
): Promise<void> {
  await runCommand(flags, (out) => addScopeSetCommand({ flags, out }, provider, spec));
}

export async function scopeSetRemove(
  flags: GatewayCommandFlags & { force?: boolean },
  provider: string,
  name: string,
): Promise<void> {
  await runCommand(flags, (out) => removeScopeSetCommand({ flags, out }, provider, name));
}

function connect(options: ProviderOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(options.flags.gateway),
    accountId: options.flags["account-id"],
    interactive: canPromptInTerminal(options.flags.json ?? false),
    login: { json: options.flags.json, out: options.out, step: "login" },
    createCf: options.createCf,
  });
}

/**
 * `provider scope-set add <provider> <spec>`: the set's JSON read (a
 * file, or an https URL fetched here) and added to the built-in client,
 * then what to do next: allow the scopes on the OAuth client, have people
 * connect again, list the set in the app's manifest.
 */
export async function addScopeSetCommand(
  options: ProviderOptions & { flags: { replace?: boolean } },
  provider: string,
  source: string,
): Promise<void> {
  const { out, flags } = options;
  const cwd = options.cwd ?? process.cwd();
  const spec = await readSpecSource(source, { cwd, fetcher: options.fetch });
  const gateway = await connect(options);
  out.emit({ type: "step", step: "provider.scope-set", status: "start", message: `Adding a scope set to ${provider}...` });
  const added = await addScopeSet(gateway.db, {
    providerId: provider,
    spec,
    deployer: gateway.deployer,
    replace: flags.replace ?? false,
    now: options.now?.(),
  });
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  const hosts = [...new Set(added.set.routes.map((route) => route.host))];
  out.emit({
    type: "step",
    step: "provider.scope-set",
    status: "ok",
    message: `${added.replaced ? "Replaced" : "Added"} ${added.name} on ${added.label} (${provider}) at ${gatewayHost}`,
    data: { provider, name: added.name, replaced: added.replaced },
  });
  const capability = (await gatewayRegistry(gateway.db, gateway.install)).get(provider);
  const console_ = capability?.mode === "oauth_client" ? capability.console : null;
  const lines = [
    `${added.replaced ? "Replaced" : "Added"} the scope set ${added.name} (${added.set.label}) on ${added.label} at ${gatewayHost}.`,
    `It unlocks ${listed(hosts)} with ${added.set.access} access and asks for ${listed([...added.set.scopes])}.`,
    ...(console_ ? [`Allow ${added.set.scopes.length === 1 ? "that scope" : "those scopes"} on the OAuth client at ${console_}; people connect again to grant ${added.set.scopes.length === 1 ? "it" : "them"}.`] : []),
    `Apps list it as capabilities: { ${JSON.stringify(provider)}: { access: "${added.set.access}", scopes: [${JSON.stringify(added.name)}], why: "..." } }.`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: {
      provider,
      scopeSet: {
        name: added.name,
        label: added.set.label,
        access: added.set.access,
        scopes: [...added.set.scopes],
        hosts,
        source: "row",
      },
      replaced: added.replaced,
      ...(console_ ? { console: console_ } : {}),
      next: [
        {
          command: `${CLI} provider show ${provider}`,
          note: "lists the client's sets, the added ones marked",
        },
      ],
    },
  });
}

/** `provider scope-set remove <provider> <name> [--force]`: the row deleted; the apps listing the set named. */
export async function removeScopeSetCommand(
  options: ProviderOptions & { flags: { force?: boolean } },
  provider: string,
  name: string,
): Promise<void> {
  const { out, flags } = options;
  const gateway = await connect(options);
  out.emit({ type: "step", step: "provider.scope-set", status: "start", message: `Removing ${name} from ${provider}...` });
  const removed = await removeScopeSet(gateway.db, provider, name, gateway.deployer, {
    force: flags.force ?? false,
    now: options.now?.(),
  });
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  out.emit({
    type: "step",
    step: "provider.scope-set",
    status: "ok",
    message: `Removed ${name} from ${removed.label} (${provider}) at ${gatewayHost}`,
    data: { provider, name },
  });
  const lines = [
    `Removed the scope set ${name} from ${removed.label} at ${gatewayHost}.`,
    "The Gateway stops serving it within 30 seconds; connections keep their tokens.",
    ...(removed.apps.length > 0
      ? [`${listed(removed.apps)} ${removed.apps.length === 1 ? "lists" : "list"} it: ${removed.apps.length === 1 ? "its" : "their"} calls under it answer integration_scopes_undeclared until the manifest changes.`]
      : []),
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { provider, name, removed: true, apps: removed.apps },
  });
}
