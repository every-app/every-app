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
 * `on` serves, `off` stops serving and keeps everyone's access, the tokens
 * and the tools snapshot (status `disabled`), `remove` is the tombstone
 * (until 2026-10-25 `off` was). `add` looks at the server once from here
 * and warns about what it found, never refuses on it.
 */
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { remoteMcpBlockOf } from "@every-app/perimeter/registry";
import {
  PROVIDER_APPS,
  providerAppKeySetting,
  remoteMcpAuthLabel,
  remoteMcpIdFromUrl,
  remoteMcpSecretName,
  remoteMcpSecretOf,
  type ProviderAppId,
  type RemoteMcpAuth,
  type RemoteMcpAuthKind,
  type RemoteMcpBlock,
  type RemoteMcpRiskDefault,
  type ToolRisk,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { turnProviderAppOn } from "@/lib/gateway/providerApps";
import {
  addRemoteMcpApp,
  bindRemoteMcpCredentials,
  listMcpApps,
  mcpAppState,
  originOf,
  readCredentialBindings,
  readMcpAppDetail,
  refreshMcpAppTools,
  remoteMcpTables,
  removedRemoteApp,
  removeMcpApp,
  resolveMcpApp,
  setMcpAppStatus,
  setRemoteMcpTool,
  type CredentialBinding,
  type McpAppRef,
  type McpAppState,
  type ToolSnapshot,
} from "@/lib/gateway/remoteMcpApps";
import { probeRemoteMcp, type RemoteMcpProbe } from "@/lib/gateway/remoteMcpProbe";
import type { StoredAppRow } from "@/lib/gateway/registry";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmAtTerminal, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";
import { readSecretValue } from "@/lib/secretValue";
import { cliVersion } from "@/lib/version";
import type { GatewayCommandFlags } from "../flags";
import { applyGatewaySettings } from "../secret";

/** `mcp add`'s flags. */
export interface AddFlags extends GatewayCommandFlags {
  name?: string;
  auth?: RemoteMcpAuthKind;
  header?: string;
  secret?: string;
  risk?: RemoteMcpRiskDefault;
  description?: string;
  /** The credential's value from this environment variable (as `secret set --from-env`). */
  "from-env"?: string;
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
  /** `add`'s probe (tests). */
  fetch?: typeof fetch;
  /** Whether a person is at the terminal for `add` to offer the credential (default: canPromptInTerminal). */
  interactive?: boolean;
  /** `add`'s "set it now?" (default: the terminal's yes/no). */
  confirm?: Confirm;
  /** `add`'s credential value (default: `secret set`'s own reader: --from-env, else the hidden prompt). */
  readValue?: (name: string) => Promise<string>;
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
function accessLine(actorGranted: boolean, hasOwner: boolean): string {
  const who = actorGranted
    ? "You, the owners and the admins can use it"
    : hasOwner
      ? "The owners and the admins can use it"
      : "The owner gets it when they claim the Gateway";
  return `${who}; an admin grants others in Admin → Apps → Manage access.`;
}

/** The auth block as `--json` shows it: the kind, and the credential's NAME and header when it has them. */
function authData(auth: RemoteMcpAuth): Record<string, unknown> {
  return {
    kind: auth.kind,
    ...("secret" in auth ? { secret: auth.secret } : {}),
    ...(auth.kind === "header" ? { header: auth.header } : {}),
  };
}

/** A key or credential as the commands report it: its name, whether it is set, and a credential's pin. */
interface KeyState {
  name: string;
  set: boolean;
  /** A remote credential: pinned to this app's origin. */
  bound?: boolean;
  /** A remote credential: the origin it is pinned to, null when it has no pin yet. */
  boundOrigin?: string | null;
}

function keyState(
  name: string | null,
  gatewayNames: readonly string[],
  remote: RemoteMcpBlock | null,
  bindings: ReadonlyMap<string, CredentialBinding>,
): KeyState | null {
  if (!name) return null;
  const set = gatewayNames.includes(name);
  if (!remote) return { name, set };
  const pin = bindings.get(name)?.origin ?? null;
  return { name, set, bound: pin !== null && pin === originOf(remote.url), boundOrigin: pin };
}

/** The flags as the registry's auth block, refusing combinations that say two things. */
function authFromFlags(flags: AddFlags): Record<string, unknown> {
  const header = flags.header?.trim();
  const secret = flags.secret?.trim();
  const kind = flags.auth ?? (header ? "header" : secret ? "bearer" : "none");
  if (header && kind !== "header") {
    throw new EveryAppError(
      "REMOTE_MCP_INVALID",
      `--header names the header of --auth header\nWith --auth ${kind} the Gateway sends ${kind === "none" || kind === "oauth" ? "no credential" : "Authorization"}.`,
      { fix: "drop --header, or use --auth header" },
    );
  }
  if (kind === "header" && !header) {
    throw new EveryAppError(
      "REMOTE_MCP_INVALID",
      "--auth header needs --header <name>: the header the server reads the credential from",
      { fix: "add --header X-Api-Key (the name the server's docs give)" },
    );
  }
  if ((secret || flags["from-env"]) && (kind === "none" || kind === "oauth")) {
    const flag = secret ? "--secret" : "--from-env";
    throw new EveryAppError(
      "REMOTE_MCP_INVALID",
      `${flag} names a credential, and --auth ${kind} sends none`,
      { fix: `drop ${flag}, or use --auth bearer, header or basic` },
    );
  }
  return { kind, ...(secret ? { secret } : {}), ...(header ? { header } : {}) };
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

/** The probe's warnings for the app as added: what the operator may want to change. */
function probeWarnings(out: EventSink, id: string, url: string, auth: RemoteMcpAuth, probe: RemoteMcpProbe): void {
  const again = `${CLI} mcp remove ${id}, then ${CLI} mcp add ${url} --name ${id} --auth bearer`;
  const data = { probe };
  if (probe.outcome === "needs-credential" && probe.oauth) {
    const secret = remoteMcpSecretOf(auth);
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_WANTS_OAUTH",
      step: "mcp.probe",
      message: secret
        ? `${url} asks for OAuth\nThe Gateway doesn't sign in to MCP servers with OAuth yet; it sends ${secret} as you set it, which works only if the server also takes an API key.`
        : `${url} wants OAuth\nThe Gateway doesn't sign in to MCP servers with OAuth yet. If the server also takes an API key, add it with --auth bearer and set the key.`,
      data: secret ? data : { ...data, fix: again },
    });
    return;
  }
  if (probe.outcome === "needs-credential" && auth.kind === "none") {
    out.emit({
      type: "warning",
      code: "REMOTE_MCP_PROBE_FAILED",
      step: "mcp.probe",
      message: `${url} asks for a credential, and ${id} sends none\nThe Gateway's listing of its tools will fail the same way until it has one.`,
      data: { ...data, fix: again },
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

/** The Gateway's D1 predates migration 0011: the app is written, but served only after an update. */
async function warnIfOutdated(out: EventSink, connection: Connection, step: string): Promise<void> {
  if ((await remoteMcpTables(connection.db)).tools) return;
  out.emit({
    type: "warning",
    code: "REMOTE_MCP_GATEWAY_OUTDATED",
    step,
    message: "This Gateway predates MCP apps by URL\nIt serves a remote MCP server's tools once it is updated to this checkout.",
    data: { rerun: `${CLI} update` },
  });
}

export async function addServer(options: McpOptions<AddFlags>, url: string): Promise<void> {
  const { out, flags } = options;
  const auth = authFromFlags(flags);
  const readValue =
    options.readValue ?? ((name: string) => readSecretValue(name, { fromEnv: flags["from-env"], json: flags.json }));
  // --from-env is read before anything is written, so an empty variable (SECRET_EMPTY) changes nothing.
  const fromEnvValue = flags["from-env"]
    ? await readValue(
        flags.secret?.trim() || remoteMcpSecretName(flags.name?.trim() || remoteMcpIdFromUrl(url.trim()) || "remote"),
      )
    : null;
  const gateway = await connect(options);
  out.emit({ type: "step", step: "mcp.add", status: "start", message: `Adding ${url}...` });
  const added = await addRemoteMcpApp(gateway.db, {
    url,
    id: flags.name,
    description: flags.description,
    auth,
    risk: flags.risk,
    env: { gatewayUrl: gateway.gatewayUrl, appBaseDomain: gateway.install.appBaseDomain },
    deployer: gateway.deployer,
    organizationName: gateway.accountName ?? "My Organization",
    now: options.now?.(),
  });
  const { plan, organization } = added;
  const { app, remote } = plan;
  const id = app.appSlug;
  out.emit({
    type: "step",
    step: "mcp.add",
    status: "ok",
    message: `${app.name} is on for ${organization.name}`,
    data: { id, was: plan.kind },
  });
  await warnIfOutdated(out, gateway, "mcp.add");

  out.emit({ type: "step", step: "mcp.probe", status: "start", message: `Looking at ${remote.url}...` });
  const probe = await probeRemoteMcp(remote.url, { version: cliVersion, fetch: options.fetch });
  out.emit({ type: "step", step: "mcp.probe", status: "ok", message: probeLine(remote.url, probe), data: { probe } });
  probeWarnings(out, id, remote.url, remote.auth, probe);

  const origin = originOf(remote.url);
  const secret = remoteMcpSecretOf(remote.auth);
  let key: KeyState | null = null;
  if (secret) {
    let set = (await listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME)).includes(secret);
    let value = fromEnvValue;
    const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);
    if (value === null && !set && interactive) {
      const confirm = options.confirm ?? confirmAtTerminal;
      const now = await confirm(`Set ${secret} now?`, [
        `${app.name}'s credential (${remoteMcpAuthLabel(remote.auth)}${remote.auth.kind === "basic" ? ", entered as user:password" : ""}) is a Gateway setting.`,
        `The Gateway sends it to ${origin} and nowhere else. Later: ${CLI} secret set ${secret}`,
      ]);
      if (now) value = await readValue(secret);
    }
    if (value !== null) {
      // secret set's own path: the lease, one Gateway version, and the pin to this origin.
      await applyGatewaySettings(gateway, { [secret]: value }, { flags, out });
      set = true;
    }
    let bindings = await readCredentialBindings(gateway.db);
    if (set && !bindings.has(secret)) {
      // Set before this app existed: the operator adding the app that uses it pins it here.
      await bindRemoteMcpCredentials(gateway.db, [secret], gateway.deployer.actor, options.now?.());
      bindings = await readCredentialBindings(gateway.db);
    }
    key = keyState(secret, set ? [secret] : [], remote, bindings);
    if (!set) {
      out.emit({
        type: "warning",
        code: "PROVIDER_KEY_UNSET",
        step: "mcp.add",
        message: `${secret} isn't set on the Gateway\n${app.name}'s tools stay out of /mcp until it is.`,
        data: { fix: `${CLI} secret set ${secret}`, name: secret },
      });
    } else if (key?.boundOrigin && !key.bound) {
      out.emit({
        type: "warning",
        code: "REMOTE_MCP_SECRET_BOUND_ELSEWHERE",
        step: "mcp.add",
        message: `${secret} was set for ${key.boundOrigin}, not ${origin}\nThe Gateway sends a credential only to the origin it was set for; set it again for ${app.name}.`,
        data: { fix: `${CLI} secret set ${secret}`, name: secret, boundOrigin: key.boundOrigin },
      });
    }
  }

  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${id}_` };
  const keyLine =
    remote.auth.kind === "oauth"
      ? "It serves no tools yet: the Gateway doesn't sign in to MCP servers with OAuth this week."
      : !key
        ? "It takes no credential."
        : !key.set
          ? `${key.name} isn't set: ${CLI} secret set ${key.name}`
          : key.bound
            ? `${key.name} is set on the Gateway and pinned to ${origin}.`
            : `${key.name} is set, but for ${key.boundOrigin}: ${CLI} secret set ${key.name}`;
  const lines = [
    `${app.name} is on for ${organization.name}${plan.kind === "revived" ? " (added again, from scratch)" : ""}.`,
    accessLine(added.actorGranted, added.hasOwner),
    `Its tools are on ${mcp.url} as ${mcp.toolPrefix}<tool>; the Gateway lists them on first use.`,
    keyLine,
  ];
  const next = [
    ...(key && (!key.set || !key.bound) ? [{ command: `${CLI} secret set ${key.name}`, note: `${app.name}'s credential` }] : []),
    { command: `${CLI} mcp show ${id}`, note: "its tools, once the Gateway lists them" },
  ];
  finish(out, lines, {
    id,
    name: app.name,
    url: remote.url,
    auth: authData(remote.auth),
    risk: remote.risk,
    on: true,
    was: plan.kind,
    organization: { id: organization.id, name: organization.name },
    probe,
    key,
    mcp,
    granted: plan.grants.map((grant) => grant.userId),
    next,
  });
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

/** The Gateway setting a ref's app needs, and its remote block (null for a built-in). */
function keyOf(ref: McpAppRef): { name: string | null; remote: RemoteMcpBlock | null } {
  if (ref.kind === "builtin") return { name: providerAppKeySetting(ref.id as ProviderAppId), remote: null };
  const remote = ref.app ? remoteMcpBlockOf(ref.app) : null;
  return { name: remote ? remoteMcpSecretOf(remote.auth) : null, remote };
}

/** A ref's key state now: what `secret list` says, with a credential's pin. */
async function refKey(connection: Connection, ref: McpAppRef): Promise<KeyState | null> {
  const { name, remote } = keyOf(ref);
  if (!name) return null;
  const [names, bindings] = await Promise.all([
    listWorkerSecrets(connection.cf, GATEWAY_WORKER_NAME),
    remote ? readCredentialBindings(connection.db) : Promise.resolve(new Map<string, CredentialBinding>()),
  ]);
  return keyState(name, names, remote, bindings);
}

export async function turnOn(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
  out.emit({ type: "step", step: STEP, status: "start", message: `Turning ${id} on...` });
  let was: string;
  let organization: { id: string; name: string };
  let accessText: string | null = null;
  let granted: string[] = [];
  if (ref.kind === "builtin") {
    const result = await turnProviderAppOn(gateway.db, {
      id,
      deployer: gateway.deployer,
      organizationName: gateway.accountName ?? "My Organization",
      now: options.now?.(),
    });
    was = result.was;
    organization = result.organization;
    granted = result.plan.grants.map((grant) => grant.userId);
    if (was === "new" || was === "revived") accessText = accessLine(result.actorGranted, result.hasOwner);
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
  const key = await refKey(gateway, ref);
  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${id}_` };
  if (key && !key.set) {
    out.emit({
      type: "warning",
      code: "PROVIDER_KEY_UNSET",
      step: STEP,
      message: `${key.name} isn't set on the Gateway\n${name}'s tools ${ref.kind === "builtin" ? 'answer "not set up"' : "stay out of /mcp"} until it is.`,
      data: { fix: `${CLI} secret set ${key.name}`, name: key.name },
    });
  }
  const lines = [
    `${name} is on for ${organization.name}${was === "existing" ? " (it was already)" : was === "off" ? " (it was off; everyone's access was kept)" : ""}.`,
    ...(accessText ? [accessText] : []),
    `Its tools are on ${mcp.url} as ${mcp.toolPrefix}<tool>.`,
    ...(key
      ? [key.set ? `${key.name} is set on the Gateway.` : `${key.name} isn't set: ${CLI} secret set ${key.name}`]
      : []),
  ];
  finish(out, lines, {
    id,
    name,
    kind: ref.kind,
    on: true,
    was,
    organization: { id: organization.id, name: organization.name },
    key,
    mcp,
    granted,
    ...(key && !key.set
      ? { next: [{ command: `${CLI} secret set ${key.name}`, note: ref.kind === "builtin" ? "the provider's key" : `${name}'s credential` }] }
      : {}),
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
  const key = await refKey(gateway, ref);
  const lines = [
    `${message}.`,
    wasOn
      ? `Its tools leave /mcp within 30 seconds. Everyone's access, its tokens and its tools snapshot are kept: ${CLI} mcp on ${id} serves it again at once.`
      : "Nothing changed.",
    ...(live ? [`${CLI} mcp remove ${id} removes it for good.`] : []),
  ];
  finish(out, lines, { id, name, kind: ref.kind, on: false, wasOn, key });
}

export async function removeApp(options: McpOptions, id: string): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const ref = await resolveMcpApp(gateway.db, id);
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
  const key = await refKey(gateway, ref);
  const remote = keyOf(ref).remote;
  const lines = [
    `${message}.`,
    removed
      ? "Its tools left /mcp, and everyone's access to it, its tokens, its tools snapshot and its place in AI connections went with it."
      : "Nothing changed.",
    ...(key && key.set
      ? [
          key.boundOrigin
            ? `${key.name} stays on the Gateway, pinned to ${key.boundOrigin}: ${CLI} secret unset ${key.name} removes both.`
            : `${key.name} stays on the Gateway${ref.kind === "builtin" ? " (an app may use it too)" : ""}: ${CLI} secret unset ${key.name} removes it.`,
        ]
      : []),
    ...(ref.kind === "builtin"
      ? [`${CLI} mcp on ${id} adds it again, from scratch.`]
      : remote
        ? [`${CLI} mcp add ${remote.url} --name ${id} adds it again, from scratch.`]
        : []),
  ];
  finish(out, lines, { id, name, kind: ref.kind, removed, key });
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

/** The KEY cell: the name and whether it is set, none, or OAuth's "not supported yet". */
function keyCell(auth: RemoteMcpAuth | null, key: KeyState | null): string {
  if (auth?.kind === "oauth") return chalk.yellow("OAuth: not supported yet");
  if (!key) return chalk.dim("none");
  if (!key.set) return `${key.name} ${chalk.yellow("not set")}`;
  if (key.boundOrigin && !key.bound) return `${key.name} ${chalk.yellow(`set for ${key.boundOrigin}`)}`;
  return `${key.name} ${chalk.green("set")}`;
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
  const [entries, names, bindings] = await Promise.all([
    listMcpApps(gateway.db),
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
    readCredentialBindings(gateway.db),
  ]);
  const rows = entries.map((entry) => {
    const state = mcpAppState(entry, names, bindings);
    const key = keyState(entry.keyName, names, entry.remote, bindings);
    const tools = entry.snapshot && entry.snapshot.status !== "error" ? entry.snapshot.toolCount : null;
    return { entry, state, key, tools };
  });
  const table = formatTable(
    ["APP", "KIND", "STATUS", "TOOLS", "KEY"],
    rows.map(({ entry, state, key }) => [
      `${entry.id}  ${chalk.dim(entry.name)}`,
      entry.kind === "builtin" ? "built-in" : "remote",
      stateCell(state),
      !entry.snapshot
        ? chalk.dim("not listed yet")
        : entry.snapshot.status === "error"
          ? chalk.yellow("listing failed")
          : String(entry.snapshot.toolCount),
      keyCell(entry.remote?.auth ?? null, key),
    ]),
  );
  const next = rows.flatMap(({ entry, state, key }) => [
    ...(state === "not added" ? [{ command: `${CLI} mcp on ${entry.id}`, note: `offer ${entry.name}` }] : []),
    ...(key && entry.app && (!key.set || (key.boundOrigin && !key.bound))
      ? [{ command: `${CLI} secret set ${key.name}`, note: `${entry.name}'s ${entry.kind === "builtin" ? "key" : "credential"}` }]
      : []),
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
      apps: rows.map(({ entry, state, key, tools }) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        status: state,
        on: entry.app?.status === "active",
        ...(entry.remote
          ? {
              url: entry.remote.url,
              auth: authData(entry.remote.auth),
              supported: entry.remote.auth.kind !== "oauth",
            }
          : {}),
        tools,
        key,
        ...(entry.snapshot?.listedAt ? { lastListedAt: new Date(entry.snapshot.listedAt).toISOString() } : {}),
        ...(entry.snapshot?.lastError ? { lastError: entry.snapshot.lastError } : {}),
      })),
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
  const [names, bindings] = await Promise.all([
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
    readCredentialBindings(gateway.db),
  ]);
  const { name: keyName, remote } = keyOf(ref);
  const live = ref.app && ref.app.status !== "deleted" ? ref.app : null;
  const state = mcpAppState({ kind: ref.kind, app: live, remote, keyName }, names, bindings);
  const key = keyState(keyName, names, remote, bindings);
  const detail = live ? await readMcpAppDetail(gateway.db, { ...ref, app: live }, remote) : null;
  const mcp = { url: `${gateway.gatewayUrl}/mcp`, toolPrefix: `${id}_` };
  const added = live?.deployedAt
    ? `${live.deployedByActor ? `by ${live.deployedByActor}, ` : ""}${timeText(live.deployedAt)}`
    : null;

  const facts = [
    { label: "Kind", value: ref.kind === "builtin" ? "built-in (the Gateway's own)" : "remote" },
    { label: "Status", value: stateCell(state) },
    ...(remote
      ? [
          { label: "URL", value: remote.url },
          { label: "Auth", value: remoteMcpAuthLabel(remote.auth) },
          { label: "Risk", value: riskDefaultText(remote.risk) },
          { label: "Revision", value: String(remote.rev) },
        ]
      : []),
    ...(added ? [{ label: "Added", value: added }] : []),
    ...(key || remote?.auth.kind === "oauth"
      ? [{ label: ref.kind === "builtin" ? "Key" : "Credential", value: keyCell(remote?.auth ?? null, key) + (key?.bound ? chalk.dim(`, pinned to ${key.boundOrigin}`) : "") }]
      : []),
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
      ...(remote
        ? {
            url: remote.url,
            auth: authData(remote.auth),
            supported: remote.auth.kind !== "oauth",
            risk: remote.risk,
            rev: remote.rev,
            overrides: remote.tools,
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
      ...(key && live && (!key.set || (key.boundOrigin && !key.bound))
        ? { next: [{ command: `${CLI} secret set ${key.name}`, note: `${name}'s ${ref.kind === "builtin" ? "key" : "credential"}` }] }
        : state === "not added"
          ? { next: [{ command: `${CLI} mcp on ${id}`, note: `offer ${name}` }] }
          : {}),
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
      `Nothing to change about ${toolName}\nGive --risk read|write|destructive|annotations, --on or --off.`,
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
