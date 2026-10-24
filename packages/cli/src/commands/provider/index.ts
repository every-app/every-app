/**
 * `everyapp mcp on|off|list` (alias `provider`): MCP apps, provider apps
 * in the code (`@every-app/sdk/internal` providerApps.ts), data providers
 * the operator offers to members' AI clients as apps of the Gateway's own,
 * with no page and nothing to deploy. `on` and `off` write the Gateway's
 * registry under the Cloudflare login (lib/gateway/providerApps.ts);
 * `list` reads it and, like `secret list`, which Gateway settings are set,
 * so each app's key shows as set or not. Nothing is built, uploaded or
 * deployed; the Gateway reads a change within 30 seconds.
 */
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { PROVIDER_APPS, providerAppKeySetting, type ProviderAppId } from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import {
  listProviderApps,
  turnProviderAppOff,
  turnProviderAppOn,
} from "@/lib/gateway/providerApps";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import type { GatewayCommandFlags } from "../flags";

/** What the handlers take from the command line, and the seams tests use. */
export interface ProviderOptions {
  flags: GatewayCommandFlags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  now?: () => number;
}

export async function on(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => turnOn({ flags, out }, id));
}

export async function off(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => turnOff({ flags, out }, id));
}

export async function list(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => listProviders({ flags, out }));
}

function connect({ flags, out, createCf }: ProviderOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

const STEP = "provider.update";

export async function turnOn(options: ProviderOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Turning ${id} on...` });
  const result = await turnProviderAppOn(gateway.db, {
    id,
    deployer: gateway.deployer,
    organizationName: gateway.accountName ?? "My Organization",
    now: options.now?.(),
  });
  const { plan, organization } = result;
  const app = plan.app;
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message:
      plan.kind === "existing"
        ? `${app.name} was on already`
        : `${app.name} is on for ${organization.name}`,
    data: { id: app.appSlug, was: plan.kind },
  });
  const { key } = await providerState(gateway.cf, plan.app.appSlug as ProviderAppId);
  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${app.appSlug}_` };
  if (!key.set) {
    out.emit({
      type: "warning",
      code: "PROVIDER_KEY_UNSET",
      step: STEP,
      message: `${key.name} isn't set on the Gateway\n${app.name}'s tools answer "not set up" until it is.`,
      data: { fix: `${CLI} secret set ${key.name}`, name: key.name },
    });
  }
  const access = result.actorGranted
    ? "You, the owners and the admins can use it"
    : result.hasOwner
      ? "The owners and the admins can use it"
      : "The owner gets it when they claim the Gateway";
  const lines = [
    `${app.name} is on for ${organization.name}${plan.kind === "existing" ? " (it was already)" : ""}.`,
    `${access}; an admin grants others in Admin → Apps → Manage access.`,
    `Its tools are on ${mcp.url} as ${mcp.toolPrefix}<tool>.`,
    key.set
      ? `${key.name} is set on the Gateway.`
      : `${key.name} isn't set: ${CLI} secret set ${key.name}`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: {
      id: app.appSlug,
      name: app.name,
      on: true,
      was: plan.kind,
      organization: { id: organization.id, name: organization.name },
      key,
      mcp,
      granted: plan.grants.map((grant) => grant.userId),
      ...(key.set ? {} : { next: [{ command: `${CLI} secret set ${key.name}`, note: "the provider's key" }] }),
    },
  });
}

export async function turnOff(options: ProviderOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Turning ${id} off...` });
  const result = await turnProviderAppOff(gateway.db, id, options.now?.());
  const state = await providerState(gateway.cf, result.id);
  const where = result.organization ? ` for ${result.organization.name}` : "";
  const message = result.wasOn
    ? `${state.name} is off${where}`
    : `${state.name} was off already${where}`;
  out.emit({ type: "step", step: STEP, status: "ok", message, data: { id: result.id } });
  const lines = [
    `${message}.`,
    result.wasOn
      ? "Its tools left /mcp, and everyone's access to it went with it."
      : "Nothing changed.",
    state.key.set
      ? `${state.key.name} stays on the Gateway: ${CLI} secret unset ${state.key.name} removes it.`
      : `${state.key.name} isn't set on the Gateway.`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { id: result.id, name: state.name, on: false, wasOn: result.wasOn, key: state.key },
  });
}

/** An MCP app's name and its key's state (`set` is what `secret list` would say). */
async function providerState(
  cf: CfRunner,
  id: ProviderAppId,
): Promise<{ name: string; key: { name: string; set: boolean } }> {
  const names = await listWorkerSecrets(cf, GATEWAY_WORKER_NAME);
  const keySetting = providerAppKeySetting(id);
  return {
    name: PROVIDER_APPS[id].name,
    key: { name: keySetting, set: names.includes(keySetting) },
  };
}

export async function listProviders(options: ProviderOptions): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const [providers, names] = await Promise.all([
    listProviderApps(gateway.db),
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
  ]);
  const rows = providers.map((provider) => ({
    ...provider,
    key: { name: provider.keySetting, set: names.includes(provider.keySetting) },
  }));
  const table = formatTable(
    ["APP", "STATUS", "KEY"],
    rows.map((row) => [
      `${row.id}  ${chalk.dim(row.name)}`,
      row.on ? chalk.green("on") : chalk.dim("off"),
      row.key.set ? `${row.key.name} ${chalk.green("set")}` : `${row.key.name} ${chalk.yellow("not set")}`,
    ]),
  );
  const next = rows.flatMap((row) => [
    ...(row.on ? [] : [{ command: `${CLI} mcp on ${row.id}`, note: `offer ${row.name}` }]),
    ...(row.key.set ? [] : [{ command: `${CLI} secret set ${row.key.name}`, note: `${row.name}'s key` }]),
  ]);
  const summary = `${rows.filter((row) => row.on).length} of ${rows.length} MCP ${rows.length === 1 ? "app" : "apps"} on`;
  out.emit({
    type: "done",
    message: summary,
    display: [...table, "", chalk.dim(`Tools are on ${gateway.gatewayUrl}/mcp as <id>_<tool>.`)].join("\n"),
    data: {
      providers: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        on: row.on,
        key: row.key,
      })),
      mcp: `${gateway.gatewayUrl}/mcp`,
      ...(next.length > 0 ? { next } : {}),
    },
  });
}
