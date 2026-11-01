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
import { stripVTControlCharacters } from "node:util";
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
import { providerDocsUrl } from "@/lib/providerDocs";
import { givenValues, setProviderSettings, shortName, type CredentialFlags } from "./credentials";
import { readSpecSource, type ProviderOptions } from "./index";

/** The flags `provider add --oauth` adds to `provider add`. */
export interface OAuthAddFlags extends CredentialFlags {
  replace?: boolean;
  oauth?: string;
}

type OAuthAddOptions = ProviderOptions & { flags: GatewayCommandFlags & OAuthAddFlags };

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
        `${value} is ${parsed.capability.mode === "ai" ? "an ai spec" : `an API-key spec (auth.kind ${parsed.capability.auth.kind})`}\n--oauth takes a spec with auth.kind "oauth2-user". Nothing was registered.`,
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

/**
 * `provider add --oauth <preset | built-in | spec>` (and `provider add
 * <id>` of one): a preset or a spec becomes a registered row (as
 * `provider add` writes one; `--replace` applies); a built-in client
 * (`google-workspace`) writes no row. Then the one thing to do at the
 * provider's console (register the redirect URI) and the docs page, and
 * the client set in the same run (credentials.ts): from `--client-id`,
 * piped `NAME=value` lines or `--from-env`, else asked for at the
 * terminal. Unattended or skipped, the `secret set` to run next.
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
    // The client as this Gateway serves it: an operator's scope sets included.
    const served = (await gatewayRegistry(gateway.db, gateway.install)).get(id);
    capability = served?.mode === "oauth_client" ? served : source.capability;
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
  const [gatewayNames, uploaded, connections] = await Promise.all([
    listWorkerSecrets(gateway.cf, gateway.names.worker),
    readUploadedClients(gateway.db),
    countConnections(gateway.db),
  ]);
  const before = clientSourceOf(capability, gatewayNames, uploaded, id);
  // A row's client is set again after it is written: secret set binds it to the row's hosts.
  const needed = before !== "none" ? [] : rowSource === "row" ? settings : settings.filter((name) => !gatewayNames.includes(name));
  const name = shortName(capability.label);
  const given = await givenValues(settings, `${name}'s client`, flags, options, capability.secrets.clientId);
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const docs = providerDocsUrl(id);
  const header =
    rowSource === "catalog"
      ? `${name} (${id}) is on ${gatewayHost}.`
      : `${replaced ? "Replaced" : "Registered"} ${name} (${id}) on ${gatewayHost}.`;
  const register = `Register this redirect URI at ${capability.console}:\n   ${redirectUri}`;
  const setup =
    needed.length === 0
      ? [header]
      : Object.keys(given).length > 0
        ? [header, register, `Docs: ${docs}`]
        : [
            header,
            `1. ${register}`,
            interactive ? "2. Paste the OAuth client it gives you." : "2. Set the client it gives you with the command below.",
            `Docs: ${docs}`,
          ];
  out.emit({ type: "step", step: "provider.setup", status: "ok", message: setup.join("\n"), data: { id, docs } });
  const outcome = await setProviderSettings({
    flags,
    out,
    ...(options.createCf ? { createCf: options.createCf } : {}),
    whose: `${name}'s client`,
    standing: `the provider ${rowSource === "row" ? "is registered" : "is built in"}`,
    settings,
    needed,
    given,
    interactive,
    ...(options.ask ? { ask: options.ask } : {}),
    questionOf: (setting) =>
      setting === capability.secrets.clientId ? "Client id" : setting === capability.secrets.clientSecret ? "Client secret" : setting,
  });
  const set = outcome === "set";
  const facts = oauthFacts(id, capability, {
    source: rowSource,
    gatewayUrl: gateway.gatewayUrl,
    gatewayNames: set ? [...gatewayNames, ...settings] : gatewayNames,
    uploaded,
    connections,
  });
  const client = (facts["client"] as { source: ClientSource }).source;
  const connectAt = `${gateway.gatewayUrl}/connect/${id}`;
  const result = set
    ? [`Apps can now list ${id}. Live now, no deploy needed.`]
    : client === "env"
      ? [`Its client is set: people connect at ${connectAt}. Apps can list ${id}.`]
      : client === "uploaded"
        ? [`Its client was uploaded under Admin → Providers: people connect at ${connectAt}. Apps can list ${id}.`]
        : [];
  const sets = scopeSetsOf(capability);
  // The scope sets and the manifest entry are the docs page's and provider show's; --verbose prints them here too.
  const extra = [
    ...(sets.length > 0 ? [`Scope sets: ${sets.map((each) => `${each.name}: ${each.label}`).join("; ")}.`] : []),
    `In an app's capabilities: { ${JSON.stringify(id)}: { access: "read", scopes: [${sets
      .slice(0, 2)
      .map((each) => JSON.stringify(each.name))
      .join(", ")}], why: "..." } }`,
  ];
  const display = [...result, ...(flags.verbose ? extra.map((line) => chalk.dim(line)) : [])];
  out.emit({
    type: "done",
    message: stripVTControlCharacters([...setup, ...result].join("\n")),
    display: display.join("\n"),
    data: {
      id,
      name: capability.label,
      kind: "oauth",
      source: rowSource,
      replaced,
      settings,
      docs,
      ...facts,
      ...(client === "none" ? { next: [{ command: `${CLI} secret set ${(needed.length > 0 ? needed : settings).join(" ")}` }] } : {}),
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
