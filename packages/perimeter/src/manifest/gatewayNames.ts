/**
 * The names one Gateway and its apps take in a Cloudflare account, all from
 * the Gateway's name (docs/design/multi-gateway.md). A Cloudflare account
 * may hold several Gateways; every account-wide name (Workers, D1, KV,
 * queues, R2, Vectorize, AI Gateways, Secrets Store secrets, Workflows,
 * Analytics Engine datasets) must say whose it is, so that a deploy of one
 * never takes another's and a teardown of one never matches another's.
 *
 * The default Gateway (no name) keeps exactly the names it always had:
 *
 *   Gateway Worker, D1      every-app-gateway
 *   OAuth KV                every-app-gateway-OAUTH_KV
 *   activation queue        every-app-gateway-activate
 *   app Worker              every-<orgKey>-<appId>
 *   app resource            every-<orgKey>-<appId>--<binding>
 *   app AI Gateway          every-<orgKey>-<appId>-<binding>
 *
 * A named Gateway (`everyapp setup --name demo`; a name is 1 to 16 of
 * [a-z0-9], no hyphen) puts its name after the gateway root, and its apps'
 * names behind `every-<name>--`:
 *
 *   Gateway Worker, D1      every-app-gateway-demo
 *   OAuth KV                every-app-gateway-demo-OAUTH_KV
 *   activation queue        every-app-gateway-demo-activate
 *   app Worker              every-demo--<orgKey>-<appId>
 *   app resource            every-demo--<orgKey>-<appId>--<binding>
 *   app AI Gateway          every-app-gateway-demo-<orgKey>-<appId>-<binding>
 *
 * Why these are disjoint ({@link belongsToGateway}, proved by
 * gatewayNames.test.ts over every kind of name):
 *
 *   - A default app name is `every-` + an org key + `-` + a character that
 *     isn't `-` (org keys have no hyphen, app ids start with a letter or
 *     digit). A named Gateway's app name has `--` right after its name, so
 *     the character after the first hyphen-separated segment is `-`: never
 *     a default app name, and never another named Gateway's (names have no
 *     hyphen, so `every-a--` is a prefix of `every-b--…` only when a = b).
 *   - Everything under the root `every-app-gateway-…` is reserved from apps
 *     on every Gateway (`isReservedName`), so the default Gateway owns only
 *     its three exact names there, and a named Gateway owns
 *     `every-app-gateway-<name>` and `every-app-gateway-<name>-…`. AI
 *     Gateway ids may not hold `--`, which is why a named Gateway's go
 *     under this root instead of behind `every-<name>--`.
 *   - The default Gateway's scan is what it was (`every-*`), minus those
 *     two shapes: nothing that was its before is lost but a legacy
 *     `every-<appId>--<binding>` resource of a pre-org-scoped app, which
 *     the Gateway no longer binds and which the resource ledger still names.
 */

/** The root every Gateway's own names and the reserved names start with. */
export const GATEWAY_ROOT = "every-app-gateway";

/** What every app name starts with, on every Gateway. */
export const EVERY_PREFIX = "every-";

/** The separator between an app's Worker name and its resources' suffixes (`every-acme-notes--archive`). */
export const RESOURCE_SEPARATOR = "--";

/**
 * A Gateway's name: lowercase letters and digits, no hyphen (so a name is
 * never a prefix of another name followed by `-`), short enough to leave
 * room for app names under Cloudflare's 63-character limits.
 */
export const GATEWAY_NAME_PATTERN = /^[a-z0-9]{1,16}$/;

/**
 * Names refused: `activate` would give a Gateway the default's queue's
 * name as its Worker and D1 name (another namespace, but one name for two
 * things), and `app` reads as the root itself.
 */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  "activate",
  "app",
  "gateway",
]);

export function isValidGatewayName(name: string): boolean {
  return GATEWAY_NAME_PATTERN.test(name) && !REFUSED_NAMES.has(name);
}

/** Why a name is refused, for the flag's error; null when it is fine. */
export function gatewayNameProblem(name: string): string | null {
  if (!GATEWAY_NAME_PATTERN.test(name)) {
    return "a Gateway name is 1 to 16 lowercase letters or digits, with no hyphen";
  }
  if (REFUSED_NAMES.has(name)) return `"${name}" is reserved`;
  return null;
}

/** Every name one Gateway takes, and the shapes its apps' names take. */
export interface GatewayNames {
  /** Null for the default Gateway, the one every install before names had. */
  name: string | null;
  /** The Gateway's Worker, and its D1 database. */
  worker: string;
  d1: string;
  /** The MCP OAuth server's KV namespace (its title). */
  oauthKv: string;
  /** The queue the CLI nudges once it has bound an app. */
  activationQueue: string;
  /** What every app Worker of this Gateway starts with. */
  appPrefix: string;
  /** What every app AI Gateway id of this Gateway starts with (`--` isn't allowed in one). */
  aiGatewayPrefix: string;
  /** "the Gateway" / "Gateway demo", for messages. */
  label: string;
}

/** The names of the Gateway called `name` (null or "" for the default). */
export function gatewayNames(name?: string | null): GatewayNames {
  const normalized = name ? name.trim().toLowerCase() : "";
  if (normalized === "") {
    return {
      name: null,
      worker: GATEWAY_ROOT,
      d1: GATEWAY_ROOT,
      oauthKv: `${GATEWAY_ROOT}-OAUTH_KV`,
      activationQueue: `${GATEWAY_ROOT}-activate`,
      appPrefix: EVERY_PREFIX,
      aiGatewayPrefix: EVERY_PREFIX,
      label: "the Gateway",
    };
  }
  if (!isValidGatewayName(normalized)) {
    throw new Error(
      `Invalid Gateway name "${name}": ${gatewayNameProblem(normalized)}.`,
    );
  }
  const worker = `${GATEWAY_ROOT}-${normalized}`;
  return {
    name: normalized,
    worker,
    d1: worker,
    oauthKv: `${worker}-OAUTH_KV`,
    activationQueue: `${worker}-activate`,
    appPrefix: `${EVERY_PREFIX}${normalized}${RESOURCE_SEPARATOR}`,
    aiGatewayPrefix: `${worker}-`,
    label: `Gateway ${normalized}`,
  };
}

/** The default Gateway's names: what every install had before names. */
export const DEFAULT_GATEWAY_NAMES: Readonly<GatewayNames> = Object.freeze(
  gatewayNames(null),
);

/**
 * The Gateway whose Worker or D1 database is called `resourceName`: the
 * default's for the root itself, a named one's for `every-app-gateway-<name>`
 * with a valid name; null for anything else (an OAuth KV title, an
 * activation queue, an app, a name that isn't a Gateway's).
 */
export function gatewayNameOf(resourceName: string): GatewayNames | null {
  if (resourceName === GATEWAY_ROOT) return gatewayNames(null);
  if (!resourceName.startsWith(`${GATEWAY_ROOT}-`)) return null;
  const name = resourceName.slice(GATEWAY_ROOT.length + 1);
  return isValidGatewayName(name) ? gatewayNames(name) : null;
}

/** The names a Worker, D1 database, KV namespace or queue of the Gateway itself takes. */
export function isGatewayOwnName(
  names: GatewayNames,
  resourceName: string,
): boolean {
  return (
    resourceName === names.worker ||
    resourceName === names.oauthKv ||
    resourceName === names.activationQueue
  );
}

/** The org key and app id of a Worker name: no hyphen in the key, the id's first character not a hyphen. */
const DEFAULT_APP_NAME = /^every-[a-z0-9]+-[a-z0-9]/;
/** A named Gateway's app name: `every-<name>--…`. */
const NAMED_APP_NAME = /^every-[a-z0-9]+--/;

/**
 * Whether an account-wide name (a Worker's, a D1 database's, a KV
 * namespace's title, a queue's, an R2 bucket's, a Vectorize index's, an AI
 * Gateway's id, a Secrets Store secret's, a Workflow's, a dataset's) is
 * one this Gateway created, by its shape alone: the Gateway's own three
 * names, its apps' Workers and their resources, its apps' AI Gateways. A
 * name of another Gateway in the account, named or default, never is: the
 * module comment says why, and gatewayNames.test.ts checks it over every
 * kind of name two Gateways make.
 */
export function belongsToGateway(
  names: GatewayNames,
  resourceName: string,
): boolean {
  if (isGatewayOwnName(names, resourceName)) return true;
  if (names.name === null) {
    // Every `every-*` name as before, but nothing under the reserved root
    // (another Gateway's own names and AI Gateways) and nothing shaped as a
    // named Gateway's app (`every-<name>--…`).
    if (!resourceName.startsWith(EVERY_PREFIX)) return false;
    if (resourceName.startsWith(`${GATEWAY_ROOT}-`)) return false;
    if (NAMED_APP_NAME.test(resourceName)) return false;
    return true;
  }
  return (
    resourceName.startsWith(names.appPrefix) ||
    resourceName.startsWith(names.aiGatewayPrefix)
  );
}

/** Whether a default-shaped app name (`every-<orgKey>-<appId>…`) is what it looks like; for tests and docs. */
export function isDefaultAppName(resourceName: string): boolean {
  return (
    DEFAULT_APP_NAME.test(resourceName) &&
    !resourceName.startsWith(`${GATEWAY_ROOT}-`) &&
    !NAMED_APP_NAME.test(resourceName)
  );
}
