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
import {
  CAPABILITIES,
  capabilitySettings,
  DEV_PROVIDERS_DIR,
  devProviderFile,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerIds,
  providerSpecOf,
  type Capability,
  type ProviderRegistry,
  type RegistrableCapability,
  type SmokeRequest,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { closestTo } from "@/lib/closeTo";
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
import { plainText, providerDocsUrl, providerKeyGuide, providerKeySteps } from "@/lib/providerDocs";
import { CLI } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmAtTerminal, type Confirm } from "@/lib/output/prompt";
import { factLines, finish } from "@/lib/output/result";
import { runCommand } from "@/lib/output/run";
import { formatSteps, type Step } from "@/lib/output/steps";
import { formatFacts, formatTable, type Fact } from "@/lib/output/table";
import { listed } from "@/lib/output/text";
import { proseWidth, wrap } from "@/lib/output/wrap";
import { askSettingValue } from "@/lib/secretValue";
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
  type ScopeRulesSummary,
} from "./oauth";
import {
  givenValues,
  setProviderSettings,
  setupShown,
  shortName,
  type CredentialFlags,
  type CredentialSeams,
} from "./credentials";

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
  /** The yes/no asked before a set key is replaced (tests). */
  confirm?: Confirm;
}

export async function add(flags: GatewayCommandFlags & OAuthAddFlags, spec?: string): Promise<void> {
  await runCommand(flags, (out) => addAny({ flags, out }, spec));
}

/**
 * `provider add`, by what it was given: `--oauth <value>` or an OAuth
 * preset's id (addOAuth); a built-in API-key or AI provider's id
 * (addBuiltIn); a spec file or URL (addFromSpec).
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
    throw new EveryAppError("PROVIDER_SPEC_INVALID", "Give the provider to add\nA built-in provider's id (provider list --all), an OAuth preset's (provider presets), or a JSON spec file or https URL.", {
      rerun: `${CLI} provider list`,
      rerunNote: "names the built-in providers",
    });
  }
  if (Object.hasOwn(OAUTH_PRESETS, spec)) {
    await addOAuth(options, spec);
    return;
  }
  const builtIn = builtInOf(spec);
  if (builtIn) {
    await addBuiltIn(options, spec, builtIn);
    return;
  }
  if (!/[./\\:]/.test(spec)) {
    const meant = closestTo(spec, addableIds());
    throw new EveryAppError(
      "PROVIDER_NOT_FOUND",
      `${spec} isn't a provider's id`,
      meant ? { data: { didYouMean: meant } } : { fix: `use an id from ${CLI} provider list --all or ${CLI} provider presets` },
    );
  }
  await addFromSpec(options, spec);
}

/** Every id `provider add` takes: the catalog's API-key and AI providers, then the OAuth presets. */
function addableIds(): string[] {
  return [
    ...Object.entries(CAPABILITIES as Record<string, Capability>)
      .filter(([, capability]) => capability.mode === "api_key" || capability.mode === "ai")
      .map(([id]) => id),
    ...Object.keys(OAUTH_PRESETS),
  ];
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

export async function update(flags: GatewayCommandFlags & { "from-env"?: boolean }, id: string): Promise<void> {
  await runCommand(flags, (out) => updateProvider({ flags, out }, id));
}

export async function list(flags: GatewayCommandFlags & { all?: boolean }): Promise<void> {
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
  if (capability.mode === "ai") return `${capability.origin}${capability.basePath ?? ""}`;
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

/**
 * The steps a provider's key takes: its page's own (lib/providerDocs.ts),
 * or "Create a key at <docs>" for one whose page has none, then what to do
 * with it. `plain` is numbered, for a script; `shown` is for a person's
 * screen.
 */
function keySteps(id: string, docs: string, interactive: boolean): { plain: string[]; shown: Step[] } {
  const last = interactive ? "Paste it below." : "Set it with the command below.";
  const guide = providerKeySteps(id);
  return {
    plain: guide ? [...guide, `${guide.length + 1}. ${last}`] : [`1. Create a key at ${docs}`, `2. ${last}`],
    shown: [...(providerKeyGuide(id) ?? [{ text: `Create a key at ${chalk.cyan(docs)}` }]), { text: last }],
  };
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
    /** What is on the Gateway now: "Registered Northwind (northwind) on example.com". */
    added: string;
    /** What else to know of it, before the steps. */
    notes?: string[];
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
  // The steps, when the key is still to come and nothing gave it.
  const steps = needed.length > 0 && Object.keys(given).length === 0 && docsUrl ? keySteps(id, docsUrl, interactive) : null;
  const notes = context.notes ?? [];
  const setup = [
    `${context.added}.`,
    ...notes,
    ...(steps?.plain ?? []),
    ...(context.docs ? [`Docs: ${context.docs}`] : []),
  ];
  out.emit({
    type: "step",
    step: "provider.setup",
    status: "ok",
    message: setup.join("\n"),
    display: setupShown({
      added: context.added,
      notes,
      steps: steps ? formatSteps(steps.shown, proseWidth()) : [],
      docs: context.docs,
    }),
    data: { id, docs: context.docs },
  });
  const outcome = await setProviderSettings({
    flags,
    out,
    ...(options.createCf ? { createCf: options.createCf } : {}),
    whose: `${name}'s key`,
    standing: context.standing,
    // The notes say where a registered provider's key goes; a built-in one has no row to say it of.
    whereKeysGoSaid: true,
    settings,
    needed,
    given,
    interactive,
    ...(options.ask ? { ask: options.ask } : {}),
  });
  const keySet = outcome === "set" || needed.length === 0;
  // An AI provider goes under the manifest's providers; any other under capabilities.
  const listIt = capability.mode === "ai" ? `list ${id} under providers` : `list ${id}`;
  // The key is set already and nothing was given: a person is asked whether to replace it; nobody is told how.
  let replaced: string[] = [];
  if (outcome === "skipped" && needed.length === 0 && interactive) {
    const confirm = options.confirm ?? confirmAtTerminal;
    if (await confirm("Replace its key?", [`${name}'s key is set.`])) {
      replaced = await replaceSettings(options, { settings, set: settings, whose: `${name}'s key`, interactive });
    }
  }
  const result =
    outcome === "set"
      ? [`Apps can now ${listIt}. Live now, no deploy needed.`]
      : replaced.length > 0
        ? [`Replaced ${name}'s key. Live now, no deploy needed.`]
        : needed.length === 0
          ? [`Its key is set. Apps can ${listIt}.`, `${chalk.dim("Replace it:")}  ${CLI} provider update ${id}`]
          : [];
  const extra = [
    capability.mode === "ai"
      ? `In an app's manifest: providers: [${JSON.stringify(id)}]`
      : capability.mode === "oauth_client"
        ? `In an app's capabilities: { ${JSON.stringify(id)}: { scopes: [<${capability.label}'s own scopes>], why: "..." } }`
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
      ...(replaced.length > 0 ? { replaced } : {}),
      ...(keySet ? {} : { next: [{ command: `${CLI} secret set ${needed.join(" ")}` }] }),
    },
  });
}

/**
 * Replace a provider's settings: the values given without a prompt (piped
 * `NAME=value` lines, `--from-env`), or each setting asked for at the
 * terminal, where Enter on one that is set keeps it. Only what was given or
 * typed is set, through `secret set`'s own path; the names set come back,
 * none when nothing was.
 */
async function replaceSettings(
  options: ProviderOptions & { flags: GatewayCommandFlags & CredentialFlags },
  context: { settings: readonly string[]; set: readonly string[]; whose: string; interactive: boolean },
): Promise<string[]> {
  const { settings, whose } = context;
  let values = await givenValues(settings, whose, options.flags, options);
  if (Object.keys(values).length === 0 && context.interactive) {
    const ask = options.ask ?? ((name: string, question: string) => askSettingValue(name, { question, optional: true }));
    values = {};
    for (const name of settings) {
      const value = (await ask(name, context.set.includes(name) ? `${name} (Enter keeps it)` : name)).trim();
      if (value) values[name] = value;
    }
  }
  const names = settings.filter((name) => name in values);
  if (names.length === 0) return [];
  await setProviderSettings({
    flags: options.flags,
    out: options.out,
    ...(options.createCf ? { createCf: options.createCf } : {}),
    whose,
    standing: "the provider is as it was",
    settings,
    needed: [],
    given: values,
    interactive: false,
  });
  return names;
}

/**
 * `provider update <id>`: replace the key (or OAuth client) of a provider
 * the Gateway offers, by the provider's id and not its settings' names. The
 * new value is asked for at a hidden prompt, piped or read with --from-env;
 * the old one can't be read back or checked. Live at once.
 */
export async function updateProvider(
  options: ProviderOptions & { flags: GatewayCommandFlags & CredentialFlags },
  id: string,
): Promise<void> {
  const { out, flags } = options;
  const gateway = await connect(options);
  const [registry, apps, gatewayNames] = await Promise.all([
    gatewayRegistry(gateway.db, gateway.install),
    listApps(gateway.db),
    listWorkerSecrets(gateway.cf, gateway.names.worker),
  ]);
  const capability = registry.get(id);
  if (!capability || capability.mode === "service") {
    throw new EveryAppError(
      "PROVIDER_NOT_FOUND",
      capability ? `${id} is a Gateway service, not a provider with a key` : `${id} isn't a provider this Gateway offers`,
      { rerun: `${CLI} provider list`, rerunNote: "names the ones in use; --all names every one" },
    );
  }
  const oauth = capability.mode === "oauth_client";
  const name = shortName(capability.label);
  const whose = `${name}'s ${oauth ? "client" : "key"}`;
  const settings = [...capabilitySettings(capability)];
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const using = appsUsing(apps, id, capability);
  const set = await replaceSettings(options, {
    settings,
    set: settings.filter((setting) => gatewayNames.includes(setting)),
    whose,
    interactive,
  });
  if (set.length === 0) {
    finish(out, {
      headline: `${whose} on ${gatewayHost} is as it was`,
      ticked: false,
      blocks: interactive ? [] : [[`Nothing was given. Export ${listed(settings)}, or pipe ${settings.length === 1 ? "it" : "them"} as NAME=value lines.`]],
      data: {
        id,
        settings,
        set: [],
        apps: using,
        ...(interactive ? {} : { next: [{ command: `${CLI} provider update ${id} --from-env` }] }),
      },
    });
    return;
  }
  finish(out, {
    headline: `Set ${whose} on ${gatewayHost}`,
    blocks: [
      [
        "Live now, no deploy needed.",
        using.length > 0 ? `Used by ${listed(using)}.` : `No app lists ${id} yet.`,
        ...(oauth ? ["If this is a different client, each person connects again."] : []),
      ],
    ],
    data: { id, settings, set, apps: using },
  });
}

/**
 * `provider add <id>` of a built-in API-key or AI provider (`openrouter`,
 * `dataforseo`): no row, only its key, which is asked for in the same run
 * when it isn't set (or given), after the steps to get it.
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
  const gatewayNames = await listWorkerSecrets(gateway.cf, gateway.names.worker);
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
    added: `${shortName(capability.label)} (${id}) is on ${gatewayHost}`,
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
    added: `${added.replaced ? "Replaced" : "Registered"} ${capability.label} (${id}) on ${gatewayHost}`,
    notes: [
      `Its key goes to ${keyHosts(capability)} only, ${sentAs(capability)}.`,
      ...(added.replaced ? ["The key set before was for the old spec: set it again before the Gateway sends it."] : []),
      ...(devFile ? [`Wrote ${devFile} for everyapp dev (your key goes in .dev.vars).`] : []),
      ...(capability.mode === "ai"
        ? [
            `Apps list it under providers: [{ id: ${JSON.stringify(id)}, why: "..." }] and call /api/ai/${id}/<route> with an OpenAI client; ${CLI} ai default ${id} makes it the default model provider.`,
          ]
        : []),
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
      // Where the client goes (the token endpoint) and where people's tokens go (the API hosts).
      return {
        hosts: [...new Set([new URL(capability.flow.tokenUrl).host, ...capability.api])],
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
  /** An OAuth entry's redirect URI, console, API hosts, scope rules, client source and connections (`oauthFacts`). */
  redirectUri?: string;
  console?: string;
  apiHosts?: string[];
  scopes?: unknown;
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
      ...(isOAuthCapability(capability) ? (oauthFacts(id, capability, oauth) as Partial<ListedProvider>) : {}),
    });
  }
  return providers;
}

/**
 * `provider list`: the providers this Gateway uses (a key or client set, a
 * registered row, or an app listing it), the ones an app is waiting on
 * first, each with its key's state and the apps listing it; the rest of the
 * catalog under them with --all or --verbose. `--json` carries every
 * provider either way, each with `inUse`. Rows the Gateway refuses are named
 * under the table.
 */
export async function listProviders(
  options: ProviderOptions & { flags: GatewayCommandFlags & { all?: boolean }; columns?: number },
): Promise<void> {
  const { out, flags } = options;
  const gateway = await connect(options);
  const [registry, gatewayNames, apps, uploaded, connections] = await Promise.all([
    gatewayRegistry(gateway.db, gateway.install),
    listWorkerSecrets(gateway.cf, gateway.names.worker),
    listApps(gateway.db),
    readUploadedClients(gateway.db),
    countConnections(gateway.db),
  ]);
  const providers = withInUse(
    providersOf(registry, gatewayNames, apps, {
      gatewayUrl: gateway.gatewayUrl,
      gatewayNames,
      uploaded,
      connections,
    }),
  );
  const gatewayHost = gateway.gatewayUrl.replace(/^https:\/\//, "");
  const columns = options.columns ?? process.stdout.columns ?? 80;
  const waiting = (provider: ListedProvider) => provider.apps.length > 0 && missingOf(provider).length > 0;
  // The ones an app is waiting on first; the rest as the registry orders them.
  const used = providers.filter((provider) => provider.inUse);
  const shown = [...used.filter(waiting), ...used.filter((provider) => !waiting(provider))];
  const rest = providers.filter((provider) => !provider.inUse);
  const everything = flags.all === true || flags.verbose === true;
  const cells = shown.map((provider) => [provider.id, keyCell(provider)] as const);
  const before = (index: 0 | 1, title: string) =>
    Math.max(title.length, ...cells.map((row) => stripVTControlCharacters(row[index]).length));
  const appsWidth = columns - before(0, "PROVIDER") - before(1, "KEY") - 4;
  const table =
    shown.length > 0
      ? formatTable(
          ["PROVIDER", "KEY", "APPS"],
          shown.map((provider, index) => [...cells[index]!, appsCell(provider.apps, appsWidth)]),
        )
      : [];
  const catalog =
    everything && rest.length > 0
      ? [
          `Not set up (${rest.length}):`,
          ...formatTable(
            ["PROVIDER", "NAME", "KIND"],
            rest.map((provider) => [provider.id, provider.name, provider.kind === "oauth client" ? "oauth" : provider.kind]),
          ),
        ]
      : [];
  const rejected = registry.rejected.map(({ id, code, message }) => ({ id, code, message }));
  const needKeys = shown.filter((provider) => missingOf(provider).length > 0);
  const next = [
    ...shown.filter(waiting).map((provider) => ({
      command: `${CLI} secret set ${missingOf(provider).join(" ")}`,
      note: `${listed(provider.apps)} ${provider.apps.length === 1 ? "is" : "are"} waiting on it`,
    })),
    ...(shown.length === 0 ? [{ command: `${CLI} provider add openrouter`, note: "set a key apps can use" }] : []),
    ...(everything
      ? rest.length > 0
        ? [{ command: `${CLI} provider add <id>`, note: "set one up" }]
        : []
      : rest.length > 0
        ? [{ command: `${CLI} provider list --all`, note: shown.length > 0 ? `${rest.length} more you can add` : `the ${rest.length} you can add` }]
        : []),
  ];
  const registered = providers.filter((provider) => provider.source === "row").length;
  const headline =
    shown.length === 0
      ? `No providers in use on ${gatewayHost} yet`
      : `${shown.length} ${shown.length === 1 ? "provider" : "providers"} in use on ${gatewayHost}${
          needKeys.length > 0 ? `, ${needKeys.length} ${needKeys.length === 1 ? "needs" : "need"} a key` : ""
        }`;
  finish(out, {
    headline,
    blocks: [
      table,
      catalog,
      rejected.length > 0
        ? [
            chalk.yellow(`The Gateway doesn't serve ${listed(rejected.map((row) => row.id))}:`),
            ...rejected.map((row) => chalk.dim(`  ${row.id}: ${row.message} (${row.code})`)),
          ]
        : [],
    ],
    message: [
      `${headline}; ${providers.length} in all: ${providers.length - registered} built in, ${registered} registered`,
    ],
    data: {
      providers,
      ...(rejected.length > 0 ? { rejected } : {}),
      mcp: `${CLI} mcp list`,
      ...(next.length > 0 ? { next } : {}),
    },
  });
}

/**
 * Each provider with whether this Gateway uses it: a registered row, one an
 * app lists, an uploaded client, every setting set, or a set setting only it
 * reads (CLOUDFLARE_ACCOUNT_ID, set for Workers AI, doesn't make AI Gateway
 * one).
 */
function withInUse(providers: ListedProvider[]): Array<ListedProvider & { inUse: boolean }> {
  const readers = new Map<string, number>();
  for (const provider of providers) {
    for (const setting of provider.settings) readers.set(setting.name, (readers.get(setting.name) ?? 0) + 1);
  }
  return providers.map((provider) => ({
    ...provider,
    inUse:
      provider.source === "row" ||
      provider.apps.length > 0 ||
      provider.client?.source === "uploaded" ||
      (provider.settings.length > 0 && provider.settings.every((setting) => setting.set)) ||
      provider.settings.some((setting) => setting.set && readers.get(setting.name) === 1),
  }));
}

/** The settings a provider still needs; none once a client was uploaded (the Gateway reads it when the env lacks them). */
function missingOf(provider: ListedProvider): string[] {
  if (provider.client?.source === "uploaded") return [];
  return provider.settings.filter((setting) => !setting.set).map((setting) => setting.name);
}

/** A provider's key at a glance: "set", "needs STRIPE_API_KEY", "needs A (+1 more)", "client uploaded, 2 connected", "set, not bound". */
function keyCell(provider: ListedProvider): string {
  const missing = missingOf(provider);
  const oauth = provider.kind === "oauth client";
  const state =
    missing.length > 0
      ? chalk.yellow(`needs ${missing[0]}${missing.length > 1 ? ` (+${missing.length - 1} more)` : ""}`)
      : provider.client?.source === "uploaded"
        ? `client ${chalk.green("uploaded")}`
        : oauth
          ? `client ${chalk.green("set")}`
          : chalk.green("set");
  return [
    state,
    ...(missing.length === 0 && provider.source === "row" && provider.client?.source !== "uploaded" && !provider.bound
      ? [chalk.yellow("not bound")]
      : []),
    ...(provider.connections !== undefined ? [`${provider.connections} connected`] : []),
  ].join(", ");
}

/** The apps listing a provider, as many as fit `width` columns and how many more: "openmail, openseo (+3 more)". */
function appsCell(apps: readonly string[], width: number): string {
  if (apps.length === 0) return chalk.dim("-");
  const whole = apps.join(", ");
  if (whole.length <= width) return whole;
  for (let kept = apps.length - 1; kept >= 1; kept--) {
    const cut = `${apps.slice(0, kept).join(", ")} (+${apps.length - kept} more)`;
    if (cut.length <= width) return cut;
  }
  return apps.length === 1 ? whole : `${apps[0]} (+${apps.length - 1} more)`;
}

/** Each setting and whether it is set: "STRIPE_API_KEY set", "A not set, B not set". */
function settingsShown(settings: ReadonlyArray<{ name: string; set: boolean }>): string {
  return settings
    .map((setting) => `${setting.name} ${setting.set ? chalk.green("set") : chalk.yellow("not set")}`)
    .join(", ");
}

/**
 * The spec of `id` as `provider show --json` carries it: an API-key entry's whole
 * spec or an OAuth row's (`providerSpecOf`, what `provider add` takes),
 * or for a built-in AI provider, what a person needs to set it up.
 */
function specOf(id: string, capability: Capability): Record<string, unknown> {
  const settings = [...capabilitySettings(capability)];
  switch (capability.mode) {
    case "api_key":
      return providerSpecOf(id, capability);
    case "ai":
      // A registered row's whole spec (what `provider add` took); a catalog entry's setup facts.
      if (capability.models && !capability.setup) return providerSpecOf(id, capability);
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
      // A registered OAuth provider's whole spec (what `provider add --oauth` took).
      return providerSpecOf(id, capability);
    case "service":
      return { id, name: capability.label };
  }
}

/** A provider's kind, as `provider show` says it. */
function kindShown(capability: RegistrableCapability): string {
  switch (capability.mode) {
    case "api_key":
      return "API key";
    case "ai":
      return "AI provider";
    case "oauth_client":
      return `OAuth client  ${chalk.dim("each person connects their own account once, and allows each app")}`;
  }
}

/** The request that proves a key works, what it answers and what to know of it: "GET https://api.stripe.com/v1/balance  answers 200; free. A restricted key needs Balance read for this one." */
function smokeShown(smoke: SmokeRequest, firstHost: string): string {
  return `${smoke.method} https://${smoke.host ?? firstHost}${smoke.path}  ${chalk.dim(
    `answers ${smoke.expect.join(" or ")}; ${smoke.free ? "free" : "charged"}${smoke.note ? `. ${smoke.note}` : ""}`,
  )}`;
}

/**
 * `provider show <id>`: what it is, whether its key or client is set, where
 * it is from, where the key comes from and goes, and which apps list it;
 * `--json` carries its whole spec. With `--save`, in an app's directory, a
 * registered provider's spec is written to `.everyapp/providers/<id>.json`
 * for `everyapp dev`.
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
    listWorkerSecrets(gateway.cf, gateway.names.worker),
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
      { rerun: `${CLI} provider list`, rerunNote: "names the ones in use; --all names every one" },
    );
  }
  const row = registry.rows().find((each) => each.id === id);
  const spec = specOf(id, capability);
  let saved: string | null = null;
  if (flags.save) {
    if (!row) {
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
        gatewayUrl: gateway.gatewayUrl,
        gatewayNames,
        uploaded,
        connections,
      })
    : null;
  const client = oauth?.["client"] as { source: "env" | "uploaded" | "none"; clientId?: string } | undefined;
  const settings = capabilitySettings(capability).map((name) => ({ name, set: gatewayNames.includes(name) }));
  // Set, but for the hosts of an earlier spec: the Gateway doesn't send it until it is set again.
  const stale = row && !bound && settings.every((setting) => setting.set);
  const { hosts, hostSetting } = hostsOf(capability);
  const scopes = oauth?.["scopes"] as ScopeRulesSummary | undefined;
  const connected = Number(oauth?.["connections"] ?? 0);
  const width = proseWidth();
  const facts: Fact[] = [
    { label: "Kind", value: kindShown(capability) },
    {
      label: oauth ? "Client" : "Key",
      value:
        client?.source === "uploaded"
          ? `${chalk.green("uploaded")} under Admin → Providers`
          : `${settingsShown(settings)}${stale ? chalk.yellow(" but not for these hosts") : ""}`,
    },
    {
      label: "Source",
      value: row
        ? `registered by ${row.addedBy ?? "someone"}${row.addedAt ? ` on ${new Date(row.addedAt).toISOString().slice(0, 10)}` : ""}`
        : "built in",
    },
    ...(capability.hint ? [{ label: "Setup", value: plainText(capability.hint) }] : []),
    capability.mode === "oauth_client"
      ? { label: "Console", value: chalk.cyan(capability.console) }
      : { label: "Get it at", value: chalk.cyan(capability.docs) },
    ...(oauth ? [{ label: "Redirect URI", value: chalk.cyan(String(oauth["redirectUri"])) }] : []),
    { label: "Hosts", value: [...hosts, ...(hostSetting ? [`the host ${hostSetting} names`] : [])].join(", ") },
    ...(capability.mode === "oauth_client" ? [] : [{ label: "Sent", value: sentAs(capability) }]),
    ...(capability.mode === "api_key" ? [{ label: "Access", value: capability.access.join(", ") }] : []),
    ...(capability.mode !== "oauth_client" && capability.smoke
      ? [{ label: "Check", value: smokeShown(capability.smoke, hosts[0] ?? `<${hostSetting}>`) }]
      : []),
    ...(scopes
      ? [
          { label: "Scopes", value: "Apps list their scopes in everyapp.config.ts." },
          ...(scopes.reference ? [{ label: "Scope list", value: chalk.cyan(scopes.reference) }] : []),
          {
            label: "Connections",
            value:
              connected > 0
                ? `${connected} ${chalk.dim(`(${CLI} provider connections --provider ${id})`)}`
                : chalk.dim("none yet"),
          },
        ]
      : []),
    { label: "Apps", value: using.length > 0 ? using.join(", ") : chalk.dim("none list it yet") },
    ...(!row || Object.hasOwn(OAUTH_PRESETS, id) ? [{ label: "Docs", value: chalk.cyan(providerDocsUrl(id)) }] : []),
  ];
  out.emit({
    type: "done",
    message: `${capability.label} (${id})`,
    display: [
      chalk.bold(`${capability.label} (${id})`),
      ...(capability.description ? wrap(capability.description, width).map((line) => chalk.dim(line)) : []),
      "",
      ...formatFacts(facts, width),
      "",
      ...(saved ? [ticked(`Wrote ${saved} for everyapp dev`)] : []),
      chalk.dim(`Its whole spec: ${CLI} provider show ${id} --json`),
    ].join("\n"),
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
  const gatewayNames = await listWorkerSecrets(gateway.cf, gateway.names.worker);
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
  finish(out, {
    headline: `Removed ${removed.name} (${id}) from ${gatewayHost}`,
    blocks: [
      factLines([
        ...(removed.apps.length > 0
          ? [{ label: "Used by", value: `${removed.apps.join(", ")} ${chalk.dim(`· ${removed.apps.length === 1 ? "its" : "their"} calls to it now fail`)}` }]
          : []),
        ...(stays.length > 0 ? [{ label: "Left behind", value: stays.join(", ") }] : []),
      ]),
    ],
    message: lines,
    detail: lines.slice(1),
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
