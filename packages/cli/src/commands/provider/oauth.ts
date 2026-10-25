/**
 * The OAuth side of `everyapp provider`
 * (docs/design/2026-10-oauth-providers.md): `add --oauth` registers a
 * preset, a spec file or a built-in client and can set its client in the
 * same run; `presets` lists what the picker offers; `connections` and
 * `disconnect` read and delete the connections (people's and the
 * organization's tokens for a provider) the Gateway holds in D1.
 *
 * The CLI uploads a client as Worker secrets (`secret set`, which binds
 * the row), never as the sealed D1 row Admin → Providers writes: the key
 * that opens the D1 row lives in the Worker. It holds no token either, so
 * `disconnect` deletes the connection and says where to revoke the grant.
 */
import { text as readAll } from "node:stream/consumers";
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import {
  CAPABILITIES,
  capabilitySettings,
  isOAuthProvider,
  OAUTH_PRESETS,
  oauthPreset,
  oauthPresetIds,
  parseProviderSpec,
  type Capability,
  type OAuthClientCapability,
  type RegistrableCapability,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import {
  addProvider,
  countConnections,
  gatewayRegistry,
  listConnections,
  readUploadedClients,
  removeConnections,
  type ProviderConnection,
  type UploadedClient,
} from "@/lib/gateway/providers";
import { installOrganization } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { formatTable } from "@/lib/output/table";
import { listed } from "@/lib/output/text";
import type { GatewayCommandFlags } from "../flags";
import { parsePipedLines } from "../configure";
import { applySecretValues } from "../secret";
import { readSpecSource, type ProviderOptions } from "./index";

/** The flags `provider add --oauth` adds to `provider add`. */
export interface OAuthAddFlags {
  replace?: boolean;
  oauth?: string;
  "client-id"?: string;
  "from-env"?: boolean;
}

interface OAuthAddOptions extends ProviderOptions {
  flags: GatewayCommandFlags & OAuthAddFlags;
  /** What was piped in, or null when nothing was (default: stdin when it isn't a terminal). */
  readStdin?: () => Promise<string | null>;
  /** The environment --from-env reads (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Where a connection's redirect lands: the callback the operator registers at the provider's console. */
function redirectUriFor(gatewayUrl: string, id: string): string {
  return `${gatewayUrl.replace(/\/$/, "")}/connect/${id}/callback`;
}

/**
 * Which flow an OAuth entry supports, as the Gateway's service says it: an
 * entry with a `flow` block runs the Gateway's connect flow and still
 * completes an app's own token-endpoint calls (`both`); one without (the
 * social networks) is the app-driven flow alone (`app`).
 */
function flowOf(capability: OAuthClientCapability): "app" | "both" {
  return capability.flow ? "both" : "app";
}

/** A scope set as the surfaces list it. */
interface ScopeSetSummary {
  name: string;
  label: string;
  access: string;
  scopes: string[];
}

function scopeSetsOf(capability: OAuthClientCapability): ScopeSetSummary[] {
  return Object.entries(capability.scopePolicy?.sets ?? {}).map(([name, set]) => ({
    name,
    label: set.label,
    access: set.access,
    scopes: [...set.scopes],
  }));
}

/** Where a provider's client comes from on this Gateway: a Worker secret the CLI set, a row uploaded in the UI, or nowhere yet. */
type ClientSource = "env" | "uploaded" | "none";

function clientSourceOf(
  capability: OAuthClientCapability,
  gatewayNames: readonly string[],
  uploaded: ReadonlyMap<string, UploadedClient>,
  id: string,
): ClientSource {
  if (gatewayNames.includes(capability.secrets.clientId)) return "env";
  if (uploaded.has(id)) return "uploaded";
  return "none";
}

/** What `provider list`, `provider show` and `provider add --oauth` say about an OAuth entry, for their `--json` data. */
export function oauthFacts(
  id: string,
  capability: OAuthClientCapability,
  context: {
    source: "catalog" | "row";
    gatewayUrl: string;
    gatewayNames: readonly string[];
    uploaded: ReadonlyMap<string, UploadedClient>;
    connections: ReadonlyMap<string, number>;
  },
): Record<string, unknown> {
  const client = clientSourceOf(capability, context.gatewayNames, context.uploaded, id);
  return {
    flow: flowOf(capability),
    redirectUri: redirectUriFor(context.gatewayUrl, id),
    console: capability.console,
    scopeSets: scopeSetsOf(capability),
    client: {
      source: client,
      ...(client === "uploaded" ? { clientId: context.uploaded.get(id)!.clientId } : {}),
    },
    connections: context.connections.get(id) ?? 0,
  };
}

/** The catalog's OAuth entries the Gateway runs the flow for (`google-workspace`, `slack`, …), as presets. */
function builtInOAuthIds(): string[] {
  return Object.entries(CAPABILITIES)
    .filter(([, capability]) => isOAuthProvider(capability as Capability))
    .map(([id]) => id);
}

/** One preset as `provider presets` lists it. */
interface ListedPreset {
  id: string;
  name: string;
  /** A built-in client (no row is written; its client alone is set) or a preset that becomes a row. */
  builtIn: boolean;
  console: string;
  hosts: string[];
  settings: string[];
  scopeSets: ScopeSetSummary[];
  hint?: string;
}

function presetOf(id: string, capability: OAuthClientCapability, builtIn: boolean): ListedPreset {
  return {
    id,
    name: capability.label,
    builtIn,
    console: capability.console,
    hosts: [...capability.api],
    settings: [...capabilitySettings(capability)],
    scopeSets: scopeSetsOf(capability),
    ...(capability.hint ? { hint: capability.hint } : {}),
  };
}

/** Every preset: the catalog's OAuth entries with a flow first, then the SDK's presets, in picker order. */
function allPresets(): ListedPreset[] {
  return [
    ...builtInOAuthIds().map((id) =>
      presetOf(id, CAPABILITIES[id as keyof typeof CAPABILITIES] as OAuthClientCapability, true),
    ),
    ...oauthPresetIds().map((id) => presetOf(id, oauthPreset(id) as OAuthClientCapability, false)),
  ];
}

/**
 * `provider presets`: what `provider add --oauth <id>` takes, with each
 * preset's scope sets and console. Nothing is read from the Gateway.
 */
export async function listPresets(options: Pick<ProviderOptions, "out">): Promise<void> {
  const presets = allPresets();
  const table = formatTable(
    ["ID", "NAME", "KIND", "SCOPE SETS", "CONSOLE"],
    presets.map((preset) => [
      preset.id,
      preset.name,
      preset.builtIn ? "built in" : "preset",
      preset.scopeSets.map((set) => set.name).join(", ") || chalk.dim("-"),
      preset.console,
    ]),
  );
  options.out.emit({
    type: "done",
    message: `${presets.length} OAuth presets: ${presets.filter((preset) => preset.builtIn).length} built in, ${presets.filter((preset) => !preset.builtIn).length} to register`,
    display: [
      ...table,
      "",
      chalk.dim(`Add one: ${CLI} provider add --oauth <id>; a built-in one takes its client only, a preset becomes a registered provider.`),
    ].join("\n"),
    data: { presets, next: [{ command: `${CLI} provider add --oauth github-oauth`, note: "registers GitHub and prints the redirect URI to register at its console" }] },
  });
}

/** What `--oauth <value>` named: a preset, a built-in client, or a spec file or URL. */
type OAuthSource =
  | { kind: "preset"; id: string; spec: unknown }
  | { kind: "catalog"; id: string; capability: OAuthClientCapability }
  | { kind: "spec"; spec: unknown };

async function resolveOAuthSource(value: string, options: OAuthAddOptions): Promise<OAuthSource> {
  const preset = OAUTH_PRESETS[value];
  if (preset) return { kind: "preset", id: value, spec: preset };
  const builtIn = (CAPABILITIES as Record<string, Capability>)[value];
  if (builtIn && isOAuthProvider(builtIn)) {
    return { kind: "catalog", id: value, capability: builtIn as OAuthClientCapability };
  }
  if (builtIn) {
    throw new EveryAppError(
      "PROVIDER_PRESET_UNKNOWN",
      `${value} is a built-in ${builtIn.mode === "oauth_client" ? "OAuth client the Gateway completes token calls for; apps run its flow themselves" : "provider, not an OAuth one"}`,
      { rerun: `${CLI} provider presets`, rerunNote: "names every preset and built-in client" },
    );
  }
  if (/[./\\]/.test(value)) {
    const spec = await readSpecSource(value, { cwd: options.cwd ?? process.cwd(), fetcher: options.fetch });
    // An API-key spec parses too: refused here, before a row is written.
    const parsed = parseProviderSpec(spec);
    if (parsed.ok && parsed.capability.mode !== "oauth_client") {
      throw new EveryAppError(
        "PROVIDER_SPEC_INVALID",
        `${value} is an API-key spec (auth.kind ${parsed.capability.auth.kind})\n--oauth takes a spec with auth.kind "oauth2-user". Nothing was registered.`,
        { fix: `register it with ${CLI} provider add ${value}` },
      );
    }
    return { kind: "spec", spec };
  }
  throw new EveryAppError(
    "PROVIDER_PRESET_UNKNOWN",
    `No OAuth preset ${value}\nPresets: ${listed(allPresets().map((preset) => preset.id))}. A custom provider is a JSON file: ${CLI} provider add --oauth ./acme.json.`,
    { rerun: `${CLI} provider presets`, rerunNote: "lists them with their scope sets" },
  );
}

/** What was piped in, or null at a terminal or when nothing was. */
async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const piped = await readAll(process.stdin);
  return piped.trim() ? piped : null;
}

/**
 * The client's values for this run: `--client-id` for the id (public),
 * piped `NAME=value` lines for either name, and with `--from-env` the
 * variables of the settings' names. A name that isn't the client's is
 * refused without being echoed. Empty when no value was given.
 */
async function clientValues(
  capability: OAuthClientCapability,
  options: OAuthAddOptions,
): Promise<Record<string, string>> {
  const names = capabilitySettings(capability);
  const values: Record<string, string> = {};
  const piped = options.flags["from-env"] ? null : await (options.readStdin ?? readPipedStdin)();
  if (piped !== null) {
    for (const { name, value, line } of parsePipedLines(piped)) {
      if (!names.includes(name)) {
        const shown = /^[A-Z][A-Z0-9_]*$/.test(name) ? name : `line ${line} (not shown: it may be a value)`;
        throw new EveryAppError(
          "SECRET_NOT_DECLARED",
          `${capability.label}'s client isn't ${shown}\nThe piped lines set ${listed([...names])}. Nothing was set.`,
          { fix: `pipe ${names.join(" and ")} as NAME=value lines` },
        );
      }
      if (!value.trim()) {
        throw new EveryAppError("SECRET_EMPTY", `${name} is empty in the piped input\nNothing was set.`, {
          fix: "give it a value, or leave the line out",
        });
      }
      values[name] = value;
    }
  }
  if (options.flags["from-env"]) {
    const env = options.env ?? process.env;
    for (const name of names) {
      const value = env[name];
      if (value && !(name in values)) values[name] = value;
    }
  }
  const clientId = options.flags["client-id"]?.trim();
  if (clientId) values[capability.secrets.clientId] = clientId;
  return values;
}

/**
 * `provider add --oauth <preset | built-in | spec>`: a preset or a spec
 * becomes a registered row (as `provider add` writes one; `--replace`
 * applies); a built-in client (`google-workspace`) writes no row. Then the
 * redirect URI to register at the provider's console, and the client set
 * in the same run when its values were given (`--client-id`, piped
 * `NAME=value` lines, `--from-env`), through `secret set`, which binds the
 * row. Without them, the command to set it next.
 */
export async function addOAuth(options: OAuthAddOptions, value: string): Promise<void> {
  const { out, flags } = options;
  const source = await resolveOAuthSource(value, options);
  const gateway = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf: options.createCf,
  });
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  let id: string;
  let capability: OAuthClientCapability;
  let replaced = false;
  let rowSource: "catalog" | "row";
  if (source.kind === "catalog") {
    id = source.id;
    capability = source.capability;
    rowSource = "catalog";
    out.emit({
      type: "step",
      step: "provider.add",
      status: "ok",
      message: `${capability.label} (${id}) is built in: no row to write, its client alone is set`,
      data: { id, builtIn: true },
    });
  } else {
    const named = source.kind === "preset" ? source.id : "the provider";
    out.emit({ type: "step", step: "provider.add", status: "start", message: `Registering ${named}...` });
    const added = await addProvider(gateway.db, {
      spec: source.spec,
      deployer: gateway.deployer,
      replace: flags.replace ?? false,
      install: gateway.install,
      now: options.now?.(),
    });
    if (added.capability.mode !== "oauth_client") {
      throw new Error(`${added.id} isn't an OAuth spec after all`); // resolveOAuthSource refused it already
    }
    id = added.id;
    capability = added.capability;
    replaced = added.replaced;
    rowSource = "row";
    out.emit({
      type: "step",
      step: "provider.add",
      status: "ok",
      message: `${replaced ? "Replaced" : "Registered"} ${capability.label} (${id}) on ${gatewayHost}`,
      data: { id, replaced },
    });
  }
  const settings = [...capabilitySettings(capability)];
  const redirectUri = redirectUriFor(gateway.gatewayUrl, id);
  out.emit({
    type: "step",
    step: "provider.redirect",
    status: "ok",
    message: `Register this redirect URI at ${capability.console}: ${redirectUri}`,
    data: { id, redirectUri, console: capability.console },
  });
  const values = await clientValues(capability, options);
  const given = Object.keys(values);
  if (given.length > 0) {
    const missing = settings.filter((name) => !(name in values));
    if (missing.length > 0) {
      throw new EveryAppError(
        "PROVIDER_CLIENT_INCOMPLETE",
        `${capability.label}'s client needs ${listed(missing)} too\nNothing was set; the provider ${rowSource === "row" ? "is registered" : "is built in"}.`,
        {
          fix: `pipe ${missing.join(" and ")} as NAME=value lines, export ${missing.length === 1 ? "it" : "them"} and add --from-env, or run ${CLI} secret set ${settings.join(" ")}`,
        },
      );
    }
    await applySecretValues({
      flags: { ...flags },
      out,
      names: settings,
      readValue: async (name) => values[name]!,
      ...(options.createCf ? { createCf: options.createCf } : {}),
    });
  }
  const [gatewayNames, uploaded, connections] = await Promise.all([
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
    readUploadedClients(gateway.db),
    countConnections(gateway.db),
  ]);
  const facts = oauthFacts(id, capability, {
    source: rowSource,
    gatewayUrl: gateway.gatewayUrl,
    gatewayNames,
    uploaded,
    connections,
  });
  const client = facts["client"] as { source: ClientSource };
  const sets = scopeSetsOf(capability);
  const lines = [
    rowSource === "catalog"
      ? `${capability.label} (${id}) is built in on ${gatewayHost}.`
      : `${replaced ? "Replaced" : "Registered"} ${capability.label} (${id}) on ${gatewayHost}.`,
    `Redirect URI to register at ${capability.console}: ${redirectUri}`,
    ...(sets.length > 0 ? [`Scope sets apps may list: ${sets.map((set) => `${set.name} (${set.label})`).join(", ")}.`] : []),
    client.source === "none"
      ? `Its client isn't set yet: ${CLI} secret set ${settings.join(" ")} (or paste it under Admin → Providers).`
      : client.source === "env"
        ? `Its client is set${given.length > 0 ? " and live now" : ""}: people connect at ${gateway.gatewayUrl}/connect/${id}.`
        : `Its client was uploaded under Admin → Providers: people connect at ${gateway.gatewayUrl}/connect/${id}.`,
    `Apps list it as capabilities: { ${JSON.stringify(id)}: { access: "read", scopes: [${sets
      .slice(0, 2)
      .map((set) => JSON.stringify(set.name))
      .join(", ")}], why: "..." } }.`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: {
      id,
      name: capability.label,
      kind: "oauth",
      source: rowSource,
      replaced,
      settings,
      ...facts,
      ...(client.source === "none"
        ? {
            next: [
              {
                command: `${CLI} secret set ${settings.join(" ")}`,
                note: `${capability.label}'s client id and secret from ${capability.console}; register ${redirectUri} there first`,
              },
            ],
          }
        : {}),
    },
  });
}

/** The flags of `provider connections`. */
export interface ConnectionsFlags {
  all?: boolean;
  user?: string;
  provider?: string;
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

function when(ms: number | null): string {
  return ms === null ? chalk.dim("-") : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** A connection as `--json` reports it, with the provider's name. */
function reported(connection: ProviderConnection, name: string): Record<string, unknown> {
  return {
    id: connection.id,
    provider: connection.providerId,
    providerName: name,
    account: connection.account,
    ...(connection.userId ? { userId: connection.userId, userEmail: connection.userEmail } : {}),
    label: connection.label,
    scopeSets: connection.scopeSets,
    status: connection.status,
    createdAt: new Date(connection.createdAt).toISOString(),
    lastUsedAt: connection.lastUsedAt === null ? null : new Date(connection.lastUsedAt).toISOString(),
    expiresAt: connection.expiresAt === null ? null : new Date(connection.expiresAt).toISOString(),
    organizationId: connection.organizationId,
  };
}

/**
 * `provider connections`: every connection the Gateway holds for its
 * organization (people's and the organization's own), newest first; with
 * `--all` every organization's (a hosted Gateway has several), `--user`
 * one person's, `--provider` one provider's. Never a token.
 */
export async function listProviderConnections(
  options: ProviderOptions & { flags: ConnectionsFlags },
): Promise<void> {
  const { out, flags } = options;
  const gateway = await connect(options);
  const [registry, found] = await Promise.all([
    gatewayRegistry(gateway.db, gateway.install),
    flags.all ? Promise.resolve(null) : installOrganization(gateway.db),
  ]);
  const connections = await listConnections(gateway.db, {
    ...(found ? { organizationId: found.organization.id } : {}),
    ...(flags.user ? { userEmail: flags.user } : {}),
    ...(flags.provider ? { providerId: flags.provider } : {}),
  });
  const nameOf = (id: string) => registry.get(id)?.label ?? id;
  const table = formatTable(
    ["PROVIDER", "ACCOUNT", "LABEL", "SCOPE SETS", "STATUS", "LAST USED", "CONNECTED"],
    connections.map((connection) => [
      `${nameOf(connection.providerId)} (${connection.providerId})`,
      connection.account === "organization" ? "the organization" : (connection.userEmail ?? connection.userId ?? "?"),
      connection.label ?? chalk.dim("-"),
      connection.scopeSets.join(", ") || chalk.dim("-"),
      connection.status === "active" ? chalk.green("active") : chalk.yellow(connection.status),
      when(connection.lastUsedAt),
      when(connection.createdAt),
    ]),
  );
  const scope = flags.all ? "every organization" : found ? found.organization.name : "this Gateway";
  out.emit({
    type: "done",
    message: `${connections.length} connection${connections.length === 1 ? "" : "s"} on ${scope}`,
    display: [
      ...(connections.length > 0 ? table : [chalk.dim(`No connections${flags.provider ? ` to ${flags.provider}` : ""}${flags.user ? ` for ${flags.user}` : ""}. People connect at ${gateway.gatewayUrl}/connect/<provider>.`)]),
    ].join("\n"),
    data: {
      connections: connections.map((connection) => reported(connection, nameOf(connection.providerId))),
      ...(found ? { organizationId: found.organization.id } : {}),
    },
  });
}

/** The flags of `provider disconnect`. */
export interface DisconnectFlags {
  user?: string;
  organization?: boolean;
  all?: boolean;
}

/**
 * `provider disconnect <provider> --user <email> | --organization | --all`:
 * the connections deleted from the Gateway's D1 and `provider.disconnected`
 * queued for each. The CLI holds no token, so the grant stays at the
 * provider until the person revokes it there; the output says where.
 */
export async function disconnectProvider(
  options: ProviderOptions & { flags: DisconnectFlags },
  id: string,
): Promise<void> {
  const { out, flags } = options;
  const chosen = [flags.user ? "--user" : null, flags.organization ? "--organization" : null, flags.all ? "--all" : null].filter(Boolean);
  if (chosen.length !== 1) {
    throw new EveryAppError(
      "PROVIDER_CONNECTION_WHICH",
      chosen.length === 0
        ? `Say whose connection to ${id} to remove\nNothing was changed.`
        : `${listed(chosen as string[])} name different connections\nNothing was changed.`,
      {
        fix: `one of --user <email> (a person's), --organization (the organization's own) or --all (every connection to ${id})`,
      },
    );
  }
  const gateway = await connect(options);
  const registry = await gatewayRegistry(gateway.db, gateway.install);
  const capability = registry.get(id);
  if (!capability || capability.mode !== "oauth_client") {
    throw new EveryAppError(
      "PROVIDER_NOT_FOUND",
      capability ? `${id} isn't an OAuth provider: nobody connects to it` : `${id} isn't a provider this Gateway offers`,
      { rerun: `${CLI} provider list`, rerunNote: "names every one" },
    );
  }
  out.emit({ type: "step", step: "provider.disconnect", status: "start", message: `Removing connections to ${capability.label}...` });
  const removed = await removeConnections(
    gateway.db,
    {
      providerId: id,
      providerName: capability.label,
      ...(flags.user ? { userEmail: flags.user } : {}),
      ...(flags.organization ? { organization: true } : {}),
    },
    gateway.deployer,
    options.now?.(),
  );
  if (removed.length === 0) {
    throw new EveryAppError(
      "PROVIDER_CONNECTION_NOT_FOUND",
      `No connection to ${capability.label} ${flags.user ? `for ${flags.user}` : flags.organization ? "for the organization" : "on this Gateway"}\nNothing was changed.`,
      { rerun: `${CLI} provider connections --provider ${id}`, rerunNote: "lists the ones there are" },
    );
  }
  out.emit({
    type: "step",
    step: "provider.disconnect",
    status: "ok",
    message: `Removed ${removed.length} connection${removed.length === 1 ? "" : "s"} to ${capability.label}`,
    data: { id, removed: removed.length },
  });
  const who = removed.map((connection) =>
    connection.account === "organization" ? "the organization" : (connection.userEmail ?? connection.userId ?? "someone"),
  );
  const lines = [
    `Removed ${removed.length === 1 ? `${who[0]}'s` : `${removed.length}`} connection${removed.length === 1 ? "" : "s"} to ${capability.label} (${id}).`,
    "The Gateway no longer holds the tokens; apps get \"not connected\" until the person connects again.",
    `The grant stays at ${capability.label} until it is revoked there: ${capability.console} (Admin → Providers → Disconnect revokes it from the Gateway).`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: {
      id,
      name: capability.label,
      removed: removed.map((connection) => reported(connection, capability.label)),
      revoked: false,
      revokeAt: capability.console,
    },
  });
}

/** The OAuth entries a `provider` listing can describe: the registry's `oauth_client` entries. */
export function isOAuthCapability(capability: RegistrableCapability | Capability): capability is OAuthClientCapability {
  return capability.mode === "oauth_client";
}
