/**
 * `everyapp provider add|list|show|remove|presets|connections|disconnect`: the provider registry
 * (docs/design/2026-10-provider-registry.md). Every API provider the
 * Gateway brokers is an entry of data: the built-in catalog
 * (`@every-app/sdk/internal` capabilities.ts) and the rows this Gateway
 * registered (`providers` in its D1, lib/gateway/providers.ts), which the
 * CLI writes under the Cloudflare login (ADR-0003) and the Gateway reads
 * within 30 seconds. An app lists either kind under `capabilities` and
 * calls it with `integrationFetch()`; the key is a Gateway setting, set
 * with `secret set`, which binds a row's key to the hosts the row has then.
 *
 * `provider on|off` (hidden) run `mcp on|off`, which they were until
 * 2026-10-24, and say so: through launch week only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import {
  CAPABILITIES,
  capabilitySettings,
  DEV_PROVIDERS_DIR,
  describeTokenEndpoints,
  devProviderFile,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerIds,
  providerSpecOf,
  type Capability,
  type ProviderRegistry,
  type RegistrableCapability,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { isNotFoundError } from "@/lib/file-operations";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import {
  addProvider,
  countConnections,
  gatewayRegistry,
  readUploadedClients,
  removeProvider,
  type UploadedClient,
} from "@/lib/gateway/providers";
import { listApps } from "@/lib/gateway/registry";
import { providerDocsUrl } from "@/lib/providerDocs";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { listed } from "@/lib/output/text";
import type { GatewayCommandFlags } from "../flags";
import { turnOff, turnOn } from "../mcp";
import {
  addOAuth,
  disconnectProvider,
  isOAuthCapability,
  listPresets,
  listProviderConnections,
  oauthFacts,
  type ConnectionsFlags,
  type DisconnectFlags,
  type OAuthAddFlags,
} from "./oauth";
import { givenValues, setProviderSettings, shortName, type CredentialFlags, type CredentialSeams } from "./credentials";

/** The most a spec may be, from a file or a URL. */
export const MAX_SPEC_BYTES = 64 * 1024;

/** What the handlers take from the command line, and the seams tests use. */
export interface ProviderOptions extends CredentialSeams {
  flags: GatewayCommandFlags;
  out: EventSink;
  /** Where a spec path is read from and an app's directory is looked for (default: the working directory). */
  cwd?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** How a spec URL is fetched (tests). */
  fetch?: typeof fetch;
  now?: () => number;
}

export async function add(flags: GatewayCommandFlags & OAuthAddFlags, spec?: string): Promise<void> {
  await runCommand(flags, (out) => addAny({ flags, out }, spec));
}

/**
 * `provider add`, by what it was given: `--oauth <value>` or a preset or
 * built-in OAuth client's id (addOAuth); a built-in API-key or AI
 * provider's id (addBuiltIn); a spec file or URL (addFromSpec).
 */
export async function addAny(
  options: ProviderOptions & { flags: GatewayCommandFlags & OAuthAddFlags },
  spec?: string,
): Promise<void> {
  const { flags } = options;
  if (flags.oauth) {
    if (spec) {
      throw new EveryAppError(
        "PROVIDER_SPEC_INVALID",
        `--oauth ${flags.oauth} names the provider; ${spec} was given too
Nothing was changed.`,
        { fix: `give one: ${CLI} provider add --oauth ${flags.oauth}, or ${CLI} provider add ${spec}` },
      );
    }
    await addOAuth(options, flags.oauth);
    return;
  }
  if (!spec) {
    throw new EveryAppError("PROVIDER_SPEC_INVALID", "Give the provider to add\nA built-in provider's id (provider list), a JSON spec file or https URL, or --oauth <preset>.", {
      rerun: `${CLI} provider list`,
      rerunNote: "names the built-in providers",
    });
  }
  const builtIn = builtInOf(spec);
  if (builtIn?.mode === "oauth_client" || Object.hasOwn(OAUTH_PRESETS, spec)) {
    await addOAuth(options, spec);
    return;
  }
  if (builtIn) {
    await addBuiltIn(options, spec, builtIn);
    return;
  }
  if (!/[./\\:]/.test(spec)) {
    throw new EveryAppError("PROVIDER_NOT_FOUND", `${spec} isn't a built-in provider\nA provider the catalog doesn't have is added from its spec: a JSON file or an https URL.`, {
      rerun: `${CLI} provider list`,
      rerunNote: "names the built-in providers",
    });
  }
  await addFromSpec(options, spec);
}

/** The catalog's entry `id`, when it is one. */
function builtInOf(id: string): Capability | null {
  return Object.hasOwn(CAPABILITIES, id) ? (CAPABILITIES as Record<string, Capability>)[id]! : null;
}

export async function presets(flags: { json?: boolean; verbose?: boolean }): Promise<void> {
  await runCommand(flags, (out) => listPresets({ out }));
}

export async function connections(flags: GatewayCommandFlags & ConnectionsFlags): Promise<void> {
  await runCommand(flags, (out) => listProviderConnections({ flags, out }));
}

export async function disconnect(flags: GatewayCommandFlags & DisconnectFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => disconnectProvider({ flags, out }, id));
}

export async function list(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => listProviders({ flags, out }));
}

export async function show(flags: GatewayCommandFlags & { save?: boolean }, id: string): Promise<void> {
  await runCommand(flags, (out) => showProvider({ flags, out }, id));
}

export async function remove(flags: GatewayCommandFlags & { force?: boolean }, id: string): Promise<void> {
  await runCommand(flags, (out) => removeRegistered({ flags, out }, id));
}

/** `provider on`: `mcp on`, said first. */
export async function on(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => runMcpAlias({ flags, out }, "on", id));
}

/** `provider off`: `mcp off`, said first. */
export async function off(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => runMcpAlias({ flags, out }, "off", id));
}

/**
 * An old `provider on|off`: one dim line saying what it is now (step
 * `provider.alias`), then `mcp on|off` itself, events and all.
 */
export async function runMcpAlias(options: ProviderOptions, verb: "on" | "off", id: string): Promise<void> {
  options.out.emit({
    type: "step",
    step: "provider.alias",
    status: "ok",
    message: `everyapp provider ${verb} is now everyapp mcp ${verb}; this alias goes after launch week.`,
    data: { command: `${CLI} mcp ${verb} ${id}` },
  });
  await (verb === "on" ? turnOn : turnOff)(options, id);
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

/** Whether `dir` is an app's directory: its everyapp.config.ts is there. */
async function isAppDirectory(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "everyapp.config.ts"));
    return true;
  } catch {
    return false;
  }
}

function specRefused(message: string, fix: string): EveryAppError {
  return new EveryAppError("PROVIDER_SPEC_INVALID", message, { fix });
}

/**
 * The spec `source` names, parsed as JSON: an https URL fetched here (no
 * other scheme), or a file, relative to `cwd`; 64 KiB at most either way.
 * Nothing is checked but that it is JSON: the parser and the rules come
 * after.
 */
export async function readSpecSource(
  source: string,
  { cwd, fetcher = fetch }: { cwd: string; fetcher?: typeof fetch },
): Promise<unknown> {
  let text: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw specRefused(`${source} isn't a URL`, "give the spec's https URL, or a path to the file");
    }
    if (url.protocol !== "https:") {
      throw specRefused(`${source} isn't https`, "fetch specs over https only, or save the file and give its path");
    }
    let response: Response;
    try {
      response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "follow" });
    } catch (error) {
      throw specRefused(
        `Couldn't fetch ${source}: ${errorMessage(error).split("\n")[0]}`,
        "check the URL, or save the file and give its path",
      );
    }
    if (response.url && !response.url.startsWith("https://")) {
      throw specRefused(`${source} redirected to a URL that isn't https`, "give the spec's final https URL");
    }
    if (!response.ok) {
      throw specRefused(`${source} answered ${response.status}`, "check the URL, or save the file and give its path");
    }
    text = await readCapped(response, source);
  } else {
    const file = path.resolve(cwd, source);
    let bytes: Buffer;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_SPEC_BYTES) {
        throw specRefused(`${source} is over ${MAX_SPEC_BYTES / 1024} KiB`, "a spec is a short JSON file");
      }
      bytes = await fs.readFile(file);
    } catch (error) {
      if (error instanceof EveryAppError) throw error;
      if (isNotFoundError(error)) {
        throw specRefused(`No file at ${source}`, "give the path to the spec's JSON file, or its https URL");
      }
      throw error;
    }
    text = bytes.toString("utf8");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw specRefused(`${source} isn't JSON: ${errorMessage(error).split("\n")[0]}`, "fix the file, then add it again");
  }
}

/** A response's body as text, refused past 64 KiB however it is sent. */
async function readCapped(response: Response, source: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  const tooBig = () => specRefused(`${source} is over ${MAX_SPEC_BYTES / 1024} KiB`, "a spec is a short JSON file");
  if (Number.isFinite(declared) && declared > MAX_SPEC_BYTES) throw tooBig();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SPEC_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** "api.stripe.com", "api.stripe.com and the host STRIPE_HOST names"; an OAuth provider's API hosts. */
function keyHosts(capability: RegistrableCapability): string {
  if (capability.mode === "oauth_client") return listed([...capability.api]);
  return listed([
    ...capability.hosts,
    ...(capability.hostSetting ? [`the host ${capability.hostSetting} names`] : []),
  ]);
}

/** How the key goes on a request, in a few words. */
function sentAs(capability: RegistrableCapability): string {
  if (capability.mode === "oauth_client") {
    return "as the bearer token of the person's connection";
  }
  const { auth } = capability;
  switch (auth.kind) {
    case "bearer":
      return `as ${auth.scheme ?? "a bearer"} token`;
    case "header":
      return `in the ${auth.header} header`;
    case "query":
      return `as the ${auth.param} query parameter`;
    case "basic":
      return "as HTTP Basic";
  }
}

/** "1. Create a key at <docs>", then what to do with it: the steps a provider's key takes, numbered. */
function keySteps(docs: string, interactive: boolean): string[] {
  return [`1. Create a key at ${docs}`, interactive ? "2. Paste it below." : "2. Set it with the command below."];
}

/**
 * The key part of `provider add`, after the provider is on the Gateway:
 * the setup lines (`setup`, then the steps when a key is still needed),
 * the key set in the same run (credentials.ts), and the done: what apps
 * can do now, or the `secret set` to run next.
 */
async function finishKey(
  options: ProviderOptions & { flags: GatewayCommandFlags & CredentialFlags },
  context: {
    id: string;
    capability: Capability;
    /** The lines saying what was added, before the steps. */
    setup: string[];
    /** The settings still to set; empty when the key is set already. */
    needed: string[];
    /** The page to read, when there is one. */
    docs: string | null;
    /** "the provider is registered": completes "Nothing was set; …". */
    standing: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const { out, flags } = options;
  const { id, capability, needed } = context;
  const settings = [...capabilitySettings(capability)];
  const name = shortName(capability.label);
  const given = await givenValues(settings, `${name}'s key`, flags, options);
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const docsUrl = capability.mode === "api_key" || capability.mode === "ai" ? capability.docs : null;
  const setup = [
    ...context.setup,
    ...(needed.length > 0 && Object.keys(given).length === 0 && docsUrl ? keySteps(docsUrl, interactive) : []),
    ...(context.docs ? [`Docs: ${context.docs}`] : []),
  ];
  out.emit({ type: "step", step: "provider.setup", status: "ok", message: setup.join("\n"), data: { id, docs: context.docs } });
  const outcome = await setProviderSettings({
    flags,
    out,
    ...(options.createCf ? { createCf: options.createCf } : {}),
    whose: `${name}'s key`,
    standing: context.standing,
    settings,
    needed,
    given,
    interactive,
    ...(options.ask ? { ask: options.ask } : {}),
  });
  const keySet = outcome === "set" || needed.length === 0;
  // An AI provider goes under the manifest's providers; any other under capabilities.
  const listIt = capability.mode === "ai" ? `list ${id} under providers` : `list ${id}`;
  const result =
    outcome === "set"
      ? [`Apps can now ${listIt}. Live now, no deploy needed.`]
      : needed.length === 0
        ? [`Its key is set. Apps can ${listIt}; to replace the key: ${CLI} secret set ${settings.join(" ")}`]
        : [];
  const extra = [
    capability.mode === "ai"
      ? `In an app's manifest: providers: [${JSON.stringify(id)}]`
      : `In an app's capabilities: { ${JSON.stringify(id)}: { access: "${capability.mode === "api_key" ? capability.access[0] : "read"}", why: "..." } }`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters([...setup, ...result].join("\n")),
    display: [...result, ...(flags.verbose ? extra.map((line) => chalk.dim(line)) : [])].join("\n"),
    data: {
      ...context.data,
      settings,
      ...(context.docs ? { docs: context.docs } : {}),
      keySet,
      ...(keySet ? {} : { next: [{ command: `${CLI} secret set ${needed.join(" ")}` }] }),
    },
  });
}

/**
 * `provider add <id>` of a built-in API-key or AI provider (`openrouter`,
 * `dataforseo`): no row, only its key, which is asked for in the same run
 * when it isn't set (or given), after the page it comes from.
 */
export async function addBuiltIn(
  options: ProviderOptions & { flags: GatewayCommandFlags & CredentialFlags },
  id: string,
  capability: Capability,
): Promise<void> {
  if (capability.mode !== "api_key" && capability.mode !== "ai") {
    throw new EveryAppError(
      "PROVIDER_BUILTIN",
      `${id} is a Gateway service, not a provider with a key\nIt is set up with its own command.`,
      { fix: id === "email" ? `${CLI} email set` : `${CLI} provider show ${id}` },
    );
  }
  const gateway = await connect(options);
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  const gatewayNames = await listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME);
  const settings = [...capabilitySettings(capability)];
  options.out.emit({
    type: "step",
    step: "provider.add",
    status: "ok",
    message: `${capability.label} (${id}) is built in: no row to write, its key alone is set`,
    data: { id, builtIn: true },
  });
  await finishKey(options, {
    id,
    capability,
    setup: [`${shortName(capability.label)} (${id}) is on ${gatewayHost}.`],
    needed: settings.filter((name) => !gatewayNames.includes(name)),
    docs: providerDocsUrl(id),
    standing: "the provider is built in",
    data: {
      id,
      name: capability.label,
      kind: capability.mode,
      ...hostsOf(capability),
      source: "catalog",
    },
  });
}

/**
 * `provider add <spec>`: the spec read (a file, or an https URL fetched
 * here) and registered, then its key, set in the same run (`finishKey`):
 * a new or replaced row is unbound until its key is set, so it is always
 * asked for. In an app's directory the spec is also written to
 * `.everyapp/providers/<id>.json` for `everyapp dev`.
 */
export async function addFromSpec(
  options: ProviderOptions & { flags: GatewayCommandFlags & CredentialFlags & { replace?: boolean } },
  source: string,
): Promise<void> {
  const { out, flags } = options;
  const cwd = options.cwd ?? process.cwd();
  const spec = await readSpecSource(source, { cwd, fetcher: options.fetch });
  const parsed = parseProviderSpec(spec);
  if (parsed.ok && parsed.capability.mode === "oauth_client") {
    // An OAuth spec takes a client and a redirect URI: add --oauth's path.
    await addOAuth({ ...options, flags: { ...flags, oauth: source } }, source);
    return;
  }
  const gateway = await connect(options);
  const named =
    spec && typeof spec === "object" && typeof (spec as { id?: unknown }).id === "string"
      ? (spec as { id: string }).id
      : "the provider";
  out.emit({ type: "step", step: "provider.add", status: "start", message: `Registering ${named}...` });
  const added = await addProvider(gateway.db, {
    spec,
    deployer: gateway.deployer,
    replace: flags.replace ?? false,
    install: gateway.install,
    now: options.now?.(),
  });
  const { id, capability } = added;
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  out.emit({
    type: "step",
    step: "provider.add",
    status: "ok",
    message: `${added.replaced ? "Replaced" : "Registered"} ${capability.label} (${id}) on ${gatewayHost}`,
    data: { id, replaced: added.replaced },
  });
  // For `everyapp dev`: the SDK reaches the provider from this file with
  // the developer's own key.
  let devFile: string | null = null;
  if (await isAppDirectory(cwd)) {
    devFile = devProviderFile(id);
    await writeDevSpec(cwd, id, capability);
  }
  await finishKey(options, {
    id,
    capability,
    setup: [
      `${added.replaced ? "Replaced" : "Registered"} ${capability.label} (${id}) on ${gatewayHost}.`,
      `Its key goes to ${keyHosts(capability)} only, ${sentAs(capability)}.`,
      ...(added.replaced ? ["The key set before was for the old spec: set it again before the Gateway sends it."] : []),
      ...(devFile ? [`Wrote ${devFile} for everyapp dev (your key goes in .dev.vars).`] : []),
    ],
    needed: [...capabilitySettings(capability)],
    docs: null,
    standing: "the provider is registered",
    data: {
      id,
      name: capability.label,
      ...hostsOf(capability),
      source: "row",
      replaced: added.replaced,
      ...(devFile ? { devFile } : {}),
    },
  });
}

/** `.everyapp/providers/<id>.json` under `dir`: the spec, defaults spelled out. */
async function writeDevSpec(dir: string, id: string, capability: RegistrableCapability): Promise<string> {
  const file = path.join(dir, DEV_PROVIDERS_DIR, `${id}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(providerSpecOf(id, capability), null, 2)}\n`);
  return file;
}

/** A catalog or registered provider's kind, as `provider list` names it. */
type ProviderKind = "api key" | "ai" | "oauth client";

function kindOf(capability: Capability): ProviderKind | null {
  switch (capability.mode) {
    case "api_key":
      return "api key";
    case "ai":
      return "ai";
    case "oauth_client":
      return "oauth client";
    case "service":
      return null;
  }
}

/** The hosts a provider's key or client is sent to, and the setting naming one, when it has one. */
function hostsOf(capability: Capability): { hosts: string[]; hostSetting?: string } {
  switch (capability.mode) {
    case "api_key":
      return {
        hosts: [...capability.hosts],
        ...(capability.hostSetting ? { hostSetting: capability.hostSetting } : {}),
      };
    case "ai":
      return { hosts: [new URL(capability.origin).host] };
    case "oauth_client":
      return {
        hosts: [...new Set(capability.token.flatMap((endpoint) => (endpoint.host ? [endpoint.host] : [])))],
        ...(capability.hostSetting ? { hostSetting: capability.hostSetting } : {}),
      };
    case "service":
      return { hosts: [] };
  }
}

/** The registered apps listing `id` (under `capabilities`, or an AI provider under `providers`). */
function appsUsing(
  apps: Awaited<ReturnType<typeof listApps>>,
  id: string,
  capability: Capability,
): string[] {
  return apps
    .filter((app) => {
      if (!app.manifest) return false;
      if (capability.mode === "ai") return providerIds(app.manifest).includes(id);
      return Boolean(app.manifest.capabilities && Object.hasOwn(app.manifest.capabilities, id));
    })
    .map((app) => app.appSlug);
}

/** One provider as `provider list --json` reports it. */
interface ListedProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  hosts: string[];
  hostSetting?: string;
  settings: Array<{ name: string; set: boolean }>;
  /** Whether its settings may be read: always for a built-in one; for a registered one, once its key was set for the hosts it has now. */
  bound: boolean;
  source: "catalog" | "row";
  addedBy?: string | null;
  addedAt?: number | null;
  apps: string[];
  /** An OAuth entry's flow, redirect URI, console, scope sets, client source and connections (`oauthFacts`). */
  flow?: "app" | "both";
  redirectUri?: string;
  console?: string;
  scopeSets?: unknown[];
  client?: { source: "env" | "uploaded" | "none"; clientId?: string };
  connections?: number;
}

/** What `provider list` and `provider show` know of the OAuth side of the Gateway. */
interface OAuthContext {
  gatewayUrl: string;
  gatewayNames: readonly string[];
  uploaded: ReadonlyMap<string, UploadedClient>;
  connections: ReadonlyMap<string, number>;
}

/** Every provider the registry has but the Gateway's services, as `provider list` reports it. */
function providersOf(
  registry: ProviderRegistry,
  gatewayNames: readonly string[],
  apps: Awaited<ReturnType<typeof listApps>>,
  oauth: OAuthContext,
): ListedProvider[] {
  const rows = new Map(registry.rows().map((row) => [row.id, row]));
  const providers: ListedProvider[] = [];
  for (const [id, capability] of registry.entries()) {
    const kind = kindOf(capability);
    if (!kind) continue;
    const row = rows.get(id);
    providers.push({
      id,
      name: capability.label,
      kind,
      ...hostsOf(capability),
      settings: capabilitySettings(capability).map((name) => ({ name, set: gatewayNames.includes(name) })),
      bound: registry.bound(id),
      source: row ? "row" : "catalog",
      ...(row ? { addedBy: row.addedBy, addedAt: row.addedAt } : {}),
      apps: appsUsing(apps, id, capability),
      ...(isOAuthCapability(capability)
        ? (oauthFacts(id, capability, { source: row ? "row" : "catalog", ...oauth }) as Partial<ListedProvider>)
        : {}),
    });
  }
  return providers;
}

/**
 * `provider list`: the catalog's API-key, AI and OAuth entries and the
 * registered rows, with each setting's state (names only, as `secret
 * list` reads them), whether a row's key is bound, where each is from and
 * which apps list it. Rows the Gateway refuses are named under the table.
 */
export async function listProviders(options: ProviderOptions): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const [registry, gatewayNames, apps, uploaded, connections] = await Promise.all([
    gatewayRegistry(gateway.db, gateway.install),
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
    listApps(gateway.db),
    readUploadedClients(gateway.db),
    countConnections(gateway.db),
  ]);
  const providers = providersOf(registry, gatewayNames, apps, {
    gatewayUrl: gateway.gatewayUrl,
    gatewayNames,
    uploaded,
    connections,
  });
  const table = formatTable(
    ["ID", "NAME", "KIND", "HOSTS", "SETTINGS", "SOURCE", "APPS"],
    providers.map((provider) => [
      provider.id,
      provider.name,
      provider.kind === "oauth client" && provider.flow && provider.flow !== "app" ? "oauth" : provider.kind,
      [...provider.hosts, ...(provider.hostSetting ? [`<${provider.hostSetting}>`] : [])].join(", ") || chalk.dim("-"),
      [
        // An uploaded client counts as set: the Gateway reads it when the env lacks the setting.
        provider.client?.source === "uploaded"
          ? `client ${chalk.green("uploaded")}`
          : provider.settings
              .map((setting) => `${setting.name} ${setting.set ? chalk.green("set") : chalk.yellow("not set")}`)
              .join(", "),
        ...(provider.source === "row" && provider.client?.source !== "uploaded"
          ? [provider.bound ? chalk.green("bound") : chalk.yellow("not bound")]
          : []),
        ...(provider.connections !== undefined ? [`${provider.connections} connected`] : []),
      ].join(", "),
      provider.source === "row" ? `registered by ${provider.addedBy ?? "someone"}` : chalk.dim("catalog"),
      provider.apps.join(", ") || chalk.dim("-"),
    ]),
  );
  const registered = providers.filter((provider) => provider.source === "row").length;
  const rejected = registry.rejected.map(({ id, code, message }) => ({ id, code, message }));
  out.emit({
    type: "done",
    message: `${providers.length} providers: ${providers.length - registered} built in, ${registered} registered`,
    display: [
      ...table,
      ...(rejected.length > 0
        ? [
            "",
            chalk.yellow(`The Gateway doesn't serve ${listed(rejected.map((row) => row.id))}:`),
            ...rejected.map((row) => chalk.dim(`  ${row.id}: ${row.message} (${row.code})`)),
          ]
        : []),
      "",
      chalk.dim(`MCP apps: ${CLI} mcp list`),
    ].join("\n"),
    data: {
      providers,
      ...(rejected.length > 0 ? { rejected } : {}),
      mcp: `${CLI} mcp list`,
    },
  });
}

/**
 * The spec of `id` as `provider show` prints it: an API-key entry's whole
 * spec (`providerSpecOf`, what `provider add` takes), or for an AI
 * provider or an OAuth client, what a person needs to set it up.
 */
function specOf(id: string, capability: Capability): Record<string, unknown> {
  const settings = [...capabilitySettings(capability)];
  switch (capability.mode) {
    case "api_key":
      return providerSpecOf(id, capability);
    case "ai":
      return {
        id,
        kind: "ai",
        name: capability.label,
        ...(capability.description ? { description: capability.description } : {}),
        docs: capability.docs,
        ...(capability.api ? { api: capability.api } : {}),
        ...(capability.hint ? { hint: capability.hint } : {}),
        settings,
        hosts: [new URL(capability.origin).host],
        routes: [...capability.inferenceRoutes],
        ...(capability.setup ? { setup: capability.setup } : {}),
      };
    case "oauth_client":
      // A registered OAuth provider's whole spec (what `provider add --oauth` took); a built-in client's setup facts.
      if (capability.flow && !capability.setup) return providerSpecOf(id, capability);
      return {
        id,
        kind: "oauth client",
        name: capability.label,
        docs: capability.console,
        settings,
        tokenEndpoints: describeTokenEndpoints(capability).split(", "),
        authorize: { url: capability.authorize.url, scopes: [...capability.authorize.scopes] },
        redirectPaths: [...capability.redirectPaths],
        ...(capability.scopePolicy ? { scopeSets: Object.keys(capability.scopePolicy.sets) } : {}),
        ...(capability.hostSetting ? { hostSetting: capability.hostSetting } : {}),
        ...(capability.setup ? { setup: capability.setup } : {}),
      };
    case "service":
      return { id, name: capability.label };
  }
}

/**
 * `provider show <id>`: the spec, where it is from, whether its key is
 * bound, who registered it and which apps list it. With `--save`, in an
 * app's directory, a registered provider's spec is written to
 * `.everyapp/providers/<id>.json` for `everyapp dev`.
 */
export async function showProvider(
  options: ProviderOptions & { flags: { save?: boolean } },
  id: string,
): Promise<void> {
  const { out, flags } = options;
  const cwd = options.cwd ?? process.cwd();
  if (flags.save && !(await isAppDirectory(cwd))) {
    throw new EveryAppError(
      "MANIFEST_NOT_FOUND",
      "No everyapp.config.ts in this directory\n--save writes the spec where everyapp dev reads it, in an app's directory. Nothing was written.",
      { fix: "run this from the app's directory" },
    );
  }
  const gateway = await connect(options);
  const [registry, apps, gatewayNames, uploaded, connections] = await Promise.all([
    gatewayRegistry(gateway.db, gateway.install),
    listApps(gateway.db),
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
    readUploadedClients(gateway.db),
    countConnections(gateway.db),
  ]);
  const capability = registry.get(id);
  if (!capability || capability.mode === "service") {
    const rejected = registry.rejected.find((row) => row.id === id);
    throw new EveryAppError(
      "PROVIDER_NOT_FOUND",
      capability
        ? `${id} is a Gateway service, not a provider\nApps call it with its own helper (sendEmail(), listMembers()).`
        : rejected
          ? `The Gateway doesn't serve ${id}: ${rejected.message}`
          : `${id} isn't a provider this Gateway offers`,
      { rerun: `${CLI} provider list`, rerunNote: "names every one" },
    );
  }
  const row = registry.rows().find((each) => each.id === id);
  const spec = specOf(id, capability);
  let saved: string | null = null;
  if (flags.save) {
    if (!row || capability.mode !== "api_key") {
      throw new EveryAppError(
        "PROVIDER_BUILTIN",
        `${id} is built in\neveryapp dev reaches it without a file. Nothing was written.`,
        { fix: `put its key in .dev.vars: ${capabilitySettings(capability).join(", ")}` },
      );
    }
    await writeDevSpec(cwd, id, capability);
    saved = devProviderFile(id);
  }
  const using = appsUsing(apps, id, capability);
  const bound = registry.bound(id);
  const oauth = isOAuthCapability(capability)
    ? oauthFacts(id, capability, {
        source: row ? "row" : "catalog",
        gatewayUrl: gateway.gatewayUrl,
        gatewayNames,
        uploaded,
        connections,
      })
    : null;
  const client = oauth?.["client"] as { source: "env" | "uploaded" | "none"; clientId?: string } | undefined;
  const facts = [
    row
      ? `Registered by ${row.addedBy ?? "someone"}${row.addedAt ? ` on ${new Date(row.addedAt).toISOString().slice(0, 10)}` : ""}; ${
          oauth
            ? client?.source === "uploaded"
              ? "its client was uploaded under Admin → Providers"
              : bound
                ? "its client is bound to these endpoints"
                : "its client isn't set for these endpoints yet"
            : bound
              ? "its key is bound to these hosts"
              : "its key isn't set for these hosts yet"
        }.`
      : oauth
        ? `Built in; its client is ${client?.source === "env" ? "set" : client?.source === "uploaded" ? "uploaded under Admin → Providers" : "not set"}.`
        : "Built in.",
    ...(oauth
      ? [
          `Redirect URI to register at ${String(oauth["console"])}: ${String(oauth["redirectUri"])}`,
          `${String(oauth["connections"])} connected; people connect at ${gateway.gatewayUrl}/connect/${id}.`,
        ]
      : []),
    using.length > 0 ? `Used by ${listed(using)}.` : "No app lists it yet.",
    ...(saved ? [`Wrote ${saved} for everyapp dev.`] : []),
  ];
  out.emit({
    type: "done",
    message: `${capability.label} (${id})`,
    display: [JSON.stringify(spec, null, 2), "", ...facts.map((line) => chalk.dim(line))].join("\n"),
    data: {
      provider: spec,
      source: row ? "row" : "catalog",
      bound,
      ...(oauth ?? {}),
      addedBy: row?.addedBy ?? null,
      addedAt: row?.addedAt ?? null,
      apps: using,
      ...(saved ? { saved } : {}),
      ...(row && !bound && client?.source !== "uploaded"
        ? {
            next: [
              {
                command: `${CLI} secret set ${capabilitySettings(capability).join(" ")}`,
                note: `${capability.label}'s key; the Gateway sends it only to ${listed(hostsOf(capability).hosts)}`,
              },
            ],
          }
        : {}),
    },
  });
}

/**
 * `provider remove <id>`: the row deleted (refused for a built-in id, an
 * id with no row, and one a deployed app lists unless --force). The
 * Gateway setting holding its key stays: the done event says which, and
 * the command that removes each.
 */
export async function removeRegistered(
  options: ProviderOptions & { flags: { force?: boolean } },
  id: string,
): Promise<void> {
  const { out, flags } = options;
  const gateway = await connect(options);
  out.emit({ type: "step", step: "provider.remove", status: "start", message: `Removing ${id}...` });
  const removed = await removeProvider(gateway.db, id, gateway.deployer, {
    force: flags.force ?? false,
    now: options.now?.(),
  });
  const gatewayNames = await listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME);
  const settings = removed.settings.map((name) => ({ name, set: gatewayNames.includes(name) }));
  const stays = settings.filter((setting) => setting.set).map((setting) => setting.name);
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  out.emit({
    type: "step",
    step: "provider.remove",
    status: "ok",
    message: `Removed ${removed.name} (${id}) from ${gatewayHost}`,
    data: { id },
  });
  const lines = [
    `Removed ${removed.name} (${id}) from ${gatewayHost}.`,
    "The Gateway stops serving it within 30 seconds.",
    ...(removed.connections > 0
      ? [`${removed.connections} connection${removed.connections === 1 ? "" : "s"} to it ${removed.connections === 1 ? "was" : "were"} deleted (the grants stay at the provider until revoked there).`]
      : []),
    ...(removed.client ? ["The client uploaded under Admin → Providers was deleted with it."] : []),
    ...(removed.apps.length > 0
      ? [`${listed(removed.apps)} ${removed.apps.length === 1 ? "lists" : "list"} it: ${removed.apps.length === 1 ? "its" : "their"} calls to it fail until it is registered again.`]
      : []),
    ...(stays.length > 0
      ? [
          `${listed(stays)} ${stays.length === 1 ? "stays" : "stay"} on the Gateway, read by nothing: ${CLI} secret unset ${stays.join(" ")} removes ${stays.length === 1 ? "it" : "them"}.`,
        ]
      : []),
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: {
      id,
      name: removed.name,
      removed: true,
      settings,
      apps: removed.apps,
      connections: removed.connections,
      client: removed.client,
      ...(stays.length > 0
        ? { next: [{ command: `${CLI} secret unset ${stays.join(" ")}`, note: "the key nothing reads any more" }] }
        : {}),
    },
  });
}
