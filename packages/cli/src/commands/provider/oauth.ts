/**
 * The OAuth side of `everyapp provider`
 * (docs/design/2026-11-oauth-simplify.md,
 * docs/design/2026-11-oauth-one-connection.md): `add --oauth` registers a
 * preset or a spec file and can set its client in the same run; `presets`
 * lists what the picker offers; `connections` and
 * `disconnect` read and delete the connections the Gateway holds in D1,
 * each one person's to one provider, with the apps that person allowed to
 * use it.
 *
 * The CLI uploads a client as Worker secrets (`secret set`, which binds
 * the row), never as the sealed D1 row Admin → Providers writes: the key
 * that opens the D1 row lives in the Worker. It holds no token either, so
 * `disconnect` deletes the connection and says where to revoke the grant;
 * with `--app` it takes that one app's access away and leaves the
 * connection.
 */
import { stripVTControlCharacters } from "node:util";
import {
  CAPABILITIES,
  capabilitySettings,
  isPresetRow,
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
  removeAppAccess,
  removeConnections,
  type ProviderConnection,
  type UploadedClient,
} from "@/lib/gateway/providers";
import { installOrganization } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { factLines, finish } from "@/lib/output/result";
import { formatSteps } from "@/lib/output/steps";
import { formatTable } from "@/lib/output/table";
import { listed, plural } from "@/lib/output/text";
import { proseWidth } from "@/lib/output/wrap";
import type { GatewayCommandFlags } from "../flags";
import { providerConnectGuide, providerConnectSteps, providerDocsUrl } from "@/lib/providerDocs";
import { givenValues, setProviderSettings, setupShown, shortName, type CredentialFlags } from "./credentials";
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
 * How a provider spells scopes, from its spec: what an app's
 * `everyapp.config.ts` lists is the provider's own scope strings, short
 * (joined onto `prefix`) or in full; the Gateway adds `identity` to every
 * connect and lets a token carry `tolerated` beyond what was asked.
 */
export interface ScopeRulesSummary {
  separator: "space" | "comma";
  prefix?: string;
  identity: string[];
  tolerated: string[];
  /** The provider's list of scopes, when the spec names one. */
  reference?: string;
}

function scopeRulesOf(capability: OAuthClientCapability): ScopeRulesSummary {
  const { flow } = capability;
  return {
    separator: flow.scopeSeparator,
    ...(flow.scopePrefix ? { prefix: flow.scopePrefix } : {}),
    identity: [...flow.identityScopes],
    tolerated: [...flow.tolerated],
    ...(capability.reference ? { reference: capability.reference } : {}),
  };
}

/** The scope rules in one line: "space-separated, short ones joined onto https://…; the Gateway adds openid, email". */
function describeScopeRules(rules: ScopeRulesSummary): string {
  return [
    `${rules.separator}-separated${rules.prefix ? `, short ones joined onto ${rules.prefix}` : ""}`,
    ...(rules.identity.length > 0 ? [`the Gateway adds ${rules.identity.join(", ")}`] : []),
    ...(rules.tolerated.length > 0 ? [`tolerated: ${rules.tolerated.join(", ")}`] : []),
  ].join("; ");
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
    gatewayUrl: string;
    gatewayNames: readonly string[];
    uploaded: ReadonlyMap<string, UploadedClient>;
    connections: ReadonlyMap<string, number>;
  },
): Record<string, unknown> {
  const client = clientSourceOf(capability, context.gatewayNames, context.uploaded, id);
  return {
    redirectUri: redirectUriFor(context.gatewayUrl, id),
    console: capability.console,
    apiHosts: [...capability.api],
    scopes: scopeRulesOf(capability),
    client: {
      source: client,
      ...(client === "uploaded" ? { clientId: context.uploaded.get(id)!.clientId } : {}),
    },
    connections: context.connections.get(id) ?? 0,
  };
}

/** One preset as `provider presets` lists it. */
interface ListedPreset {
  id: string;
  name: string;
  console: string;
  hosts: string[];
  settings: string[];
  scopes: ScopeRulesSummary;
  hint?: string;
}

function presetOf(id: string, capability: OAuthClientCapability): ListedPreset {
  return {
    id,
    name: capability.label,
    console: capability.console,
    hosts: [...capability.api],
    settings: [...capabilitySettings(capability)],
    scopes: scopeRulesOf(capability),
    ...(capability.hint ? { hint: capability.hint } : {}),
  };
}

/** Every preset, in picker order. */
function allPresets(): ListedPreset[] {
  return oauthPresetIds().map((id) => presetOf(id, oauthPreset(id) as OAuthClientCapability));
}

/**
 * `provider presets`: what `provider add --oauth <id>` takes, with each
 * preset's API hosts and console. Nothing is read from the Gateway.
 */
export async function listPresets(options: Pick<ProviderOptions, "out">): Promise<void> {
  const presets = allPresets();
  const table = formatTable(
    ["ID", "NAME", "HOSTS", "CONSOLE"],
    presets.map((preset) => [preset.id, preset.name, hostsCell(preset.hosts), preset.console]),
  );
  options.out.emit({
    type: "done",
    message: `${presets.length} OAuth presets`,
    display: [
      ...table,
      "",
      chalk.dim(`Add one: ${CLI} provider add <id>`),
      chalk.dim("Apps list their scopes in everyapp.config.ts."),
    ].join("\n"),
    data: { presets },
  });
}

/** A table's HOSTS cell: the first host, then how many more there are (`--json` and `provider show` name them all). */
function hostsCell(hosts: readonly string[]): string {
  const [first, ...others] = hosts;
  if (!first) return chalk.dim("-");
  return others.length > 0 ? `${first} ${chalk.dim(`(+${plural(others.length, "other")})`)}` : first;
}

/** What `--oauth <value>` named: a preset, or a spec file or URL. */
type OAuthSource = { kind: "preset"; id: string; spec: unknown } | { kind: "spec"; spec: unknown };

async function resolveOAuthSource(value: string, options: OAuthAddOptions): Promise<OAuthSource> {
  const preset = OAUTH_PRESETS[value];
  if (preset) return { kind: "preset", id: value, spec: preset };
  if (Object.hasOwn(CAPABILITIES, value)) {
    throw new EveryAppError("PROVIDER_PRESET_UNKNOWN", `${value} is a built-in provider, not an OAuth one`, {
      rerun: `${CLI} provider presets`,
      rerunNote: "names every preset",
    });
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
    { rerun: `${CLI} provider presets`, rerunNote: "lists them with their consoles" },
  );
}

/**
 * `provider add --oauth <preset | spec>` (and `provider add <preset>`): a
 * preset or a spec becomes a registered row (as `provider add` writes one;
 * `--replace` applies); a preset already registered (a deploy registers
 * the presets its app lists) is left as it is. Then the one thing to do at the
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
  let registered = false;
  const existing =
    source.kind === "preset" && !flags.replace
      ? (await gatewayRegistry(gateway.db, gateway.install)).rows().find((row) => row.id === source.id)
      : undefined;
  // Only the preset's own row takes the client: a row of another spec under its id is the operator's.
  if (existing?.capability.mode === "oauth_client" && isPresetRow(existing.id, existing.capability)) {
    id = existing.id;
    capability = existing.capability;
    registered = true;
    out.emit({
      type: "step",
      step: "provider.add",
      status: "ok",
      message: `${capability.label} (${id}) is registered on ${gatewayHost} already: its client alone is set`,
      data: { id, registered: true },
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
    message: `Register the redirect URI ${redirectUri} at ${capability.console}`,
    data: { id, redirectUri, console: capability.console },
  });
  const [gatewayNames, uploaded, connections] = await Promise.all([
    listWorkerSecrets(gateway.cf, gateway.names.worker),
    readUploadedClients(gateway.db),
    countConnections(gateway.db),
  ]);
  const before = clientSourceOf(capability, gatewayNames, uploaded, id);
  // A row's client is set again after it is written: secret set binds it to the row's hosts.
  const needed = before !== "none" ? [] : settings;
  const name = shortName(capability.label);
  const given = await givenValues(settings, `${name}'s client`, flags, options, capability.secrets.clientId);
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const docs = providerDocsUrl(id);
  const added = registered
    ? `${name} (${id}) is on ${gatewayHost}`
    : `${replaced ? "Replaced" : "Registered"} ${name} (${id}) on ${gatewayHost}`;
  // No punctuation right after a URL: terminals link it too.
  const register = `Register this redirect URI at ${capability.console}\n   ${redirectUri}`;
  // The provider page's own steps, or one step for a provider whose page has none.
  const steps = providerConnectSteps(id, redirectUri) ?? [
    `1. Create an OAuth app in ${name}'s console (${capability.console}), with this redirect URI\n   ${redirectUri}`,
  ];
  const paste = interactive
    ? "Paste the Client ID and Client Secret."
    : "Set the Client ID and Client Secret with the command below.";
  // The client is set already; or it was given, and only the redirect URI is left to register; or every step.
  const asked = needed.length > 0 && Object.keys(given).length === 0;
  const setup =
    needed.length === 0
      ? [`${added}.`]
      : asked
        ? [`${added}.`, ...steps, `${steps.length + 1}. ${paste}`, `Docs: ${docs}`]
        : [`${added}.`, register, `Docs: ${docs}`];
  const registerShown = `Register this redirect URI at ${chalk.cyan(capability.console)}`;
  out.emit({
    type: "step",
    step: "provider.setup",
    status: "ok",
    message: setup.join("\n"),
    display: setupShown({
      added,
      steps:
        needed.length === 0
          ? []
          : asked
            ? formatSteps(
                [
                  ...(providerConnectGuide(id, redirectUri) ?? [
                    {
                      text: `Create an OAuth app in ${name}'s console, with this redirect URI.`,
                      links: [
                        { label: "Console", url: capability.console },
                        { label: "Redirect URI", url: redirectUri },
                      ],
                    },
                  ]),
                  { text: paste },
                ],
                proseWidth(),
              )
            : [registerShown, `  ${chalk.cyan(redirectUri)}`],
      docs: needed.length === 0 ? null : docs,
    }),
    data: { id, docs },
  });
  const outcome = await setProviderSettings({
    flags,
    out,
    ...(options.createCf ? { createCf: options.createCf } : {}),
    whose: `${name}'s client`,
    standing: "the provider is registered",
    // A preset's hosts are EveryApp's own, on its page; a spec's are said before its client is typed.
    whereKeysGoSaid: source.kind === "preset",
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
    gatewayUrl: gateway.gatewayUrl,
    gatewayNames: set ? [...gatewayNames, ...settings] : gatewayNames,
    uploaded,
    connections,
  });
  const client = (facts["client"] as { source: ClientSource }).source;
  const result = set
    ? [`Apps can now list ${id}. Live now, no deploy needed.`]
    : client === "env"
      ? [`Its client is set. Apps can list ${id}; each person connects once, from inside an app.`]
      : client === "uploaded"
        ? [`Its client was uploaded under Admin → Providers. Apps can list ${id}; each person connects once, from inside an app.`]
        : [];
  // The manifest entry is the docs page's and provider show's; --verbose prints it here too.
  const rules = scopeRulesOf(capability);
  const extra = [
    `In an app's capabilities: { ${JSON.stringify(id)}: { scopes: [<${capability.label}'s own scopes>], why: "..." } }`,
    `Scopes: ${describeScopeRules(rules)}${rules.reference ? ` (${rules.reference})` : ""}.`,
    "Each person connects once, for the scopes of every app that lists it, and allows each app to use it.",
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
  app?: string;
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

/** Whose a connection is, for a person: their email, else their id. */
function personOf(connection: ProviderConnection): string {
  return connection.userEmail ?? connection.userId;
}

/** A connection as `--json` reports it, with the provider's name. */
function reported(connection: ProviderConnection, name: string): Record<string, unknown> {
  return {
    id: connection.id,
    provider: connection.providerId,
    providerName: name,
    userId: connection.userId,
    userEmail: connection.userEmail,
    apps: connection.apps,
    label: connection.label,
    scopes: connection.scopes,
    status: connection.status,
    createdAt: new Date(connection.createdAt).toISOString(),
    lastUsedAt: connection.lastUsedAt === null ? null : new Date(connection.lastUsedAt).toISOString(),
    expiresAt: connection.expiresAt === null ? null : new Date(connection.expiresAt).toISOString(),
    organizationId: connection.organizationId,
  };
}

/**
 * `provider connections`: every connection the Gateway holds for its
 * organization (each one person's, to one provider, with the apps they
 * allowed to use it), newest first; with `--all` every organization's (a
 * hosted Gateway has several), `--user` one person's, `--provider` one
 * provider's, `--app` the ones one app may use. Never a token.
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
    ...(flags.app ? { appSlug: flags.app } : {}),
  });
  const nameOf = (id: string) => registry.get(id)?.label ?? id;
  const table = formatTable(
    ["PROVIDER", "PERSON", "APPS", "ACCOUNT", "SCOPES", "STATUS", "LAST USED", "CONNECTED"],
    connections.map((connection) => [
      `${nameOf(connection.providerId)} (${connection.providerId})`,
      personOf(connection),
      connection.apps.map((app) => app.id).join(", ") || chalk.dim("-"),
      connection.label ?? chalk.dim("-"),
      connection.scopes.join(", ") || chalk.dim("-"),
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
      ...(connections.length > 0
        ? table
        : [
            chalk.dim(
              `No connections${flags.provider ? ` to ${flags.provider}` : ""}${flags.user ? ` for ${flags.user}` : ""}${flags.app ? ` that ${flags.app} may use` : ""}. Each person connects once, from inside an app that lists the provider.`,
            ),
          ]),
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
  all?: boolean;
  app?: string;
}

/**
 * `provider disconnect <provider> --user <email> | --all [--app <app>]`:
 * the connections deleted from the Gateway's D1, each with the access apps
 * had to it, and `provider.disconnected` queued for each. The CLI holds no
 * token, so the grant stays at the provider until the person revokes it
 * there; the output says where. With `--app`, that one app's access to
 * those connections is taken away and the connections stay.
 */
export async function disconnectProvider(
  options: ProviderOptions & { flags: DisconnectFlags },
  id: string,
): Promise<void> {
  const { out, flags } = options;
  const chosen = [flags.user ? "--user" : null, flags.all ? "--all" : null].filter(Boolean);
  if (chosen.length !== 1) {
    throw new EveryAppError(
      "PROVIDER_CONNECTION_WHICH",
      chosen.length === 0
        ? `Say whose connection to ${id} you mean\nNothing was changed.`
        : `${listed(chosen as string[])} name different connections\nNothing was changed.`,
      {
        fix: `one of --user <email> (a person's) or --all (every connection to ${id}); add --app <app> to take only that app's access away`,
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
      { rerun: `${CLI} provider list`, rerunNote: "names the ones in use; --all names every one" },
    );
  }
  const whose = flags.user ? `for ${flags.user}` : "on this Gateway";
  const notFound = (which: string) =>
    new EveryAppError("PROVIDER_CONNECTION_NOT_FOUND", `No connection to ${capability.label} ${which}\nNothing was changed.`, {
      rerun: `${CLI} provider connections --provider ${id}`,
      rerunNote: "lists the ones there are",
    });
  if (flags.app) {
    // One app's access: the connections stay for the other apps.
    const app = flags.app;
    out.emit({ type: "step", step: "provider.disconnect", status: "start", message: `Removing ${app}'s access to ${capability.label}...` });
    const kept = await removeAppAccess(gateway.db, {
      providerId: id,
      appSlug: app,
      ...(flags.user ? { userEmail: flags.user } : {}),
    });
    if (kept.length === 0) throw notFound(`${whose} that ${app} may use`);
    out.emit({
      type: "step",
      step: "provider.disconnect",
      status: "ok",
      message: `Removed ${app}'s access to ${plural(kept.length, "connection")} to ${capability.label}`,
      data: { id, app, removed: kept.length },
    });
    const lines = [
      `${app} can no longer use ${kept.length === 1 ? `${personOf(kept[0]!)}'s connection` : `${kept.length} connections`} to ${capability.label} (${id}).`,
      `The Gateway keeps the tokens for the other apps; ${app} gets "not connected" until the person allows it again.`,
    ];
    finish(out, {
      headline: lines[0]!.replace(/\.$/, ""),
      message: lines,
      detail: lines.slice(1),
      data: {
        id,
        name: capability.label,
        app,
        connections: kept.map((connection) => reported(connection, capability.label)),
        revoked: false,
      },
    });
    return;
  }
  out.emit({ type: "step", step: "provider.disconnect", status: "start", message: `Removing connections to ${capability.label}...` });
  const removed = await removeConnections(
    gateway.db,
    {
      providerId: id,
      providerName: capability.label,
      ...(flags.user ? { userEmail: flags.user } : {}),
    },
    gateway.deployer,
    options.now?.(),
  );
  if (removed.length === 0) throw notFound(whose);
  out.emit({
    type: "step",
    step: "provider.disconnect",
    status: "ok",
    message: `Removed ${plural(removed.length, "connection")} to ${capability.label}`,
    data: { id, removed: removed.length },
  });
  const lines = [
    `Removed ${removed.length === 1 ? `${personOf(removed[0]!)}'s connection` : `${removed.length} connections`} to ${capability.label} (${id}).`,
    "The Gateway no longer holds the tokens; every app that used the connection gets \"not connected\" until the person connects again.",
    `The grant stays at ${capability.label} until it is revoked there: ${capability.console} (Disconnect in Connected accounts revokes it from the Gateway).`,
  ];
  finish(out, {
    headline: lines[0]!.replace(/\.$/, ""),
    blocks: [
      factLines([{ label: "Revoke", value: `${chalk.cyan(capability.console)} ${chalk.dim(`· the grant stays at ${capability.label} until then`)}` }]),
    ],
    message: lines,
    detail: lines.slice(1),
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
export function isOAuthCapability(capability: Capability): capability is OAuthClientCapability {
  return capability.mode === "oauth_client";
}
