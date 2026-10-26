/**
 * `everyapp signin add|list|show|remove`: the sign-in providers a Gateway
 * offers beside passwords ("Continue with Google"), from the catalog in
 * packages/sdk/src/internal/signInProviders.ts. A provider is on when the
 * Gateway Worker holds every required setting of its `<ID>_SIGNIN_<FIELD>`
 * family (docs/runbooks/sign-in-providers.md).
 *
 * The settings are Worker secrets written only here (or by `secret set`),
 * under the Cloudflare login, never from the admin UI or an agent
 * connection: a stolen session can't add a way in (threat model B10). A
 * value never comes from the command line: the client secret is read from
 * `--client-secret-from-env VAR` or a hidden prompt; the plain ones (a
 * client id, the issuer, the label, the tenant) from flags or a visible
 * prompt, checked as the Gateway reads them (lib/signinValues.ts) before
 * anything is written. `add` writes the whole family in one
 * `applyGatewaySettings` call (one Worker version under the lease, as
 * `secret set`), `remove` removes it the same way; `list` and `show` read
 * names only, never values.
 */
import { stripVTControlCharacters } from "node:util";
import {
  isSignInProviderId,
  SIGN_IN_PROVIDER_IDS,
  SIGN_IN_PROVIDER_LIST,
  SIGN_IN_PROVIDERS,
  signInCallbackUrl,
  signInProviderState,
  type SignInProvider,
  type SignInProviderState,
  type SignInSetting,
  type SignInSettingRole,
} from "@every-app/sdk/internal";
import chalk from "chalk";
import { listGatewaySecretNames, SKILL_DIR } from "@/lib/app/settings";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { operatorActor, queueEventFromCli } from "@/lib/gateway/events";
import { installOrganization, type Deployer } from "@/lib/gateway/registry";
import type { D1Database } from "@/lib/cf/d1";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { askSecret, askText, canPromptInTerminal, confirmUnlessYes, tellPerson, type Confirm } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { listed } from "@/lib/output/text";
import { signInValueProblem, signInValueTakes } from "@/lib/signinValues";
import type { GatewayCommandFlags } from "../flags";
import { applyGatewaySettings } from "../secret";

/** `signin add`'s flags: one per setting role, the secret's only through an environment variable. */
export interface AddFlags extends GatewayCommandFlags {
  "client-id"?: string;
  "client-secret-from-env"?: string;
  issuer?: string;
  label?: string;
  tenant?: string;
}

/** `signin remove`'s flags. */
interface RemoveFlags extends GatewayCommandFlags {
  yes?: boolean;
}

/** What the handlers take from the command line, and the seams tests use. */
export interface SigninOptions<Flags extends GatewayCommandFlags = GatewayCommandFlags> {
  flags: Flags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  /** Whether a person is at the terminal to be asked (default: canPromptInTerminal). */
  interactive?: boolean;
  /** `remove`'s question (default: the terminal's yes/no). */
  confirm?: Confirm;
  /**
   * `add`'s value for a setting no flag gave, at the terminal (default: a
   * visible prompt for a plain setting, a hidden one for the secret). An
   * empty answer leaves the setting as it is; it is offered only when
   * `canKeep` (an optional setting, or one set already).
   */
  readValue?: (setting: SignInSetting, asked: { canKeep: boolean; set: boolean }) => Promise<string>;
}

export async function add(flags: AddFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => addProvider({ flags, out }, id));
}

export async function list(flags: GatewayCommandFlags): Promise<void> {
  await runCommand(flags, (out) => listProviders({ flags, out }));
}

export async function show(flags: GatewayCommandFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => showProvider({ flags, out }, id));
}

export async function remove(flags: RemoveFlags, id: string): Promise<void> {
  await runCommand(flags, (out) => removeProvider({ flags, out }, id));
}

function connect({ flags, out, createCf }: SigninOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

/** The catalog entry for `id`, or SIGNIN_UNKNOWN_PROVIDER naming the ids there are. */
function providerOf(id: string): SignInProvider {
  const wanted = id.trim().toLowerCase();
  if (isSignInProviderId(wanted)) return SIGN_IN_PROVIDERS[wanted];
  throw new EveryAppError(
    "SIGNIN_UNKNOWN_PROVIDER",
    `${id} isn't a sign-in provider\nThe Gateway offers ${listed([...SIGN_IN_PROVIDER_IDS])}; oidc is any OpenID Connect issuer (Okta, Entra ID, Keycloak, Auth0…).`,
    { rerun: `${CLI} signin list`, data: { providers: [...SIGN_IN_PROVIDER_IDS] } },
  );
}

/**
 * `signin_provider.added` or `.removed` (the outbox, lib/gateway/events.ts)
 * on the install organization, whose Gateway it is: queued once the
 * settings are written, only when the provider went on (or off), so a
 * rerun that rotates a secret queues nothing. The data names the provider
 * and its label, never a setting.
 */
async function queueSignInEvent(
  db: D1Database,
  deployer: Deployer,
  type: "signin_provider.added" | "signin_provider.removed",
  provider: SignInProvider,
): Promise<void> {
  const found = await installOrganization(db);
  if (!found) return;
  const statements = await queueEventFromCli(db, {
    organizationId: found.organization.id,
    type,
    actor: operatorActor(deployer),
    data: { provider: provider.id, label: provider.label },
  });
  if (statements.length > 0) await db.run(statements);
}

/** "Sign in with Google". */
const titleOf = (provider: SignInProvider) => `Sign in with ${provider.label}`;

/** The guide's path in an app that has the everyapp skill. */
const guideOf = (provider: SignInProvider) => `${SKILL_DIR}/${provider.setup}`;

/** The status as the commands say it: on, needs setup (the SDK's incomplete) or off. */
type Status = "on" | "needs setup" | "off";
const statusOf = (state: SignInProviderState): Status => (state.status === "incomplete" ? "needs setup" : state.status);

function statusCell(status: Status): string {
  return status === "on" ? chalk.green("on") : status === "needs setup" ? chalk.yellow("needs setup") : chalk.dim("off");
}

/** A done event: the message plain, the first line bright and the rest dim for a person. */
function finish(out: EventSink, lines: readonly string[], data: Record<string, unknown>): void {
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data,
  });
}

/** The flag that gives a setting of `role` (the secret's names the variable holding it). */
const FLAG_OF: Readonly<Record<SignInSettingRole, string>> = {
  clientId: "--client-id",
  clientSecret: "--client-secret-from-env",
  issuer: "--issuer",
  label: "--label",
  tenant: "--tenant",
};

/** What the flag's value is, for a rerun's placeholder. */
const PLACEHOLDER_OF: Readonly<Record<SignInSettingRole, string>> = {
  clientId: "<client id>",
  clientSecret: "<VAR>",
  issuer: "<issuer url>",
  label: "<button text>",
  tenant: "<tenant id>",
};

/** The value each plain flag gives, by role. */
function plainFlagValues(flags: AddFlags): Partial<Record<SignInSettingRole, string>> {
  return {
    clientId: flags["client-id"],
    issuer: flags.issuer,
    label: flags.label,
    tenant: flags.tenant,
  };
}

/** A shell word for a rerun: as is when it needs no quoting. */
const shellWord = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/**
 * A value refused as the Gateway would refuse it: the issuer and the
 * tenant under their own codes, the label as any plain setting's.
 */
function refuseValue(setting: SignInSetting, value: string, problem: string): never {
  const shown = value.replace(/\s+/g, " ").slice(0, 80);
  const takes = signInValueTakes(setting.role);
  const code =
    setting.role === "issuer" ? "SIGNIN_ISSUER_INVALID" : setting.role === "tenant" ? "SIGNIN_TENANT_INVALID" : "SETTING_VALUE_INVALID";
  throw new EveryAppError(code, `${setting.name} can't be "${shown}"\n${problem}`, {
    ...(takes ? { fix: `use ${takes}` } : {}),
    data: { name: setting.name },
  });
}

/** `value` trimmed and checked for `setting`; refused when the Gateway wouldn't read it. */
function checked(setting: SignInSetting, value: string): string {
  const trimmed = value.trim();
  const problem = signInValueProblem(setting.role, trimmed);
  if (problem) refuseValue(setting, trimmed, problem);
  return trimmed;
}

/** The terminal's question for a setting: visible for a plain one, hidden for the secret. */
async function askAtTerminal(setting: SignInSetting, { canKeep, set }: { canKeep: boolean; set: boolean }): Promise<string> {
  const takes = signInValueTakes(setting.role);
  const keep = set ? "Set already: Enter keeps it." : canKeep ? "Optional: Enter leaves it unset." : null;
  const context = [setting.what, ...(takes ? [`Takes ${takes}`] : []), ...(keep ? [keep] : [])];
  if (!setting.plain) {
    return (await askSecret(`${setting.name}`, { context, optional: canKeep })).trim();
  }
  const value = await askText(setting.name, {
    context,
    validate: (typed) => {
      const trimmed = typed.trim();
      if (!trimmed) return canKeep ? null : "Enter a value.";
      return signInValueProblem(setting.role, trimmed);
    },
  });
  return value.trim();
}

export async function addProvider(options: SigninOptions<AddFlags>, id: string): Promise<void> {
  const { out, flags } = options;
  const provider = providerOf(id);
  const roles = new Set(provider.settings.map((setting) => setting.role));

  // Everything the command line says is checked before anything connects.
  const fromFlags = plainFlagValues(flags);
  const notApplicable = (Object.keys(fromFlags) as SignInSettingRole[])
    .filter((role) => fromFlags[role] !== undefined && !roles.has(role))
    .map((role) => FLAG_OF[role]);
  if (notApplicable.length > 0) {
    const owners = notApplicable.map((flag) => (flag === "--tenant" ? "microsoft" : "oidc"));
    throw new EveryAppError(
      "SIGNIN_FLAG_NOT_APPLICABLE",
      `${listed(notApplicable)} ${notApplicable.length === 1 ? "isn't a setting" : "aren't settings"} of ${titleOf(provider)}\n${listed(notApplicable.map((flag, index) => `${flag} is ${owners[index]}'s`))}; ${provider.id} reads ${listed(provider.settings.map((setting) => setting.name))}.`,
      { fix: `drop ${listed(notApplicable)}`, data: { provider: provider.id, flags: notApplicable } },
    );
  }
  const given = new Map<string, string>();
  for (const setting of provider.settings) {
    if (setting.role === "clientSecret") continue;
    const value = fromFlags[setting.role]?.trim();
    if (value) given.set(setting.name, checked(setting, value));
  }
  const secretSetting = provider.settings.find((setting) => setting.role === "clientSecret")!;
  const variable = flags["client-secret-from-env"]?.trim();
  if (variable) {
    const value = process.env[variable]?.trim();
    if (!value) {
      throw new EveryAppError("SECRET_EMPTY", `$${variable} is empty or not set`, {
        fix: `export ${variable} first, or name another variable with --client-secret-from-env`,
        data: { name: secretSetting.name },
      });
    }
    given.set(secretSetting.name, value);
  }

  const gateway = await connect(options);
  const names = new Set(await listGatewaySecretNames(gateway.cf));
  const callbackUrl = signInCallbackUrl(gateway.gatewayUrl, provider.id);
  const interactive = options.interactive ?? canPromptInTerminal(flags.json ?? false);

  // A required setting neither given nor set already can only be asked for.
  const unanswered = provider.settings.filter((setting) => setting.required && !given.has(setting.name) && !names.has(setting.name));
  if (unanswered.length > 0 && !interactive) {
    const rerun = [
      `${CLI} signin add ${provider.id}`,
      ...provider.settings.flatMap((setting) => {
        if (setting.role === "clientSecret") {
          return given.has(setting.name) || unanswered.includes(setting) ? [`${FLAG_OF.clientSecret} ${variable || PLACEHOLDER_OF.clientSecret}`] : [];
        }
        const value = given.get(setting.name);
        if (value) return [`${FLAG_OF[setting.role]} ${shellWord(value)}`];
        return unanswered.includes(setting) ? [`${FLAG_OF[setting.role]} ${PLACEHOLDER_OF[setting.role]}`] : [];
      }),
      ...(flags.gateway ? [`--gateway ${shellWord(flags.gateway)}`] : []),
      ...(flags["account-id"] ? [`--account-id ${shellWord(flags["account-id"])}`] : []),
      ...(flags.json ? ["--json"] : []),
    ].join(" ");
    throw new EveryAppError(
      "SIGNIN_VALUE_REQUIRED",
      `${titleOf(provider)} needs ${listed(unanswered.map((setting) => setting.name))}, and there's no terminal to ask at\nGive ${listed(unanswered.map((setting) => FLAG_OF[setting.role]))} (the secret from an environment variable, never the command line), or run this at a terminal.`,
      {
        rerun,
        data: {
          provider: provider.id,
          missing: unanswered.map((setting) => setting.name),
          flags: unanswered.map((setting) => FLAG_OF[setting.role]),
          callbackUrl,
        },
      },
    );
  }

  if (interactive) {
    tellPerson(
      [
        chalk.bold(titleOf(provider)),
        `Create the ${provider.appNoun} at ${provider.console}`,
        `Register this redirect URL with it: ${chalk.cyan(callbackUrl)}`,
        chalk.dim(`Guide: ${guideOf(provider)}`),
      ].join("\n"),
    );
    const readValue = options.readValue ?? askAtTerminal;
    for (const setting of provider.settings) {
      if (given.has(setting.name)) continue;
      const set = names.has(setting.name);
      const value = (await readValue(setting, { canKeep: !setting.required || set, set })).trim();
      if (value) given.set(setting.name, setting.plain ? checked(setting, value) : value);
      else if (setting.required && !set) {
        throw new EveryAppError("SIGNIN_VALUE_REQUIRED", `${titleOf(provider)} needs ${setting.name}\nNothing was changed.`, {
          rerun: `${CLI} signin add ${provider.id}`,
          data: { provider: provider.id, missing: [setting.name], flags: [FLAG_OF[setting.role]], callbackUrl },
        });
      }
    }
  }

  // Every setting given, in catalog order, in one Gateway version.
  const changes = Object.fromEntries(
    provider.settings.filter((setting) => given.has(setting.name)).map((setting) => [setting.name, given.get(setting.name)!]),
  );
  const written = Object.keys(changes);
  const kept = provider.settings.filter((setting) => !given.has(setting.name) && names.has(setting.name)).map((setting) => setting.name);
  const wasOn = signInProviderState(provider, (name) => names.has(name)).status === "on";
  const signInUrl = `${gateway.gatewayUrl}/sign-in`;
  if (written.length > 0) {
    out.emit({ type: "step", step: "signin.add", status: "start", message: `Setting ${listed(written)} on the Gateway...` });
    await applyGatewaySettings(gateway, changes, { flags, out });
    if (!wasOn) await queueSignInEvent(gateway.db, gateway.deployer, "signin_provider.added", provider);
    out.emit({ type: "step", step: "signin.add", status: "ok", message: `${titleOf(provider)} is on`, data: { id: provider.id } });
  }
  const lines = [
    written.length > 0 ? `${titleOf(provider)} is on.` : `${titleOf(provider)} was on already; nothing changed.`,
    `Redirect URL (registered with the ${provider.appNoun}): ${callbackUrl}`,
    ...(written.length > 0 ? [`Set ${listed(written)}${kept.length > 0 ? `; kept ${listed(kept)} as it was` : ""}.`] : []),
    ...provider.notes,
    `Sign in at ${signInUrl}: "Continue with ${provider.label}" is there on the next request, for members and invited addresses.`,
    `Guide: ${guideOf(provider)}`,
  ];
  finish(out, lines, {
    id: provider.id,
    label: provider.label,
    status: "on",
    changed: written.length > 0,
    set: written,
    kept,
    callbackUrl,
    signInUrl,
    notes: provider.notes,
    setup: provider.setup,
  });
}

/**
 * A provider's state from the names held, `missing` only while it needs
 * setup (the catalog's contract: empty when on or off; an off provider's
 * settings are all in `show`).
 */
function stateOf(provider: SignInProvider, held: ReadonlySet<string>): SignInProviderState {
  const state = signInProviderState(provider, (name) => held.has(name));
  return state.status === "incomplete" ? state : { ...state, missing: [] };
}

/** Each catalog provider's state, from the names the Gateway Worker holds. */
function statesOf(names: readonly string[]) {
  const held = new Set(names);
  return SIGN_IN_PROVIDER_LIST.map((provider) => ({
    provider,
    state: stateOf(provider, held),
  }));
}

export async function listProviders(options: SigninOptions): Promise<void> {
  const { out } = options;
  const gateway = await connect(options);
  const rows = statesOf(await listGatewaySecretNames(gateway.cf));
  const table = formatTable(
    ["PROVIDER", "STATUS", "SETTINGS"],
    rows.map(({ provider, state }) => {
      const status = statusOf(state);
      return [
        `${provider.id}  ${chalk.dim(provider.label)}`,
        statusCell(status),
        status === "needs setup"
          ? `${chalk.yellow("missing")} ${state.missing.join(", ")}`
          : status === "on"
            ? chalk.dim(state.set.join(", "))
            : chalk.dim("none set"),
      ];
    }),
  );
  const onCount = rows.filter(({ state }) => state.status === "on").length;
  const needing = rows.filter(({ state }) => state.status === "incomplete");
  const summary = `${onCount} of ${rows.length} sign-in providers on`;
  out.emit({
    type: "done",
    message: summary,
    display: [
      ...table,
      "",
      chalk.dim(
        needing.length > 0
          ? `A provider that needs setup is off until it has every required setting: ${CLI} signin add <id>`
          : `Turn one on: ${CLI} signin add <id> (${CLI} signin show <id> says where to make its OAuth app).`,
      ),
    ].join("\n"),
    data: {
      providers: rows.map(({ provider, state }) => ({
        id: provider.id,
        label: provider.label,
        status: statusOf(state),
        missing: state.missing,
        set: state.set,
        callbackUrl: signInCallbackUrl(gateway.gatewayUrl, provider.id),
        setup: provider.setup,
      })),
      signInUrl: `${gateway.gatewayUrl}/sign-in`,
      ...(needing.length > 0
        ? { next: needing.map(({ provider }) => ({ command: `${CLI} signin add ${provider.id}`, note: `finish ${titleOf(provider)}` })) }
        : {}),
    },
  });
}

export async function showProvider(options: SigninOptions, id: string): Promise<void> {
  const { out } = options;
  const provider = providerOf(id);
  const gateway = await connect(options);
  const held = new Set(await listGatewaySecretNames(gateway.cf));
  const state = stateOf(provider, held);
  const status = statusOf(state);
  const callbackUrl = signInCallbackUrl(gateway.gatewayUrl, provider.id);
  const settings = provider.settings.map((setting) => ({
    name: setting.name,
    role: setting.role,
    required: setting.required,
    plain: setting.plain,
    what: setting.what,
    set: held.has(setting.name),
  }));
  const facts = [
    { label: "Status", value: statusCell(status) + (status === "needs setup" ? chalk.dim(` (missing ${listed(state.missing)})`) : "") },
    { label: "Console", value: provider.console },
    { label: "Create", value: provider.appNoun },
    { label: "Redirect URL", value: callbackUrl },
    { label: "Scopes", value: provider.scopes.join(" ") },
    { label: "Email", value: provider.emailClaim },
    { label: "Guide", value: guideOf(provider) },
  ];
  const settingRows = formatTable(
    ["SETTING", "", "SET", "WHAT IT HOLDS"],
    settings.map((setting) => [
      setting.name,
      chalk.dim(setting.required ? "required" : "optional"),
      setting.set ? chalk.green("set") : setting.required ? chalk.yellow("not set") : chalk.dim("not set"),
      chalk.dim(setting.what),
    ]),
  );
  const title = `${titleOf(provider)} (${provider.id})`;
  out.emit({
    type: "done",
    message: stripVTControlCharacters([title, ...formatFacts(facts)].join("\n")),
    display: [
      chalk.bold(title),
      ...formatFacts(facts),
      "",
      ...settingRows,
      ...(provider.notes.length > 0 ? ["", ...provider.notes.map((note) => chalk.dim(`· ${note}`))] : []),
    ].join("\n"),
    data: {
      id: provider.id,
      label: provider.label,
      status,
      missing: state.missing,
      set: state.set,
      console: provider.console,
      appNoun: provider.appNoun,
      callbackUrl,
      scopes: provider.scopes,
      emailClaim: provider.emailClaim,
      settings,
      notes: provider.notes,
      setup: provider.setup,
      ...(status !== "on" ? { next: [{ command: `${CLI} signin add ${provider.id}`, note: `turn ${titleOf(provider)} on` }] } : {}),
    },
  });
}

export async function removeProvider(options: SigninOptions<RemoveFlags>, id: string): Promise<void> {
  const { out, flags } = options;
  const provider = providerOf(id);
  const gateway = await connect(options);
  const held = new Set(await listGatewaySecretNames(gateway.cf));
  const toRemove = provider.settings.filter((setting) => held.has(setting.name)).map((setting) => setting.name);
  if (toRemove.length === 0) {
    finish(out, [`${titleOf(provider)} isn't set up; nothing changed.`], { id: provider.id, removed: [] });
    return;
  }
  await confirmUnlessYes({
    yes: flags.yes,
    interactive: options.interactive ?? canPromptInTerminal(flags.json ?? false),
    confirm: options.confirm,
    question: `Turn ${titleOf(provider)} off?`,
    unattended: `Turning ${titleOf(provider)} off needs confirmation at a terminal, or --yes`,
    context: [
      `Removes ${listed(toRemove)} from the Gateway: the button leaves the sign-in page on the next request.`,
      "People who signed in with it keep their accounts and sign in another way.",
    ],
    cancelled: `Cancelled. ${titleOf(provider)} stays as it was.`,
    data: { provider: provider.id, names: toRemove },
  });
  out.emit({ type: "step", step: "signin.remove", status: "start", message: `Removing ${listed(toRemove)} from the Gateway...` });
  await applyGatewaySettings(gateway, Object.fromEntries(toRemove.map((name) => [name, null])), { flags, out });
  if (signInProviderState(provider, (name) => held.has(name)).status === "on") {
    await queueSignInEvent(gateway.db, gateway.deployer, "signin_provider.removed", provider);
  }
  out.emit({ type: "step", step: "signin.remove", status: "ok", message: `${titleOf(provider)} is off`, data: { id: provider.id } });
  finish(
    out,
    [
      `${titleOf(provider)} is off.`,
      `Removed ${listed(toRemove)}.`,
      "People who signed in with it keep their accounts: they sign in with a password (Forgot password sets one), another provider or Cloudflare Access.",
      `Delete the ${provider.appNoun} at ${provider.console} too: a client the Gateway no longer holds is still a client.`,
    ],
    { id: provider.id, removed: toRemove },
  );
}
