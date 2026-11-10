/**
 * `everyapp mcp add|remove|on|off|list|show|refresh|tool` (alias
 * `provider`): MCP apps, provider apps in the code (tier `provider`), the
 * tools of a data provider (DataForSEO, built in) or of any remote MCP
 * server added by URL, offered to members' AI clients through the
 * Gateway's /mcp as apps of the Gateway's own, with no page and nothing to
 * deploy (docs/design/2026-10-mcp-by-url.md). Every change is written to
 * the Gateway's registry under the Cloudflare login
 * (lib/gateway/remoteMcpApps.ts, lib/gateway/providerApps.ts); `list` and
 * `show` read it and, like `secret list`, which Gateway settings are set,
 * so each app's key shows as set or not. The Gateway reads a change
 * within 30 seconds.
 *
 * A remote server's credential is a provider (docs/design/2026-11-mcp-
 * apps-auth.md): none, a provider of the registry (`--provider`), or the
 * app's own row `<id>-mcp` that `add` writes beside the app: an API-key
 * row for a static credential (`--auth bearer|header|query|basic`, the
 * value `<APPID>_MCP_TOKEN`), or an `oauth2-user` row discovered from the
 * server (`--auth oauth`, or chosen when the server's 401 names its
 * resource metadata), its client registered with the server (RFC 7591) or
 * given (`--client-id`). Values go through `secret set`'s own path, which
 * binds the row to its hosts; each member then connects their own account
 * at the Gateway's `/connect/<id>-mcp`.
 *
 * `on` serves, `off` stops serving and keeps everyone's access, the tokens
 * and the tools snapshot (status `disabled`), `remove` is the tombstone
 * (until 2026-10-25 `off` was). `add` looks at the server once from here
 * before writing anything: a server that asks for a credential none was
 * given for is refused (REMOTE_MCP_NEEDS_CREDENTIAL) unless `--force`.
 */
import { stripVTControlCharacters } from "node:util";
import {
  checkRemoteMcpProvider,
  planRemoteMcpProviderRow,
  RegistrationError,
  remoteMcpBlockOf,
  type RemoteMcpProviderRowPlan,
} from "@every-app/perimeter/registry";
import {
  authorizationFor,
  capabilitySettings,
  discoverMcpOAuth,
  mcpOAuthProviderSpec,
  mcpStaticProviderSpec,
  PROVIDER_APPS,
  providerAppKeySetting,
  obtainMcpClient,
  remoteMcpAuthLabel,
  remoteMcpClientIdSetting,
  remoteMcpClientSecretSetting,
  remoteMcpIdFromUrl,
  remoteMcpProviderId,
  remoteMcpProviderOf,
  remoteMcpClientMetadataUrl,
  remoteMcpRedirectUri,
  remoteMcpTokenSetting,
  type Capability,
  type McpOAuthDiscovery,
  type OAuthClientInjection,
  type ProviderAppId,
  type RemoteMcpAuth,
  type RemoteMcpBlock,
  type RemoteMcpCredentialKind,
  type RemoteMcpRiskDefault,
  type RemoteMcpStaticKind,
  type ToolRisk,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { turnProviderAppOn } from "@/lib/gateway/providerApps";
import {
  gatewayRegistry,
  remoteMcpProviderContext,
  remoteMcpProviderRowWrites,
} from "@/lib/gateway/providers";
import {
  credentialState,
  listMcpApps,
  mcpAppState,
  planRemoteMcpAdd,
  readCredentialContext,
  readMcpAppDetail,
  readRemoteMcpAddContext,
  refreshMcpAppTools,
  remoteProblemOf,
  remoteUrlOf,
  removedRemoteApp,
  removeMcpApp,
  resolveMcpApp,
  setMcpAppStatus,
  setRemoteMcpTool,
  writeRemoteMcpAdd,
  type CredentialContext,
  type CredentialState,
  type McpAppRef,
  type McpAppState,
  type ToolSnapshot,
} from "@/lib/gateway/remoteMcpApps";
import { probeRemoteMcp, type RemoteMcpProbe } from "@/lib/gateway/remoteMcpProbe";
import { asEveryAppError, type StoredAppRow } from "@/lib/gateway/registry";
import { openInBrowser } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmAtTerminal, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { listed, plural } from "@/lib/output/text";
import { readSecretValue } from "@/lib/secretValue";
import { cliVersion } from "@/lib/version";
import type { GatewayCommandFlags } from "../flags";
import { applyProviderSettings } from "../secret";

/** `mcp add`'s flags. */
export interface AddFlags extends GatewayCommandFlags {
  name?: string;
  description?: string;
  risk?: RemoteMcpRiskDefault;
  /** How the Gateway authenticates (default: from the probe). */
  auth?: RemoteMcpCredentialKind;
  /** `--auth header`: the header the value goes in. */
  header?: string;
  /** `--auth bearer`: the scheme instead of Bearer; `--auth header`: what goes before the value. */
  prefix?: string;
  /** `--auth query`: the query parameter the value goes in. */
  param?: string;
  /** An existing provider of the registry as the credential. */
  provider?: string;
  /** `--auth oauth`: a client registered with the server by hand, instead of registering one. */
  "client-id"?: string;
  /** `--client-id`'s secret, from this environment variable. */
  "client-secret-from-env"?: string;
  /** A static credential's value from this environment variable (as `secret set --from-env`). */
  "from-env"?: string;
  /** Add a server that asks for a credential without one. */
  force?: boolean;
  /** Don't open the OAuth connect page in the browser. */
  "no-open"?: boolean;
}

/** `mcp tool`'s flags. */
export interface ToolFlags extends GatewayCommandFlags {
  risk?: ToolRisk | "annotations";
  on?: boolean;
  off?: boolean;
}

/** What the handlers take from the command line, and the seams tests use. */
export interface McpOptions<Flags extends GatewayCommandFlags = GatewayCommandFlags> {
  flags: Flags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  now?: () => number;
  /** `add`'s probe, discovery, client registration and check (tests). */
  fetch?: typeof fetch;
  /** Whether a person is at the terminal for `add` to offer the credential (default: canPromptInTerminal). */
  interactive?: boolean;
  /** `add`'s "set it now?" (default: the terminal's yes/no). */
  confirm?: Confirm;
  /** `add`'s credential value (default: `secret set`'s own reader: --from-env, else the hidden prompt). */
  readValue?: (name: string) => Promise<string>;
  /** `add`'s browser for the connect page (default: the system's, at a terminal unless --no-open). */
  openBrowser?: (url: string) => Promise<unknown>;
}

export async function add(flags: AddFlags, url: string): Promise<void> {
  await runCommand(flags, (out) => addServer({ flags, out }, url));
}

export async function remove(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => removeApp({ flags, out }, id));
}

export async function on(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => turnOn({ flags, out }, id));
}

export async function off(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => turnOff({ flags, out }, id));
}

export async function list(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => listMcp({ flags, out }));
}

export async function show(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => showApp({ flags, out }, id));
}

export async function refresh(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => refreshApp({ flags, out }, id));
}

export async function tool(flags: ToolFlags, id: string, toolName: string): Promise<void> {
  await runCommand(flags, (out) => changeTool({ flags, out }, id, toolName));
}

function connect({ flags, out, createCf }: McpOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

type Connection = Awaited<ReturnType<typeof connect>>;

/** The step `on` and `off` report under (as since #489). */
const STEP = "provider.update";

/** A done event: the message plain, the first line bright and the rest dim for a person. */
function finish(out: EventSink, lines: readonly string[], data: Record<string, unknown>, extra: readonly string[] = []): void {
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line)), ...extra].join("\n"),
    data,
  });
}

/** Who can use a newly added app, in a sentence. */
function accessLine(hasOwner: boolean): string {
  const who = hasOwner
    ? "The owners and the admins can use it"
    : "The owner gets it when they claim the Gateway";
  return `${who}; an admin grants others in Admin → Apps → Manage access.`;
}

/** The auth block as `--json` shows it: none, or the provider. */
function authData(auth: RemoteMcpAuth): Record<string, unknown> {
  return auth.kind === "none" ? { kind: "none" } : { kind: "provider", provider: auth.provider };
}

/**
 * The Gateway's page where a person connects their account to an OAuth
 * provider in the app. It names no page to return to: the Gateway sends them
 * to its own accounts page, wherever that is in the version deployed.
 */
function connectUrl(gatewayUrl: string, provider: string, appId: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/connect/${provider}?app=${appId}`;
}

/** A built-in's key as the commands report it: its name and whether it is set. */
interface KeyState {
  name: string;
  set: boolean;
  /** A remote app's key: set for the hosts its provider has now. */
  bound?: boolean;
}

/** What `--auth`, `--provider` and the rest asked for, before the server is looked at. */
type AskedCredential =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "static"; static: RemoteMcpStaticKind }
  | { kind: "oauth" }
  | { kind: "provider"; provider: string };

function invalid(message: string, fix: string): EveryAppError {
  return new EveryAppError("REMOTE_MCP_INVALID", message, { fix });
}

/** The flags as what they ask for, refusing combinations that say two things (before anything connects). */
function askedCredential(flags: AddFlags): AskedCredential {
  const header = flags.header?.trim();
  const prefix = flags.prefix?.trim();
  const param = flags.param?.trim();
  const provider = flags.provider?.trim();
  const clientId = flags["client-id"]?.trim();
  const auth = flags.auth ?? (clientId ? "oauth" : undefined);
  if (provider && auth) {
    throw invalid(
      `--provider ${provider} is the server's credential, and --auth ${auth} says another`,
      "give one: --provider <id> for a provider the Gateway has, or --auth for the server's own",
    );
  }
  if (header && auth !== "header") {
    throw invalid(
      `--header names the header of --auth header${auth ? `\nWith --auth ${auth} the value doesn't go in a header of its own.` : ""}`,
      "drop --header, or use --auth header",
    );
  }
  if (auth === "header" && !header) {
    throw invalid(
      "--auth header needs --header <name>: the header the server reads the credential from",
      "add --header X-Api-Key (the name the server's docs give)",
    );
  }
  if (param && auth !== "query") {
    throw invalid("--param names the query parameter of --auth query", "drop --param, or use --auth query");
  }
  if (auth === "query" && !param) {
    throw invalid(
      "--auth query needs --param <name>: the query parameter the server reads the credential from",
      "add --param api_key (the name the server's docs give)",
    );
  }
  if (prefix && auth !== "bearer" && auth !== "header") {
    throw invalid(
      "--prefix is for --auth bearer (the scheme instead of Bearer) or --auth header (what goes before the value)",
      "drop --prefix, or use --auth bearer or header",
    );
  }
  const isStatic = auth === "bearer" || auth === "header" || auth === "query" || auth === "basic";
  if (flags["from-env"] && !isStatic) {
    throw invalid(
      provider
        ? `--from-env sets a static credential's value, and --provider ${provider} holds its own`
        : `--from-env sets a static credential's value${auth ? `, and --auth ${auth} takes none` : ": say how it is sent"}`,
      "drop --from-env, or add --auth bearer, header, query or basic",
    );
  }
  if (flags["client-secret-from-env"] && !clientId) {
    throw invalid("--client-secret-from-env is the secret of --client-id", "add --client-id <id>, or drop --client-secret-from-env");
  }
  if (clientId && auth !== "oauth") {
    throw invalid(`--client-id is an OAuth client's, and --auth ${auth} isn't OAuth`, "drop --client-id, or use --auth oauth");
  }
  if (provider) return { kind: "provider", provider };
  if (isStatic) return { kind: "static", static: auth };
  if (auth === "oauth") return { kind: "oauth" };
  if (auth === "none") return { kind: "none" };
  return { kind: "auto" };
}

/** What the probe found, in one line. */
function probeLine(url: string, probe: RemoteMcpProbe): string {
  switch (probe.outcome) {
    case "reachable": {
      const parts = [
        probe.era,
        ...(probe.tools !== null ? [plural(probe.tools, "tool")] : []),
        ...(probe.server ? [`server ${probe.server}`] : []),
      ];
      return `${url} answers MCP (${parts.join(", ")})`;
    }
    case "needs-credential":
      return `${url} asks for a credential (${probe.status}${probe.oauth ? ", OAuth" : ""})`;
    case "redirected":
      return `${url} redirects (${probe.status}${probe.location ? ` to ${probe.location}` : ""})`;
    case "unreachable":
      return `${url} didn't answer from here: ${probe.reason}`;
  }
}

/** The probe's warnings for what can't be told from here: a redirect, no answer, a credential added anyway. */
function probeWarnings(out: EventSink, id: string, url: string, none: boolean, probe: RemoteMcpProbe): void {
  const data = { probe };
  if (probe.outcome === "needs-credential" && none) {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_PROBE_FAILED",
      step: "mcp.probe",
      message: `${url} asks for a credential, and ${id} sends none\nThe Gateway's listing of its tools will fail the same way until it has one.`,
      data: { ...data, fix: `${CLI} mcp remove ${id}, then ${CLI} mcp add ${url} --name ${id} --auth bearer|header|query|basic|oauth` },
    });
    return;
  }
  if (probe.outcome === "redirected") {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_PROBE_FAILED",
      step: "mcp.probe",
      message: `${url} redirects${probe.location ? ` to ${probe.location}` : ""}\nThe Gateway follows no redirects; register the address it redirects to.`,
      data: { ...data, fix: `${CLI} mcp remove ${id}, then ${CLI} mcp add <the address it redirects to> --name ${id}` },
    });
    return;
  }
  if (probe.outcome === "unreachable") {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_PROBE_FAILED",
      step: "mcp.probe",
      message: `Couldn't reach ${url} from here: ${probe.reason}\nThe Gateway may still reach it; ${CLI} mcp show ${id} says whether its tools listed.`,
      data,
    });
  }
}

/** The words of a static credential's placement: "bearer token", "header X-Api-Key", … */
function staticLabel(kind: RemoteMcpStaticKind, flags: AddFlags): string {
  switch (kind) {
    case "bearer":
      return flags.prefix?.trim() && flags.prefix.trim().toLowerCase() !== "bearer"
        ? `${flags.prefix.trim()} token`
        : "bearer token";
    case "header":
      return `header ${flags.header?.trim()}`;
    case "query":
      return `query parameter ${flags.param?.trim()}`;
    case "basic":
      return "user and password";
  }
}

/** `--provider`'s check that the URL's host is one the provider sends its credential to, with the fix. */
function checkProvider(url: string, auth: Extract<RemoteMcpAuth, { kind: "provider" }>, lookup: (id: string) => Capability | undefined) {
  try {
    return checkRemoteMcpProvider({ url, auth, lookupProvider: lookup });
  } catch (error) {
    if (error instanceof RegistrationError && error.code === "REMOTE_MCP_PROVIDER_HOST") {
      throw new EveryAppError("REMOTE_MCP_PROVIDER_HOST", `${error.message}\nA provider's credential goes only to its own hosts.`, {
        fix: `add the server with its own credential instead (--auth bearer|header|query|basic|oauth), or name the provider whose host it is (${CLI} provider list)`,
      });
    }
    throw asEveryAppError(error);
  }
}

/** The refusal of a server that asks for a credential none was given for. */
function needsCredential(url: string, probe: RemoteMcpProbe): EveryAppError {
  return new EveryAppError(
    "REMOTE_MCP_NEEDS_CREDENTIAL",
    `${url} needs a credential. Check the server's docs for how it authenticates, then add it with --auth bearer|header|query|basic, --auth oauth, or --provider <id>. --force adds it anyway.`,
    {
      fix: "add --auth bearer (or header, query, basic, oauth) or --provider <id>; --force adds it without one",
      data: { probe },
    },
  );
}

/** The OAuth client the app's row uses: given, registered now, or the one it had. */
interface OAuthClient {
  registered: "dcr" | "cimd" | "pasted" | "existing";
  clientId: string | null;
  clientSecret: string | null;
  hasSecret: boolean;
  inject: OAuthClientInjection;
}

export async function addServer(options: McpOptions<AddFlags>, url: string): Promise<void> {
  const { out, flags } = options;
  url = url.trim();
  const asked = askedCredential(flags);
  const readValue =
    options.readValue ?? ((name: string) => readSecretValue(name, { fromEnv: flags["from-env"], json: flags.json }));
  const guessedId = flags.name?.trim() || remoteMcpIdFromUrl(url) || "remote";
  // Values from the environment are read before anything is written, so an empty variable (SECRET_EMPTY) changes nothing.
  const fromEnvValue = flags["from-env"] ? await readValue(remoteMcpTokenSetting(guessedId)) : null;
  const pastedSecret = flags["client-secret-from-env"]
    ? await readSecretValue(remoteMcpClientSecretSetting(guessedId), { fromEnv: flags["client-secret-from-env"], json: flags.json })
    : null;
  const fetcher = options.fetch ?? fetch;
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
  const now = options.now?.() ?? Date.now();

  const gateway = await connect(options);
  const env = { gatewayUrl: gateway.gatewayUrl, appBaseDomain: gateway.install.appBaseDomain };
  const registry = await gatewayRegistry(gateway.db, gateway.install);
  const lookup = (id: string) => registry.get(id);
  const context = await readRemoteMcpAddContext(gateway.db, {
    url,
    id: flags.name,
    deployer: gateway.deployer,
    organizationName: gateway.accountName ?? "My Organization",
    now,
  });
  const base = {
    url,
    id: flags.name,
    description: flags.description,
    risk: flags.risk,
    env,
    deployer: gateway.deployer,
    now,
  };
  // Every refusal of the registry's before the server is looked at: the
  // URL, the id, the provider's hosts, an app there already.
  const named = asked.kind === "provider"
    ? { kind: "provider" as const, provider: asked.provider }
    : null;
  if (named) checkProvider(url, named, lookup);
  const firstPlan = planRemoteMcpAdd(context, {
    ...base,
    auth: named ?? { kind: "none" },
    lookupProvider: lookup,
    // auto may find OAuth: the plan with the app's own row decides a reserved host.
    mayBeOwnOAuth: !named && (asked.kind === "auto" || asked.kind === "oauth"),
  });
  const id = firstPlan.id;
  const appName = firstPlan.app.name;

  out.emit({ type: "step", step: "mcp.probe", status: "start", message: `Looking at ${url}...` });
  const probe = await probeRemoteMcp(url, { version: cliVersion, fetch: fetcher });
  out.emit({ type: "step", step: "mcp.probe", status: "ok", message: probeLine(url, probe), data: { probe } });

  // What the credential is: what was asked for, else what the server said.
  let chosen: Exclude<AskedCredential, { kind: "auto" }> = asked.kind === "auto"
    ? probe.outcome === "needs-credential" && probe.oauth
      ? { kind: "oauth" }
      : { kind: "none" }
    : asked;
  if (chosen.kind === "none" && probe.outcome === "needs-credential" && !flags.force) throw needsCredential(url, probe);
  probeWarnings(out, id, url, chosen.kind === "none", probe);

  // The app's own provider row, for a credential of its own.
  const providerId = remoteMcpProviderId(id);
  let rowPlan: RemoteMcpProviderRowPlan | null = null;
  let rowExistingSpec: string | null = null;
  let discovery: McpOAuthDiscovery | null = null;
  let client: OAuthClient | null = null;
  const gatewayNames = await listWorkerSecrets(gateway.cf, gateway.names.worker);
  const planRow = async (spec: Record<string, unknown>) => {
    const rowContext = await remoteMcpProviderContext(gateway.db, gateway.install, providerId);
    rowExistingSpec = rowContext.existing?.spec ?? null;
    try {
      return planRemoteMcpProviderRow({
        appId: id,
        spec,
        existing: rowContext.existing,
        rowSettings: rowContext.rowSettings,
        refuseHost: rowContext.refuseHost,
      });
    } catch (error) {
      throw asEveryAppError(error);
    }
  };
  if (chosen.kind === "static") {
    const built = mcpStaticProviderSpec({
      appId: id,
      name: appName,
      url,
      kind: chosen.static,
      header: flags.header?.trim() ?? null,
      // A header's prefix as given ("Key " keeps its space); a bearer scheme is trimmed by the spec.
      prefix: flags.prefix ?? null,
      param: flags.param?.trim() ?? null,
    });
    if (!built.ok) throw invalid(`${appName}'s credential can't be registered: ${built.problem}`, "fix the flag it names");
    rowPlan = await planRow(built.spec);
  } else if (chosen.kind === "oauth") {
    out.emit({ type: "step", step: "mcp.oauth", status: "start", message: `Finding how ${url} signs in...` });
    const found = await discoverMcpOAuth({
      url,
      fetch: fetcher,
      ...(probe.outcome === "needs-credential" && probe.resourceMetadata ? { resourceMetadataUrl: probe.resourceMetadata } : {}),
      ...(probe.outcome === "needs-credential" && probe.scope ? { scope: probe.scope } : {}),
    });
    if (!found.ok) {
      throw new EveryAppError("REMOTE_MCP_OAUTH_DISCOVERY", `Couldn't find how ${url} signs in with OAuth\n${found.problem}`, {
        fix: "check the server's docs: if it takes an API key instead, add it with --auth bearer|header|query|basic",
        data: { probe },
      });
    }
    discovery = found.discovery;
    out.emit({
      type: "step",
      step: "mcp.oauth",
      status: "ok",
      message: `${url} signs in at ${discovery.issuer}`,
      data: { issuer: discovery.issuer, resource: discovery.resource, scopes: discovery.scopes },
    });
    const redirectUri = remoteMcpRedirectUri(gateway.gatewayUrl, id);
    const specFor = (hasSecret: boolean, inject: OAuthClientInjection) => {
      const built = mcpOAuthProviderSpec({ appId: id, name: appName, url, discovery: discovery!, client: { hasSecret, inject } });
      if (!built.ok) throw invalid(`${appName}'s OAuth can't be registered: ${built.problem}`, "check the server's OAuth metadata");
      return built.spec;
    };
    const clientIdFlag = flags["client-id"]?.trim();
    if (clientIdFlag) {
      const inject: OAuthClientInjection =
        pastedSecret && discovery.tokenEndpointAuthMethods.includes("client_secret_basic") ? "basic" : "form";
      client = { registered: "pasted", clientId: clientIdFlag, clientSecret: pastedSecret, hasSecret: Boolean(pastedSecret), inject };
      rowPlan = await planRow(specFor(client.hasSecret, inject));
    } else {
      // The client the row had, when the server's metadata is the same and it is still set for it: kept, so people's connections keep working.
      const kept = await keptClient(gateway.db, gateway.install, providerId, gatewayNames, specFor, planRow);
      if (kept) {
        client = kept.client;
        rowPlan = kept.plan;
      } else {
        out.emit({ type: "step", step: "mcp.oauth.client", status: "start", message: `Registering a client with ${discovery.issuer}...` });
        const registered = await obtainMcpClient({
          discovery,
          redirectUri,
          clientName: `Every App (${gateway.gatewayUrl.replace(/^https?:\/\//, "")})`,
          documentUrl: remoteMcpClientMetadataUrl(gateway.gatewayUrl, id),
          fetch: fetcher,
        });
        if (!registered.ok) {
          throw new EveryAppError(
            "REMOTE_MCP_OAUTH_NO_CLIENT",
            [
              registered.unsupported
                ? `${discovery.issuer} doesn't let the Gateway register a client of its own`
                : `Couldn't register a client with ${discovery.issuer}: ${registered.problem}`,
              "Register an OAuth client in the server's developer console with this redirect URI:",
              `  ${redirectUri}`,
              "then add the server again with --client-id <its id> (and --client-secret-from-env <VAR> for its secret).",
            ].join("\n"),
            {
              fix: `${CLI} mcp add ${url}${flags.name ? ` --name ${flags.name}` : ""} --auth oauth --client-id <id> --client-secret-from-env <VAR>`,
              data: { redirectUri, issuer: discovery.issuer },
            },
          );
        }
        client = {
          registered: registered.via ?? "dcr",
          clientId: registered.clientId,
          clientSecret: registered.clientSecret ?? null,
          hasSecret: Boolean(registered.clientSecret),
          inject: registered.inject,
        };
        rowPlan = await planRow(specFor(client.hasSecret, client.inject));
        out.emit({
          type: "step",
          step: "mcp.oauth.client",
          status: "ok",
          message:
            registered.via === "cimd"
              ? `${discovery.issuer} reads the Gateway's client document at ${registered.clientId}`
              : `Registered a client with ${discovery.issuer}`,
        });
      }
    }
  }

  // The app, and its own provider row, in one batch.
  const auth: Record<string, unknown> = named
    ? named
    : rowPlan
      ? { kind: "provider" }
      : { kind: "none" };
  const ownRow = rowPlan;
  const plan = planRemoteMcpAdd(context, {
    ...base,
    auth,
    ...(discovery ? { scopes: discovery.scopes } : {}),
    lookupProvider: (providerIdAsked) => (ownRow && providerIdAsked === ownRow.id ? ownRow.capability : lookup(providerIdAsked)),
  });
  out.emit({ type: "step", step: "mcp.add", status: "start", message: `Adding ${url}...` });
  const added = await writeRemoteMcpAdd(gateway.db, context, plan, {
    deployer: gateway.deployer,
    now,
    providerWrites: ownRow ? await remoteMcpProviderRowWrites(gateway.db, ownRow, rowExistingSpec, gateway.deployer, now) : [],
  });
  const { organization } = added;
  const { app, remote } = plan;
  out.emit({
    type: "step",
    step: "mcp.add",
    status: "ok",
    message: `${app.name} is on for ${organization.name}`,
    data: { id, was: plan.kind, ...(ownRow ? { provider: { id: ownRow.id, action: ownRow.action } } : {}) },
  });

  const host = new URL(remote.url).hostname;
  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${id}_` };
  const credentialKind: RemoteMcpCredentialKind | "provider" =
    chosen.kind === "static" ? chosen.static : chosen.kind === "provider" ? "provider" : chosen.kind;
  let credential: Record<string, unknown> = { kind: credentialKind };
  let connectLink: { url: string } | null = null;
  let verify: Record<string, unknown> | null = null;
  let credentialLine = "It takes no credential.";
  const next: Array<{ command: string; note: string }> = [];

  if (chosen.kind === "static" && ownRow) {
    const setting = remoteMcpTokenSetting(id);
    let set = gatewayNames.includes(setting);
    let bound = ownRow.action === "keep" && ownRow.bound;
    let value = fromEnvValue;
    const label = staticLabel(chosen.static, flags);
    if (value === null && !(set && bound) && interactive) {
      const confirm = options.confirm ?? confirmAtTerminal;
      const now = await confirm(`Set ${setting} now?`, [
        `${app.name}'s credential (${label}${chosen.static === "basic" ? ", entered as user:password" : ""}) is a Gateway setting.`,
        `The Gateway sends it to ${host} and nowhere else. Later: ${CLI} secret set ${setting}`,
      ]);
      if (now) value = await readValue(setting);
    }
    if (value !== null) {
      // secret set's own path: the lease, one Gateway version, and the row bound to its host.
      await applyProviderSettings(gateway, { [setting]: value }, { flags, out });
      set = true;
      bound = true;
      verify = await verifyStatic(out, remote.url, ownRow.capability, setting, value, label, fetcher);
    }
    credential = { kind: credentialKind, setting, set, bound };
    if (!set || !bound) {
      out.emit({
        type: "warning",
        code: "PROVIDER_KEY_UNSET",
        step: "mcp.add",
        message: set
          ? `${setting} was set for other hosts, not ${host}\nThe Gateway sends a key only to the hosts it was set for; set it again for ${app.name}.`
          : `${setting} isn't set on the Gateway\n${app.name}'s tools stay out of /mcp until it is.`,
        data: { fix: `${CLI} secret set ${setting}`, name: setting },
      });
      next.push({ command: `${CLI} secret set ${setting}`, note: `${app.name}'s credential` });
    }
    credentialLine = !set
      ? `${setting} isn't set: ${CLI} secret set ${setting}`
      : !bound
        ? `${setting} is set for other hosts: ${CLI} secret set ${setting}`
        : `${setting} is set; the Gateway sends it to ${host} and nowhere else.`;
  } else if (chosen.kind === "oauth" && ownRow && client && discovery) {
    const clientSetting = remoteMcpClientIdSetting(id);
    if (client.registered !== "existing") {
      const changes: Record<string, string> = { [clientSetting]: client.clientId! };
      if (client.clientSecret) changes[remoteMcpClientSecretSetting(id)] = client.clientSecret;
      await applyProviderSettings(gateway, changes, { flags, out });
    }
    connectLink = { url: connectUrl(gateway.gatewayUrl, ownRow.id, id) };
    credential = { kind: "oauth", setting: clientSetting, set: true, bound: true };
    credentialLine = `Each member connects their own ${app.name} account: ${connectLink.url}`;
  } else if (chosen.kind === "provider" && plan.provider) {
    const { capability } = plan.provider;
    const settings = capabilitySettings(capability);
    const set = settings.every((name) => gatewayNames.includes(name));
    const bound = registry.bound(plan.provider.id);
    credential = { kind: "provider", setting: settings[0], set, bound };
    if (capability.mode === "oauth_client") {
      connectLink = { url: connectUrl(gateway.gatewayUrl, plan.provider.id, id) };
      credentialLine = `It signs in with ${capability.label}: each member connects their own account at ${connectLink.url}`;
    } else {
      credentialLine = `It uses ${capability.label}'s key ${settings[0]}${set && bound ? ", set on the Gateway." : `, which isn't set${set ? " for its hosts" : ""}: ${CLI} secret set ${settings[0]}`}`;
    }
    if (capability.mode === "api_key" && (!set || !bound)) {
      out.emit({
        type: "warning",
        code: "PROVIDER_KEY_UNSET",
        step: "mcp.add",
        message: `${settings[0]} isn't set on the Gateway${set ? " for its hosts" : ""}\n${app.name}'s tools stay out of /mcp until it is.`,
        data: { fix: `${CLI} secret set ${settings[0]}`, name: settings[0] },
      });
      next.push({ command: `${CLI} secret set ${settings[0]}`, note: `${capability.label}'s key` });
    }
  }

  if (connectLink) {
    const open = options.openBrowser ?? (interactive && !flags["no-open"] ? openInBrowser : null);
    if (open && !flags["no-open"]) {
      out.emit({ type: "progress", step: "mcp.connect", message: `Opening ${connectLink.url} in your browser...` });
      await open(connectLink.url);
    }
  }

  const lines = [
    `${app.name} is on for ${organization.name}${plan.kind === "revived" ? " (added again, from scratch)" : ""}.`,
    accessLine(added.hasOwner),
    `Its tools are on ${mcp.url} as ${mcp.toolPrefix}<tool>; the Gateway lists them on first use.`,
    credentialLine,
    ...(verify && verify["ok"] === true
      ? [`Working: ${verify["tools"] === null ? "it answers MCP with the credential" : plural(Number(verify["tools"]), "tool")}.`]
      : []),
  ];
  next.push({ command: `${CLI} mcp show ${id}`, note: "its tools, once the Gateway lists them" });
  finish(out, lines, {
    id,
    name: app.name,
    url: remote.url,
    auth: authData(remote.auth),
    credential,
    ...(connectLink ? { connect: connectLink } : {}),
    ...(discovery && client ? { oauth: { issuer: discovery.issuer, registered: client.registered } } : {}),
    ...(verify ? { verify } : {}),
    risk: remote.risk,
    on: true,
    was: plan.kind,
    organization: { id: organization.id, name: organization.name },
    probe,
    mcp,
    next,
  });
}

/**
 * The OAuth client the app's own row has, when it can stay: the row is an
 * `oauth2-user` row with the same metadata (the plan keeps it), bound, and
 * its client id is set on the Gateway. Null otherwise: a new one is
 * registered.
 */
async function keptClient(
  db: Connection["db"],
  install: Connection["install"],
  providerId: string,
  gatewayNames: readonly string[],
  specFor: (hasSecret: boolean, inject: OAuthClientInjection) => Record<string, unknown>,
  planRow: (spec: Record<string, unknown>) => Promise<RemoteMcpProviderRowPlan>,
): Promise<{ client: OAuthClient; plan: RemoteMcpProviderRowPlan } | null> {
  const { existing } = await remoteMcpProviderContext(db, install, providerId);
  if (!existing) return null;
  let auth: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(existing.spec) as { auth?: Record<string, unknown> };
    auth = parsed.auth && parsed.auth["kind"] === "oauth2-user" ? parsed.auth : null;
  } catch {
    return null;
  }
  if (!auth) return null;
  const hasSecret = typeof auth["clientSecret"] === "string";
  const inject: OAuthClientInjection = auth["inject"] === "basic" ? "basic" : "form";
  let plan: RemoteMcpProviderRowPlan;
  try {
    plan = await planRow(specFor(hasSecret, inject));
  } catch {
    return null;
  }
  const settings = capabilitySettings(plan.capability);
  if (plan.action !== "keep" || !plan.bound || !settings.every((name) => gatewayNames.includes(name))) return null;
  return { client: { registered: "existing", clientId: null, clientSecret: null, hasSecret, inject }, plan };
}

/**
 * The static credential checked from here once it is set: one `tools/list`
 * with it, as the Gateway will send it. Working (with the tool count), or
 * REMOTE_MCP_CREDENTIAL_REJECTED as a warning; nothing to say when the
 * server can't be reached from here.
 */
async function verifyStatic(
  out: EventSink,
  url: string,
  capability: Capability,
  setting: string,
  value: string,
  label: string,
  fetcher: typeof fetch,
): Promise<Record<string, unknown> | null> {
  if (capability.mode !== "api_key") return null;
  const authorization = authorizationFor(capability, { [setting]: value });
  if (!authorization) return null;
  out.emit({ type: "step", step: "mcp.verify", status: "start", message: `Checking ${setting} with ${url}...` });
  const checked = await probeRemoteMcp(url, { version: cliVersion, fetch: fetcher, credential: authorization, listTools: true });
  if (checked.outcome === "reachable") {
    out.emit({
      type: "step",
      step: "mcp.verify",
      status: "ok",
      message: checked.tools === null ? "Working: it answers MCP with the credential" : `Working: ${plural(checked.tools, "tool")}`,
      data: { tools: checked.tools },
    });
    return { ok: true, tools: checked.tools };
  }
  if (checked.outcome === "needs-credential") {
    out.emit({ type: "step", step: "mcp.verify", status: "ok", message: `${url} refused ${setting} (${checked.status})` });
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_CREDENTIAL_REJECTED",
      step: "mcp.verify",
      message: `${url} refused ${setting} (${checked.status})\nCheck the key, and where it goes: the Gateway sends it as a ${label}. ${CLI} secret set ${setting} sets it again.`,
      data: { status: checked.status, fix: `${CLI} secret set ${setting}`, name: setting },
    });
    return { ok: false, status: checked.status };
  }
  const reason = checked.outcome === "redirected" ? `it redirects (${checked.status})` : checked.reason;
  out.emit({ type: "step", step: "mcp.verify", status: "ok", message: `Couldn't check ${setting} from here: ${reason}` });
  return { ok: null, reason };
}

/** A remote ref with a live row, or the refusal for a removed one. */
function liveRemote(ref: McpAppRef): StoredAppRow {
  if (!ref.app || ref.app.status === "deleted") throw removedRemoteApp(ref);
  return ref.app;
}

/** The display name of a ref: the built-in's, or the row's. */
function nameOf(ref: McpAppRef): string {
  return ref.kind === "builtin" ? PROVIDER_APPS[ref.id as ProviderAppId].name : (ref.app?.name ?? ref.id);
}

/** A ref's remote block (null for a built-in, or one that can't be read) and why it can't be read. */
function remoteOf(ref: McpAppRef): { remote: RemoteMcpBlock | null; problem: string | null } {
  if (ref.kind === "builtin" || !ref.app) return { remote: null, problem: null };
  const remote = remoteMcpBlockOf(ref.app);
  return { remote, problem: remote ? null : remoteProblemOf(ref.app) };
}

/** What a ref's key and credential are now: a built-in's key, a remote app's credential. */
interface RefState {
  names: string[];
  context: CredentialContext;
  /** A built-in's key, or a remote app's API key; null otherwise. */
  key: KeyState | null;
  /** A remote app's credential; null for a built-in. */
  credential: CredentialState | null;
}

/** The setting names and the providers, read once per command. */
async function readContext(connection: Connection): Promise<CredentialContext> {
  const names = await listWorkerSecrets(connection.cf, connection.names.worker);
  return readCredentialContext(connection.db, connection.install, names);
}

/** A key as the commands report it, from a built-in's setting or a remote app's credential. */
function keyFrom(context: CredentialContext, builtinKey: string | null, credential: CredentialState | null): KeyState | null {
  if (builtinKey) return { name: builtinKey, set: context.gatewayNames.includes(builtinKey) };
  if (credential?.kind === "key") return { name: credential.setting, set: credential.set, bound: credential.bound };
  return null;
}

async function refState(connection: Connection, ref: McpAppRef): Promise<RefState> {
  const context = await readContext(connection);
  const builtinKey = ref.kind === "builtin" ? providerAppKeySetting(ref.id as ProviderAppId) : null;
  const { remote, problem } = remoteOf(ref);
  const credential = ref.kind === "remote" && ref.app ? credentialState(remote, problem, context, ref.id) : null;
  return { names: [...context.gatewayNames], context, key: keyFrom(context, builtinKey, credential), credential };
}

/** The setting `secret set` sets for a credential that needs one, else null. */
function settingToSet(credential: CredentialState | null): string | null {
  if (credential?.kind === "key" && (!credential.set || !credential.bound)) return credential.setting;
  if (
    credential?.kind === "oauth" &&
    !credential.client.uploaded &&
    (!credential.client.set || !credential.client.bound)
  ) {
    return credential.client.setting;
  }
  return null;
}

/** The text that says a remote registration can't be read. */
const PREDATES_TEXT = "registered before provider credentials: remove and add again";

/** A remote app's credential in a few words, plain: for the KEY column and `show`. */
function credentialText(credential: CredentialState): string {
  switch (credential.kind) {
    case "none":
      return "none";
    case "key":
      return `${credential.setting} ${!credential.set ? "unset" : credential.bound ? "set" : "set for other hosts"}`;
    case "oauth":
      return settingToSet(credential)
        ? `${credential.client.setting} ${credential.client.set ? "set for other hosts" : "unset"}`
        : `OAuth: ${credential.connected} connected`;
    case "missing":
      return `${credential.provider} isn't a provider on this Gateway`;
    case "predates":
      return PREDATES_TEXT;
  }
}

/** The KEY cell: a built-in's key, or a remote app's credential, colored by whether it is ready. */
function keyCell(key: KeyState | null, credential: CredentialState | null): string {
  if (credential) {
    const words = credentialText(credential);
    if (credential.kind === "none") return chalk.dim(words);
    const ready =
      (credential.kind === "key" && credential.set && credential.bound) ||
      (credential.kind === "oauth" && !settingToSet(credential) && credential.connected > 0);
    return ready ? chalk.green(words) : chalk.yellow(words);
  }
  if (!key) return chalk.dim("none");
  return `${key.name} ${key.set ? chalk.green("set") : chalk.yellow("not set")}`;
}

/** The credential as `--json` shows it (never a value; who is connected only in `show`). */
function credentialData(credential: CredentialState | null, withPeople = false): Record<string, unknown> | null {
  if (!credential) return null;
  if (credential.kind === "oauth") {
    const { people, ...rest } = credential;
    return withPeople ? credential : rest;
  }
  return credential;
}

/** The connect page of a remote app's OAuth provider, or null. */
function connectOf(gatewayUrl: string, id: string, credential: CredentialState | null): { url: string } | null {
  if (credential?.kind !== "oauth") return null;
  return { url: connectUrl(gatewayUrl, credential.provider, id) };
}

/** What to run next for a remote app's credential: set its key or client, or remove a registration that can't be read. */
function credentialNext(id: string, name: string, credential: CredentialState | null): Array<{ command: string; note: string }> {
  if (credential?.kind === "predates") {
    return [{ command: `${CLI} mcp remove ${id}`, note: `${name} was ${PREDATES_TEXT.replace(": remove and add again", "")}; then add it again` }];
  }
  const setting = settingToSet(credential);
  return setting ? [{ command: `${CLI} secret set ${setting}`, note: `${name}'s ${credential?.kind === "oauth" ? "OAuth client" : "credential"}` }] : [];
}

export async function turnOn(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  out.emit({ type: "step", step: STEP, status: "start", message: `Turning ${id} on...` });
  let was: string;
  let organization: { id: string; name: string };
  let accessText: string | null = null;
  if (ref.kind === "builtin") {
    const result = await turnProviderAppOn(gateway.db, {
      id,
      deployer: gateway.deployer,
      organizationName: gateway.accountName ?? "My Organization",
      now: options.now?.(),
    });
    was = result.was;
    organization = result.organization;
    if (was === "new" || was === "revived") accessText = accessLine(result.hasOwner);
  } else {
    const app = liveRemote(ref);
    const { changed } = await setMcpAppStatus(gateway.db, app, "active", gateway.deployer, options.now?.());
    was = changed ? "off" : "existing";
    organization = ref.organization!;
  }
  const name = nameOf(ref);
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: was === "existing" ? `${name} was on already` : `${name} is on for ${organization.name}`,
    data: { id, was },
  });
  const { key, credential } = await refState(gateway, ref);
  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${id}_` };
  const unset = ref.kind === "builtin" ? (key && !key.set ? key.name : null) : settingToSet(credential);
  if (unset) {
    out.emit({
      type: "warning",
      code: "PROVIDER_KEY_UNSET",
      step: STEP,
      message: `${unset} isn't set on the Gateway${key?.set ? " for its hosts" : ""}\n${name}'s tools ${ref.kind === "builtin" ? 'answer "not set up"' : "stay out of /mcp"} until it is.`,
      data: { fix: `${CLI} secret set ${unset}`, name: unset },
    });
  }
  const connectLink = connectOf(gateway.gatewayUrl, id, credential);
  const lines = [
    `${name} is on for ${organization.name}${was === "existing" ? " (it was already)" : was === "off" ? " (it was off; everyone's access was kept)" : ""}.`,
    ...(accessText ? [accessText] : []),
    `Its tools are on ${mcp.url} as ${mcp.toolPrefix}<tool>.`,
    ...(ref.kind === "builtin" && key
      ? [key.set ? `${key.name} is set on the Gateway.` : `${key.name} isn't set: ${CLI} secret set ${key.name}`]
      : credential && credential.kind !== "none"
        ? [`Credential: ${credentialText(credential)}${connectLink && !unset ? `; connect at ${connectLink.url}` : ""}.`]
        : []),
  ];
  const next =
    ref.kind === "builtin"
      ? unset
        ? [{ command: `${CLI} secret set ${unset}`, note: "the provider's key" }]
        : []
      : credentialNext(id, name, credential);
  finish(out, lines, {
    id,
    name,
    kind: ref.kind,
    on: true,
    was,
    organization: { id: organization.id, name: organization.name },
    key,
    ...(credential ? { credential: credentialData(credential) } : {}),
    ...(connectLink ? { connect: connectLink } : {}),
    mcp,
    ...(next.length > 0 ? { next } : {}),
  });
}

export async function turnOff(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  out.emit({ type: "step", step: STEP, status: "start", message: `Turning ${id} off...` });
  const name = nameOf(ref);
  const live = ref.app && ref.app.status !== "deleted" ? ref.app : null;
  const wasOn = live ? (await setMcpAppStatus(gateway.db, live, "disabled", gateway.deployer, options.now?.())).changed : false;
  const where = ref.organization ? ` for ${ref.organization.name}` : "";
  const message = wasOn
    ? `${name} is off${where}`
    : live
      ? `${name} was off already${where}`
      : ref.kind === "remote"
        ? `${name} was removed${where}`
        : `${name} isn't on${where}`;
  out.emit({ type: "step", step: STEP, status: "ok", message, data: { id } });
  const { key, credential } = await refState(gateway, ref);
  const lines = [
    `${message}.`,
    wasOn
      ? `Its tools leave /mcp within 30 seconds. Everyone's access, its tokens and its tools snapshot are kept: ${CLI} mcp on ${id} serves it again at once.`
      : "Nothing changed.",
    ...(live ? [`${CLI} mcp remove ${id} removes it for good.`] : []),
  ];
  finish(out, lines, {
    id,
    name,
    kind: ref.kind,
    on: false,
    wasOn,
    key,
    ...(credential ? { credential: credentialData(credential) } : {}),
  });
}

export async function removeApp(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  // What the app used, read before the tombstone: the provider row stays after it.
  const { key, credential } = await refState(gateway, ref);
  out.emit({ type: "step", step: "mcp.remove", status: "start", message: `Removing ${id}...` });
  const name = nameOf(ref);
  const { removed } = await removeMcpApp(gateway.db, ref.app, gateway.deployer, options.now?.());
  const where = ref.organization ? ` from ${ref.organization.name}` : "";
  const message = removed
    ? `${name} is removed${where}`
    : ref.app
      ? `${name} was removed already${where}`
      : `${name} isn't added${where}`;
  out.emit({ type: "step", step: "mcp.remove", status: "ok", message, data: { id, removed } });
  const url = ref.app ? remoteUrlOf(ref.app) : null;
  const provider = credential && "provider" in credential ? credential.provider : null;
  const own = provider === remoteMcpProviderId(id);
  const registry = own || provider ? await gatewayRegistry(gateway.db, gateway.install) : null;
  const providerCapability = provider ? registry?.get(provider) : undefined;
  const providerSettings = providerCapability ? [...capabilitySettings(providerCapability)] : [];
  const stays = removed && provider
    ? own
      ? `Its provider row ${provider}${providerSettings.length > 0 ? ` and ${listed(providerSettings)}` : ""} stay: ${CLI} provider remove ${provider}${providerSettings.length > 0 ? ` and ${CLI} secret unset ${providerSettings.join(" ")}` : ""} clean them up.`
      : `${provider} stays, with its key and connections, for whatever else uses it.`
    : null;
  const lines = [
    `${message}.`,
    removed
      ? "Its tools left /mcp, and everyone's access to it, its tokens, its tools snapshot and its place in AI connections went with it."
      : "Nothing changed.",
    ...(stays ? [stays] : []),
    ...(ref.kind === "builtin" && key && key.set
      ? [`${key.name} stays on the Gateway (an app may use it too): ${CLI} secret unset ${key.name} removes it.`]
      : []),
    ...(ref.kind === "builtin"
      ? [`${CLI} mcp on ${id} adds it again, from scratch.`]
      : url
        ? [`${CLI} mcp add ${url} --name ${id} adds it again, from scratch.`]
        : []),
  ];
  finish(out, lines, {
    id,
    name,
    kind: ref.kind,
    removed,
    key,
    ...(credential ? { credential: credentialData(credential) } : {}),
    ...(provider ? { provider: { id: provider, own, kept: true, settings: providerSettings } } : {}),
  });
}

/** A snapshot in a few words: its tool count, when, and a failure. */
function snapshotText(snapshot: ToolSnapshot | null): string {
  if (!snapshot) return "not listed yet";
  const when = snapshot.listedAt ? ` ${timeText(snapshot.listedAt)}` : "";
  if (snapshot.status === "error") return `listing failed${when}${snapshot.lastError ? `: ${snapshot.lastError}` : ""}`;
  return `${plural(snapshot.toolCount, "tool")}, listed${when}`;
}

function timeText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A snapshot as `--json` shows it. */
function snapshotData(snapshot: ToolSnapshot | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    status: snapshot.status,
    tools: snapshot.status === "error" ? null : snapshot.toolCount,
    listedAt: snapshot.listedAt === null ? null : new Date(snapshot.listedAt).toISOString(),
    lastError: snapshot.lastError,
  };
}

function stateCell(state: McpAppState): string {
  switch (state) {
    case "on":
      return chalk.green("on");
    case "needs setup":
      return chalk.yellow("needs setup");
    default:
      return chalk.dim(state);
  }
}

export async function listMcp(options: McpOptions): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const [entries, context] = await Promise.all([listMcpApps(gateway.db), readContext(gateway)]);
  const rows = entries.map((entry) => {
    const credential = entry.kind === "remote" ? credentialState(entry.remote, entry.problem, context, entry.id) : null;
    const state = mcpAppState(entry, context.gatewayNames, credential);
    const key = keyFrom(context, entry.keyName, credential);
    const tools = entry.snapshot && entry.snapshot.status !== "error" ? entry.snapshot.toolCount : null;
    return { entry, state, key, credential, tools };
  });
  const table = formatTable(
    ["APP", "KIND", "STATUS", "TOOLS", "KEY"],
    rows.map(({ entry, state, key, credential }) => [
      `${entry.id}  ${chalk.dim(entry.name)}`,
      entry.kind === "builtin" ? "built-in" : "remote",
      stateCell(state),
      !entry.snapshot
        ? chalk.dim("not listed yet")
        : entry.snapshot.status === "error"
          ? chalk.yellow("listing failed")
          : String(entry.snapshot.toolCount),
      keyCell(key, credential),
    ]),
  );
  const next = rows.flatMap(({ entry, state, key, credential }) => [
    ...(state === "not added" ? [{ command: `${CLI} mcp on ${entry.id}`, note: `offer ${entry.name}` }] : []),
    ...(entry.kind === "builtin" && key && entry.app && !key.set
      ? [{ command: `${CLI} secret set ${key.name}`, note: `${entry.name}'s key` }]
      : []),
    ...(entry.kind === "remote" ? credentialNext(entry.id, entry.name, credential) : []),
  ]);
  const onCount = rows.filter((row) => row.entry.app?.status === "active").length;
  const summary = `${onCount} of ${rows.length} MCP ${rows.length === 1 ? "app" : "apps"} on`;
  const hasRemote = rows.some((row) => row.entry.kind === "remote");
  out.emit({
    type: "done",
    message: summary,
    display: [
      ...table,
      "",
      chalk.dim(`Tools are on ${gateway.gatewayUrl}/mcp as <id>_<tool>.`),
      ...(hasRemote ? [] : [chalk.dim(`Add any MCP server by its URL: ${CLI} mcp add <url>`)]),
    ].join("\n"),
    data: {
      apps: rows.map(({ entry, state, key, credential, tools }) => {
        const connectLink = connectOf(gateway.gatewayUrl, entry.id, credential);
        return {
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          status: state,
          on: entry.app?.status === "active",
          ...(entry.kind === "remote"
            ? {
                url: entry.remote?.url ?? (entry.app ? remoteUrlOf(entry.app) : null),
                auth: entry.remote ? authData(entry.remote.auth) : null,
                credential: credentialData(credential),
                ...(connectLink ? { connect: connectLink } : {}),
              }
            : {}),
          tools,
          key,
          ...(entry.snapshot?.listedAt ? { lastListedAt: new Date(entry.snapshot.listedAt).toISOString() } : {}),
          ...(entry.snapshot?.lastError ? { lastError: entry.snapshot.lastError } : {}),
        };
      }),
      mcp: `${gateway.gatewayUrl}/mcp`,
      ...(next.length > 0 ? { next } : {}),
    },
  });
}

/** How a risk default reads. */
function riskDefaultText(risk: RemoteMcpRiskDefault): string {
  switch (risk) {
    case "annotations":
      return "annotations (the server's hints; a tool without one is write)";
    case "read":
      return "read (every tool)";
    case "write":
      return "write (every tool)";
  }
}

export async function showApp(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  if (ref.kind === "remote") liveRemote(ref);
  const name = nameOf(ref);
  const { context, key, credential } = await refState(gateway, ref);
  const { remote } = remoteOf(ref);
  const live = ref.app && ref.app.status !== "deleted" ? ref.app : null;
  const builtinKey = ref.kind === "builtin" ? providerAppKeySetting(ref.id as ProviderAppId) : null;
  const state = mcpAppState({ kind: ref.kind, app: live, keyName: builtinKey }, context.gatewayNames, credential);
  const detail = live ? await readMcpAppDetail(gateway.db, { ...ref, app: live }, remote) : null;
  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${id}_` };
  const added = live?.deployedAt
    ? `${live.deployedByActor ? `by ${live.deployedByActor}, ` : ""}${timeText(live.deployedAt)}`
    : null;
  const provider = remote ? remoteMcpProviderOf(remote.auth) : null;
  const capability = provider ? (context.registry.get(provider) ?? null) : null;
  const connectLink = connectOf(gateway.gatewayUrl, id, credential);
  const url = remote?.url ?? (live ? remoteUrlOf(live) : null);

  const facts = [
    { label: "Kind", value: ref.kind === "builtin" ? "built-in (the Gateway's own)" : "remote" },
    { label: "Status", value: stateCell(state) },
    ...(ref.kind === "remote" && url ? [{ label: "URL", value: url }] : []),
    ...(remote
      ? [
          {
            label: "Auth",
            value: `${remoteMcpAuthLabel(remote.auth, capability)}${provider ? chalk.dim(` (provider ${provider})`) : ""}`,
          },
          { label: "Risk", value: riskDefaultText(remote.risk) },
          { label: "Revision", value: String(remote.rev) },
        ]
      : []),
    ...(added ? [{ label: "Added", value: added }] : []),
    ...(ref.kind === "builtin" && key ? [{ label: "Key", value: keyCell(key, null) }] : []),
    ...(credential && credential.kind !== "none"
      ? [
          {
            label: "Credential",
            value:
              keyCell(null, credential) +
              (credential.kind === "oauth" && credential.people.length > 0
                ? chalk.dim(` (${credential.people.join(", ")})`)
                : ""),
          },
        ]
      : []),
    ...(connectLink ? [{ label: "Connect", value: connectLink.url }] : []),
    ...(live ? [{ label: "Tools", value: snapshotText(detail!.snapshot) }] : []),
  ];
  const toolRows = detail
    ? remote
      ? formatTable(
          ["NAME", "SERVER NAME", "RISK", "ON"],
          detail.remoteTools.map((each) => [
            each.name ?? chalk.dim("(none)"),
            each.serverName,
            `${each.risk} ${chalk.dim(each.source)}`,
            each.on ? chalk.green("on") : chalk.yellow(each.problem ?? "off"),
          ]),
        )
      : formatTable(
          ["NAME", "RISK"],
          detail.catalogTools.map((each) => [each.name, each.risk]),
        )
    : [];
  const hasTools = detail ? (remote ? detail.remoteTools.length > 0 : detail.catalogTools.length > 0) : false;
  const lines = [`${name} (${id})`];
  const next =
    ref.kind === "builtin"
      ? key && live && !key.set
        ? [{ command: `${CLI} secret set ${key.name}`, note: `${name}'s key` }]
        : state === "not added"
          ? [{ command: `${CLI} mcp on ${id}`, note: `offer ${name}` }]
          : []
      : live
        ? credentialNext(id, name, credential)
        : [];
  out.emit({
    type: "done",
    message: stripVTControlCharacters([lines[0], ...formatFacts(facts)].join("\n")),
    display: [
      chalk.bold(lines[0]),
      ...formatFacts(facts),
      ...(hasTools ? ["", ...toolRows] : []),
      ...(live && !hasTools
        ? ["", chalk.dim(`No tools listed yet: the Gateway lists them on the next request to ${mcp.url}.`)]
        : []),
    ].join("\n"),
    data: {
      id,
      name,
      kind: ref.kind,
      status: state,
      on: live?.status === "active",
      ...(ref.kind === "remote"
        ? {
            url,
            auth: remote ? authData(remote.auth) : null,
            credential: credentialData(credential, true),
            ...(connectLink ? { connect: connectLink } : {}),
            ...(remote ? { risk: remote.risk, rev: remote.rev, overrides: remote.tools } : {}),
          }
        : {}),
      addedBy: live?.deployedByActor ?? null,
      addedAt: live?.deployedAt ? new Date(live.deployedAt).toISOString() : null,
      key,
      snapshot: snapshotData(detail?.snapshot ?? null),
      tools: detail
        ? remote
          ? detail.remoteTools
          : detail.catalogTools.map((each) => ({ ...each, source: "registry", on: true }))
        : [],
      mcp,
      ...(next.length > 0 ? { next } : {}),
    },
  });
}

export async function refreshApp(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  if (ref.kind === "remote") liveRemote(ref);
  const name = nameOf(ref);
  const live = ref.app && ref.app.status !== "deleted" ? ref.app : null;
  if (!live) {
    const message = `${name} isn't on, so it has no tools to list again`;
    finish(out, [`${message}.`, "Nothing changed."], { id, name, kind: ref.kind, refreshed: false }, []);
    return;
  }
  out.emit({ type: "step", step: "mcp.refresh", status: "start", message: `Dropping ${name}'s tools snapshot...` });
  const dropped = await refreshMcpAppTools(gateway.db, live);
  out.emit({ type: "step", step: "mcp.refresh", status: "ok", message: `Dropped ${name}'s tools snapshot`, data: { id } });
  const lines = [
    dropped
      ? `Dropped ${name}'s tools snapshot (${snapshotText(dropped)}).`
      : `${name} had no tools snapshot to drop.`,
    live.status === "active"
      ? `The Gateway lists its tools again on the next request to ${gateway.gatewayUrl}/mcp, or within the hour.`
      : `It's off: the Gateway lists its tools again once it's on (${CLI} mcp on ${id}).`,
  ];
  finish(out, lines, { id, name, kind: ref.kind, refreshed: true, dropped: snapshotData(dropped) });
}

export async function changeTool(options: McpOptions<ToolFlags>, id: string, toolName: string): Promise<void> {
  const { out, flags } = options;
  if (flags.on && flags.off) {
    throw new EveryAppError("MCP_TOOL_CHANGE_INVALID", "--on and --off say opposite things; give one", {
      fix: "drop one of them",
    });
  }
  if (!flags.risk && !flags.on && !flags.off) {
    throw new EveryAppError(
      "MCP_TOOL_CHANGE_INVALID",
      `Nothing to change about ${toolName}\nGive --risk read|write|annotations, --on or --off.`,
      { rerun: `${CLI} mcp show ${id}`, rerunNote: "lists its tools with their risks" },
    );
  }
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  if (ref.kind === "builtin") {
    throw new EveryAppError(
      "MCP_APP_BUILTIN",
      `${nameOf(ref)} is the Gateway's built-in MCP app\nIts tools and their risks are the Gateway's own, and can't be changed here. ${CLI} mcp off ${id} stops serving it.`,
    );
  }
  const app = liveRemote(ref);
  out.emit({ type: "step", step: "mcp.tool", status: "start", message: `Changing ${toolName} on ${id}...` });
  const changed = await setRemoteMcpTool(
    gateway.db,
    { ...ref, app },
    toolName,
    { ...(flags.risk ? { risk: flags.risk } : {}), ...(flags.on ? { enabled: true } : flags.off ? { enabled: false } : {}) },
    options.now?.(),
    gateway.deployer,
  );
  out.emit({ type: "step", step: "mcp.tool", status: "ok", message: `Changed ${changed.serverName} on ${id}`, data: { id } });
  if (!changed.inListing) {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_TOOL_NOT_LISTED",
      step: "mcp.tool",
      message: `${toolName} isn't in ${id}'s last tool listing\nThe override is kept under the server's name ${changed.serverName} and applies once the server lists a tool by that name.`,
      data: { rerun: `${CLI} mcp show ${id}`, rerunNote: "lists its tools by both names" },
    });
  }
  const after = changed.after ?? {};
  const risk = after.risk ? `risk ${after.risk} (your override)` : "risk from the app's default and the server's hints";
  const listed = after.enabled === false ? "left out of the catalog" : "listed";
  const lines = [
    `${changed.serverName}${changed.listedName ? ` (${changed.listedName})` : ""} on ${id}: ${risk}, ${listed}.`,
    `The Gateway lists ${id}'s tools again on first use (revision ${changed.rev}).`,
  ];
  finish(out, lines, {
    id,
    tool: { serverName: changed.serverName, name: changed.listedName, inListing: changed.inListing },
    before: changed.before,
    override: changed.after,
    rev: changed.rev,
  });
}
