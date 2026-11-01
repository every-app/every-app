/**
 * Where `secret set` gets a value (and `configure`, through the helpers
 * exported here), and the check a plain Gateway setting gets before
 * anything is written. A credential is typed at a hidden
 * prompt, piped in, or read from `--from-env`, and never shown. A plain
 * setting (`PLAIN_GATEWAY_SETTINGS` in the SDK: a sender, a switch, a
 * list of domains) is typed at a visible prompt under a line saying what
 * it takes, and a value the Gateway would ignore or misread (EMAIL_FROM
 * without an address, a switch that is neither on nor off) is refused
 * here, where it can be fixed, instead of in the Worker's logs. The
 * checks (`PLAIN_SETTINGS`) follow how the Gateway reads each setting;
 * a plain name with no check takes anything. An app's own plain setting
 * (`settings` in its manifest) is read the same way, checked against
 * what its entry says it takes (a URL, a number, one of a list).
 */
import { text } from "node:stream/consumers";
import {
  CAPABILITIES,
  EMAIL_PROVIDER_IDS,
  isPlainGatewaySetting,
  parseEmailSender,
  settingValueProblem,
  settingValueTakes,
  type Capability,
  type OAuthClientCapability,
  type PLAIN_GATEWAY_SETTINGS,
  type SettingValueRule,
} from "@every-app/sdk/internal";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { askSecret, askText, canPromptInTerminal } from "@/lib/output/prompt";
import { signInPlainSetting } from "@/lib/signinValues";

/** Where `secret set` reads its values: never the command line. */
enum SecretSource {
  /** `--from-env <VAR>`. */
  Env = "env",
  /** Piped in: stdin isn't a terminal. */
  Stdin = "stdin",
  /** A prompt at the terminal: hidden for a credential, visible for a plain setting. */
  Prompt = "prompt",
}

/** Where the values come from: --from-env, else stdin when it isn't a terminal, else a prompt. */
function secretSource(fromEnv: string | undefined): SecretSource {
  if (fromEnv) return SecretSource.Env;
  return process.stdin.isTTY ? SecretSource.Prompt : SecretSource.Stdin;
}

/**
 * Refuse more than one name for a source that holds one value
 * (--from-env, stdin), before anything else is checked.
 */
export function assertOneValueEnough(names: readonly string[], fromEnv: string | undefined): void {
  const source = secretSource(fromEnv);
  if (source === SecretSource.Prompt || names.length < 2) return;
  throw new EveryAppError(
    "SECRET_SEVERAL_NAMES",
    `${source === SecretSource.Env ? "--from-env" : "A piped value"} sets one secret at a time, and you named ${names.length}`,
    {
      fix: `run it once per name, e.g. ${
        source === SecretSource.Env
          ? `${CLI} secret set ${names[0]} --from-env ${fromEnv}`
          : `echo "$${names[0]}" | ${CLI} secret set ${names[0]}`
      }`,
    },
  );
}

/** What a plain Gateway setting takes, as the prompt says it and the check enforces it. */
interface PlainSetting {
  /** Completes "<NAME> takes …": the prompt's context line and the refusal's fix. */
  takes: string;
  /** Why a trimmed, non-empty value won't do (one sentence), or null when it will. */
  check?: (value: string) => string | null;
}

/** `a, b or c`. */
function either(values: readonly string[]): string {
  return values.length < 2 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

/** One of `values`; any case unless `exact` (the Gateway compares BROWSER_APP_INSTALLS as typed). */
function oneOf(values: readonly string[], { exact = false } = {}): (value: string) => string | null {
  return (value) =>
    values.includes(exact ? value : value.toLowerCase())
      ? null
      : `Not ${values.length > 2 ? "one of " : ""}${either(values)}.`;
}

/** Each entry of a comma or space separated list passes `entry`, and there is one. */
function listOf(
  entry: (value: string) => boolean,
  what: string,
): (value: string) => string | null {
  return (value) => {
    const entries = value.split(/[\s,]+/).filter(Boolean);
    const wrong = entries.find((candidate) => !entry(candidate));
    if (wrong !== undefined) return `"${wrong}" isn't ${what}.`;
    return entries.length > 0 ? null : `Name ${what}.`;
  };
}

/**
 * The spellings the Gateway's switches honour (its ON_VALUES and
 * OFF_VALUES): anything else turns MCP's switches off and leaves password
 * sign-in on, each with only a log line to say so.
 */
const SWITCH_VALUES = ["true", "false", "1", "0", "on", "off", "yes", "no"] as const;
/** An address the provider will take: one `@`, a dotted domain, no spaces or brackets. */
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** An email domain, as the Gateway's `readAutoJoinDomains` accepts it (lowercased, a leading `@` dropped). */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
/**
 * A DNS name, as the Gateway's `thirdPartyDomain` reads THIRD_PARTY_DOMAIN
 * (`DNS_NAME_PATTERN` in server/app-hosts.ts: lowercased, one trailing `.`
 * dropped, no `@`; the last label may be one character).
 */
const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
/** An Access application's AUD tag (`audienceList` in the Gateway). */
const AUD_TAG = /^[A-Za-z0-9._:-]{1,256}$/;
/** A path the AI proxy forwards beyond inference (`AI_ROUTE_PATTERN` in the Gateway). */
const AI_ROUTE = /^\/v1(\/[a-z0-9_-]+)+$/;
const MAX_AUDIT_RETENTION_DAYS = 3650;

const isDomain = (value: string): boolean => DOMAIN.test(value.toLowerCase().replace(/^@/, ""));
const isDnsName = (value: string): boolean => DNS_NAME.test(value.toLowerCase().replace(/\.$/, ""));

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A URL on a Cloudflare Access team domain, as the Gateway's `accessUrl`
 * (auth/cloudflare-access/config.ts) takes one: https on
 * `<team>.cloudflareaccess.com`, and nothing it refuses (user info, a
 * query, a fragment); null otherwise. Without the Gateway's loopback
 * allowance, which is for local dev only.
 */
function accessUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  return url.protocol === "https:" && TEAM_DOMAIN.test(url.hostname.toLowerCase()) ? url : null;
}

/** `<team>.cloudflareaccess.com`, with or without `https://`, as the Gateway's outer ring reads it. */
function isTeamDomain(value: string): boolean {
  const url = accessUrl(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  return url !== null && (url.pathname === "/" || url.pathname === "");
}

/**
 * What each plain Gateway setting takes, keyed by name, as the Gateway
 * reads it (apps/every-app-gateway/src: cloudflare-access/config.ts,
 * oauth-flag.ts, platform-policy.ts, deploy/gateway-app-installs.ts,
 * mcp-auth/maintenance.ts, toolbus/gateway-mcp.ts, ai-proxy.ts,
 * server/app-hosts.ts, server/events/target.ts). A name left out is a plain setting that takes
 * anything.
 */
const PLAIN_SETTINGS: Partial<Record<(typeof PLAIN_GATEWAY_SETTINGS)[number], PlainSetting>> = {
  EMAIL_FROM: {
    takes: "an address, or Name <address> (with EMAIL_FROM_NAME set, unless the name is in it)",
    check: (value) => {
      const sender = parseEmailSender(value, "sender");
      return sender && ADDRESS.test(sender.address)
        ? null
        : `"${value}" isn't an address or Name <address>.`;
    },
  },
  EMAIL_FROM_NAME: { takes: "the sender's display name, e.g. Acme Support" },
  EMAIL_PROVIDER: {
    takes: `${either(EMAIL_PROVIDER_IDS)}: which provider sends when both are set up`,
    check: oneOf(EMAIL_PROVIDER_IDS),
  },
  EMAIL_PASSWORD_SIGN_IN: {
    takes:
      "true or false; false turns password sign-in off (only while Cloudflare Access sign-in is on)",
    check: oneOf(SWITCH_VALUES),
  },
  AI_PROXY_EXTRA_ROUTES: {
    takes: "/v1 paths beyond inference the AI proxy may forward, comma separated, e.g. /v1/files",
    check: listOf((route) => AI_ROUTE.test(route), "a /v1/... path"),
  },
  MCP_OAUTH_ENABLED: {
    takes: "true or false; false turns the OAuth server for MCP clients off",
    check: oneOf(SWITCH_VALUES),
  },
  MCP_DCR_ENABLED: {
    takes: "true or false; false turns dynamic client registration off",
    check: oneOf(SWITCH_VALUES),
  },
  MCP_ALLOWED_ORIGINS: {
    takes: "browser origins allowed to call /mcp, comma separated, e.g. http://localhost:6274",
    check: listOf((origin) => httpUrl(origin) !== null, "an http or https URL"),
  },
  MCP_AUDIT_RETENTION_DAYS: {
    takes: `days of MCP tool-call audit rows to keep: a whole number from 1 to ${MAX_AUDIT_RETENTION_DAYS}`,
    check: (value) =>
      /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_AUDIT_RETENTION_DAYS
        ? null
        : `Not a whole number from 1 to ${MAX_AUDIT_RETENTION_DAYS}.`,
  },
  CLOUDFLARE_ACCESS_OIDC_ISSUER: {
    takes: "https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>",
    check: (value) => {
      const url = accessUrl(value);
      return url && /^\/cdn-cgi\/access\/sso\/oidc\/[^/]+\/?$/.test(url.pathname)
        ? null
        : `"${value}" isn't an Access for SaaS issuer URL.`;
    },
  },
  CLOUDFLARE_ACCESS_OIDC_CLIENT_ID: { takes: "the Access for SaaS application's client id" },
  CLOUDFLARE_ACCESS_OIDC_LABEL: {
    takes: 'the sign-in button\'s label ("Continue with <label>"), at most 40 characters',
  },
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: {
    takes: "<team>.cloudflareaccess.com",
    check: (value) => (isTeamDomain(value) ? null : `"${value}" isn't <team>.cloudflareaccess.com.`),
  },
  CLOUDFLARE_ACCESS_AUD: {
    takes: "the AUD tag of the Access application on the Gateway's host (several: comma separated)",
    check: listOf((tag) => AUD_TAG.test(tag), "an AUD tag"),
  },
  CLOUDFLARE_ACCESS_APPS_AUD: {
    takes: "the AUD tag of the Access application on the apps' hosts (several: comma separated)",
    check: listOf((tag) => AUD_TAG.test(tag), "an AUD tag"),
  },
  CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: {
    takes: "email domains whose people join without an invitation, comma separated, e.g. example.com",
    check: listOf(isDomain, "a domain like example.com"),
  },
  CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN: {
    takes: `everyone (anyone the outer ring admits joins); to turn it off: ${CLI} secret unset CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN`,
    check: oneOf(["everyone"]),
  },
  HOSTED_OPEN_SIGNUP: {
    takes: "true or false; false keeps a hosted Gateway's sign-up invite-only",
    check: oneOf(["true", "false"]),
  },
  BROWSER_APP_INSTALLS: {
    takes: "on or off, in lowercase; on lets the Gateway install apps itself (off until then), off stops it",
    check: oneOf(["on", "off"], { exact: true }),
  },
  EVENTS_ALLOW_PRIVATE_TARGETS: {
    takes: "true or false, in lowercase; true lets event webhooks reach http: URLs and private host names",
    check: oneOf(["true", "false"], { exact: true }),
  },
  DISPATCH_NAMESPACE: {
    takes: "the Workers for Platforms namespace third-party Workers go into (hosted Gateway only)",
  },
  THIRD_PARTY_DOMAIN: {
    takes: "the registrable domain third-party apps are named on (hosted Gateway only)",
    check: (value) => (isDnsName(value) ? null : `"${value}" isn't a domain like example.com.`),
  },
};

/**
 * A plain setting's rule: an app's own plain setting's (`settings` in its
 * manifest, `rule`), else the table above, else a sign-in provider's
 * (lib/signinValues.ts).
 */
function plainSetting(name: string, rule?: SettingValueRule): PlainSetting | undefined {
  if (rule) return { takes: settingValueTakes(rule), check: (value) => settingValueProblem(rule, value) };
  return (
    (PLAIN_SETTINGS as Partial<Record<string, PlainSetting>>)[name] ??
    signInPlainSetting(name)
  );
}

/** The lines above a plain setting's prompt: what it takes. */
export function plainContext(name: string, rule?: SettingValueRule): string[] {
  const setting = plainSetting(name, rule);
  return setting ? [`Takes ${setting.takes}`] : [];
}

/**
 * Why `value`, as typed, won't do for the plain setting `name`: one
 * sentence to re-ask with, or null when the Gateway (or, with `rule`,
 * the app) will read it.
 */
export function plainValueProblem(name: string, value: string, rule?: SettingValueRule): string | null {
  if (!value.trim()) return "Enter a value.";
  return plainSetting(name, rule)?.check?.(value.trim()) ?? null;
}

/**
 * A plain setting's value from --from-env or stdin, trimmed, refused with
 * SETTING_VALUE_INVALID when the Gateway wouldn't read it: the headline
 * names the setting and the value (a plain value is nothing to hide), the
 * detail says what's wrong with it, and the fix what it takes.
 */
export function checkedPlainValue(name: string, value: string, rule?: SettingValueRule): string {
  const trimmed = value.trim();
  const problem = plainValueProblem(name, trimmed, rule);
  if (problem === null) return trimmed;
  const setting = plainSetting(name, rule);
  const shown = trimmed.replace(/\s+/g, " ").slice(0, 64);
  throw new EveryAppError(
    "SETTING_VALUE_INVALID",
    `${name} can't be "${shown}"\n${problem}`,
    {
      ...(setting ? { fix: `use ${setting.takes}` } : {}),
      data: { name },
    },
  );
}

/**
 * A secret's value from `--from-env <VAR>`, stdin when something is piped
 * in, or a prompt at a terminal: never from the command line, where it
 * would land in shell history and the process list. A credential's prompt
 * is hidden; a plain Gateway setting's (`isPlainGatewaySetting`) shows what
 * is typed under a line saying what the setting takes, and every source's
 * value for one is trimmed and checked before anything is written.
 */
export async function readSecretValue(
  name: string,
  options: { fromEnv?: string; json?: boolean; rule?: SettingValueRule | undefined },
): Promise<string> {
  const { rule } = options;
  const plain = rule !== undefined || isPlainGatewaySetting(name);
  const variable = options.fromEnv;
  const source = secretSource(variable);
  if (source === SecretSource.Env) {
    const raw = process.env[variable!];
    // A plain value is read trimmed, so blank counts as unset, as for a credential.
    const value = plain ? raw?.trim() : raw;
    if (!value) {
      throw new EveryAppError("SECRET_EMPTY", `$${variable} is empty or not set`, {
        fix: `export ${variable} first, or name another variable with --from-env`,
      });
    }
    return plain ? checkedPlainValue(name, value, rule) : value;
  }
  if (source === SecretSource.Stdin) {
    // One value, its trailing newline (echo's) dropped.
    const raw = (await text(process.stdin)).replace(/\r?\n$/, "");
    const value = plain ? raw.trim() : raw;
    if (value) return plain ? checkedPlainValue(name, value, rule) : value;
  }
  if (source === SecretSource.Stdin || !canPromptInTerminal(options.json ?? false)) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      `Can't ask for ${name}'s value without a terminal\nOr pipe it in: echo "$${name}" | ${CLI} secret set ${name}`,
      { rerun: `${CLI} secret set ${name} --from-env ${name}` },
    );
  }
  return askSettingValue(name, { question: plain ? name : `Value for ${name}`, rule });
}

/**
 * Ask the person at the terminal for `name`'s value, as `secret set` does:
 * hidden for a credential, visible and checked for a plain setting (a
 * Gateway one, or with `rule` one of the app's own `settings`), under a
 * line saying what it takes. With `optional`, Enter on nothing answers ""
 * (the caller sets nothing). Trimmed.
 */
export async function askSettingValue(
  name: string,
  {
    question = name,
    optional = false,
    rule,
  }: { question?: string; optional?: boolean; rule?: SettingValueRule | undefined } = {},
): Promise<string> {
  if (rule || isPlainGatewaySetting(name)) {
    const value = await askText(question, {
      context: plainContext(name, rule),
      validate: (typed) => (optional && !typed.trim() ? null : plainValueProblem(name, typed, rule)),
    });
    return value.trim();
  }
  return (await askSecret(question, { optional })).trim();
}
