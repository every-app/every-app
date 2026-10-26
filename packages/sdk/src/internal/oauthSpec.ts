/**
 * The `oauth2-user` half of a provider spec
 * (docs/design/2026-10-oauth-providers.md section 3): a registered OAuth
 * provider, or a preset (./oauthPresets.ts), as JSON, turned into the
 * same {@link OAuthClientCapability} a catalog client is, with a `flow`
 * the Gateway runs itself. `parseProviderSpec` (./providerSpec.ts) hands
 * the common fields here once it sees `auth.kind: "oauth2-user"`; nothing
 * here reads a value: a spec names Gateway settings, never holds one.
 */
import {
  DEFAULT_WRITE_METHODS,
  type CapabilityAccess,
  type OAuthClientCapability,
  type OAuthClientInjection,
  type OAuthFlow,
  type OAuthIdentity,
  type OAuthScopeDialect,
  type OAuthScopePolicy,
  type OAuthScopeRoute,
  type OAuthScopeSet,
} from "./capabilities.js";

export interface SpecProblem {
  path: string;
  message: string;
}

/** A scope set's name: `identity`, or `<area>.<access>` (`repo.read`), lowercase. */
export const SCOPE_SET_NAME =
  /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31})?$/;
const DIALECTS: readonly OAuthScopeDialect[] = [
  "space",
  "comma",
  "google",
  "microsoft",
  "slack",
];
const INJECTIONS: readonly OAuthClientInjection[] = ["form", "basic"];
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Headers the Gateway sets on the token request itself, or never sends. */
const RESERVED_TOKEN_HEADERS = new Set([
  "authorization",
  "content-type",
  "content-length",
  "host",
  "cookie",
]);
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** A dot path into a JSON answer, at most four segments. */
const DOT_PATH =
  /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
const MAX_SETS = 20;
const MAX_SCOPES = 40;
const MAX_ROUTES = 20;
const MAX_PATHS = 50;
const MAX_PARAMS = 10;
/** Segments no set unlocks on any host: batch tunnels carry whole requests inside. */
export const DEFAULT_DENIED_SEGMENTS: readonly string[] = ["batch", "$batch"];

/** The fields of `auth` when its kind is `oauth2-user`. */
export const OAUTH_AUTH_FIELDS = [
  "kind",
  "authorizeUrl",
  "tokenUrl",
  "revokeUrl",
  "revokeMethod",
  "clientId",
  "clientSecret",
  "inject",
  "pkce",
  "scopeDialect",
  "authorizeParams",
  "tokenHeaders",
  "identity",
] as const;

/** The common fields `parseProviderSpec` parsed before handing over. */
export interface OAuthSpecCommon {
  id: string;
  name: string;
  docs: string;
  hosts: readonly string[];
  description?: string;
  reference?: string;
  access?: readonly CapabilityAccess[];
  readMethods?: readonly string[];
  writeMethods?: readonly string[];
  hint?: string;
  example?: string;
  tags?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printable(
  value: unknown,
  path: string,
  problems: SpecProblem[],
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    problems.push({
      path,
      message: `must be a string of 1 to ${max} characters`,
    });
    return undefined;
  }
  if (UNPRINTABLE.test(value)) {
    problems.push({ path, message: "holds a control character" });
    return undefined;
  }
  return value;
}

/**
 * An https URL with a host a row may name (the caller runs the gateway's
 * host rules on `host` afterwards). `{client_id}` may stand in a path
 * (GitHub's revoke URL names the client there).
 */
function endpoint(
  value: unknown,
  path: string,
  problems: SpecProblem[],
  { query }: { query: boolean },
): { url: string; host: string } | undefined {
  if (value === undefined) return undefined;
  const url = printable(value, path, problems, 500);
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push({ path, message: "must be an https URL" });
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    problems.push({
      path,
      message: "must be an https URL with no port, credentials or fragment",
    });
    return undefined;
  }
  if (!query && parsed.search) {
    problems.push({ path, message: "may not carry a query string" });
    return undefined;
  }
  return { url, host: parsed.hostname.toLowerCase() };
}

function settingName(
  value: unknown,
  path: string,
  problems: SpecProblem[],
  pattern: RegExp,
): string | undefined {
  if (typeof value !== "string" || !pattern.test(value)) {
    problems.push({
      path,
      message:
        "must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (GITHUB_CLIENT_ID)",
    });
    return undefined;
  }
  return value;
}

function stringMap(
  value: unknown,
  path: string,
  problems: SpecProblem[],
  each: (name: string, at: string) => void,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push({ path, message: "must be an object of strings" });
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMS) {
    problems.push({ path, message: `at most ${MAX_PARAMS} entries` });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, raw] of entries) {
    const at = `${path}.${name}`;
    each(name, at);
    const text = printable(raw, at, problems, 200);
    if (text !== undefined) out[name] = text;
  }
  return out;
}

function scopeList(
  value: unknown,
  path: string,
  problems: SpecProblem[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SCOPES) {
    problems.push({
      path,
      message: `must be a list of at most ${MAX_SCOPES} scopes`,
    });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    const scope = printable(item, `${path}.${index}`, problems, 200);
    if (scope === undefined) return;
    if (/\s/.test(scope) || scope.includes(",")) {
      problems.push({
        path: `${path}.${index}`,
        message: "one scope, with no space or comma",
      });
      return;
    }
    out.push(scope);
  });
  if (new Set(out).size !== out.length) {
    problems.push({ path, message: "lists a scope twice" });
  }
  return out;
}

function routes(
  value: unknown,
  path: string,
  hosts: readonly string[],
  problems: SpecProblem[],
): OAuthScopeRoute[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ROUTES) {
    problems.push({
      path,
      message: `must be a list of at most ${MAX_ROUTES} routes`,
    });
    return undefined;
  }
  const out: OAuthScopeRoute[] = [];
  value.forEach((item, index) => {
    const at = `${path}.${index}`;
    if (!isRecord(item)) {
      problems.push({ path: at, message: "must be { host, paths, posts? }" });
      return;
    }
    for (const field of Object.keys(item)) {
      if (!["host", "paths", "posts"].includes(field)) {
        problems.push({ path: `${at}.${field}`, message: "unknown field" });
      }
    }
    const host = printable(item["host"], `${at}.host`, problems, 253);
    if (host !== undefined && !hosts.includes(host)) {
      problems.push({ path: `${at}.host`, message: "must be one of hosts" });
    }
    const paths: string[] = [];
    if (!Array.isArray(item["paths"]) || item["paths"].length > MAX_PATHS) {
      problems.push({
        path: `${at}.paths`,
        message: `must be a list of at most ${MAX_PATHS} paths`,
      });
    } else {
      item["paths"].forEach((entry, offset) => {
        const text = printable(entry, `${at}.paths.${offset}`, problems, 500);
        if (text === undefined) return;
        if (
          !text.startsWith("/") ||
          text.includes("//") ||
          text.includes("\\") ||
          text.includes("%") ||
          /(^|\/)\.\.?(\/|$)/.test(text)
        ) {
          problems.push({
            path: `${at}.paths.${offset}`,
            message:
              "must start with / and hold no //, backslash, percent-escape or dot segment",
          });
          return;
        }
        paths.push(text);
      });
    }
    const posts: RegExp[] = [];
    if (item["posts"] !== undefined) {
      if (!Array.isArray(item["posts"]) || item["posts"].length > MAX_PATHS) {
        problems.push({
          path: `${at}.posts`,
          message: `must be a list of at most ${MAX_PATHS} anchored patterns`,
        });
      } else {
        item["posts"].forEach((entry, offset) => {
          const text = printable(entry, `${at}.posts.${offset}`, problems, 500);
          if (text === undefined) return;
          if (!text.startsWith("^") || !text.endsWith("$")) {
            problems.push({
              path: `${at}.posts.${offset}`,
              message: "must be anchored: start with ^ and end with $",
            });
            return;
          }
          try {
            posts.push(new RegExp(text));
          } catch {
            problems.push({
              path: `${at}.posts.${offset}`,
              message: "is not a valid pattern",
            });
          }
        });
      }
    }
    if (host === undefined) return;
    out.push({
      host,
      paths,
      ...(item["posts"] === undefined ? {} : { posts }),
    });
  });
  return out;
}

/** The fields one scope set may carry, in a spec's `scopeSets` or an overlay. */
const SCOPE_SET_FIELDS = ["label", "access", "scopes", "userScopes", "routes"];

/**
 * One scope set (`{ label, access, scopes, userScopes?, routes? }`) at
 * `at`, its routes on `hosts` alone; undefined when a field is wrong,
 * every problem reported. `overlay`: a set added to a built-in client
 * must name a scope and say what it unlocks (a set with no routes unlocks
 * nothing on the held-token path); a spec's own set may leave both empty
 * (Notion's sets carry no scope string).
 */
export function parseScopeSet(
  raw: unknown,
  at: string,
  hosts: readonly string[],
  problems: SpecProblem[],
  { overlay = false }: { overlay?: boolean } = {},
): OAuthScopeSet | undefined {
  if (!isRecord(raw)) {
    problems.push({ path: at, message: "must be { label, access, scopes }" });
    return undefined;
  }
  for (const field of Object.keys(raw)) {
    if (!SCOPE_SET_FIELDS.includes(field)) {
      problems.push({ path: `${at}.${field}`, message: "unknown field" });
    }
  }
  const label = printable(raw["label"], `${at}.label`, problems, 80);
  if (raw["label"] === undefined) {
    problems.push({ path: `${at}.label`, message: "required" });
  }
  const access = raw["access"];
  if (access !== "read" && access !== "write") {
    problems.push({ path: `${at}.access`, message: "must be read or write" });
  }
  const scopes = scopeList(raw["scopes"], `${at}.scopes`, problems);
  if (raw["scopes"] === undefined) {
    problems.push({ path: `${at}.scopes`, message: "required" });
  } else if (overlay && scopes && scopes.length === 0) {
    problems.push({ path: `${at}.scopes`, message: "must list a scope" });
  }
  const userScopes = scopeList(raw["userScopes"], `${at}.userScopes`, problems);
  const parsedRoutes = routes(raw["routes"], `${at}.routes`, hosts, problems);
  if (overlay && (!parsedRoutes || parsedRoutes.length === 0)) {
    problems.push({
      path: `${at}.routes`,
      message:
        "required: at least one { host, paths } the set unlocks, on one of the client's API hosts",
    });
  }
  if (
    label === undefined ||
    (access !== "read" && access !== "write") ||
    scopes === undefined
  ) {
    return undefined;
  }
  return {
    label,
    access,
    scopes,
    ...(userScopes === undefined ? {} : { userScopes }),
    routes: parsedRoutes ?? [],
  };
}

function scopeSets(
  value: unknown,
  hosts: readonly string[],
  problems: SpecProblem[],
): Record<string, OAuthScopeSet> | undefined {
  if (!isRecord(value)) {
    problems.push({
      path: "scopeSets",
      message:
        'required: at least one named set, { "repo.read": { "label", "access", "scopes" } }',
    });
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_SETS) {
    problems.push({
      path: "scopeSets",
      message: `must name 1 to ${MAX_SETS} sets`,
    });
    return undefined;
  }
  const out: Record<string, OAuthScopeSet> = {};
  for (const [name, raw] of entries) {
    const at = `scopeSets.${name}`;
    if (!SCOPE_SET_NAME.test(name)) {
      problems.push({
        path: at,
        message:
          "a set is named identity, or <area>.<access> in lowercase (repo.read)",
      });
      continue;
    }
    const set = parseScopeSet(raw, at, hosts, problems);
    if (set) out[name] = set;
  }
  return out;
}

/** The fields a scope-set overlay carries: a set's, with its `name` and the client it belongs to. */
const OVERLAY_FIELDS = ["provider", "name", ...SCOPE_SET_FIELDS];

/** What `parseScopeSetOverlay` returns. */
export type ParsedScopeSetOverlay =
  | { ok: true; name: string; set: OAuthScopeSet }
  | { ok: false; problems: SpecProblem[] };

/**
 * A scope set an operator adds to a built-in OAuth client
 * (`everyapp provider scope-set add google-workspace gmail-send.json`):
 * `{ "name": "gmail.send", "label", "access", "scopes", "routes" }`, held
 * to the rules a built-in set is (the set's shape, routes on the client's
 * `api` hosts alone, anchored `posts`) plus two of its own: `access` is
 * said outright (a write set is never implied by its scopes) and `routes`
 * is required. A `provider` field, when present, must be `id`. The name
 * may not be one of the client's own sets: an overlay adds, never
 * replaces. Nothing here reads a value.
 */
export function parseScopeSetOverlay(
  input: unknown,
  client: { id: string; capability: OAuthClientCapability },
): ParsedScopeSetOverlay {
  const problems: SpecProblem[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      problems: [{ path: "(root)", message: "must be a JSON object" }],
    };
  }
  for (const field of Object.keys(input)) {
    if (!OVERLAY_FIELDS.includes(field)) {
      problems.push({ path: field, message: "unknown field" });
    }
  }
  const policy = client.capability.scopePolicy;
  if (!policy) {
    problems.push({
      path: "(root)",
      message: `${client.id} has no scope sets: the whole client is the grant`,
    });
  }
  if (input["provider"] !== undefined && input["provider"] !== client.id) {
    problems.push({
      path: "provider",
      message: `is ${String(input["provider"])}, not ${client.id}`,
    });
  }
  const name = input["name"];
  if (typeof name !== "string" || !SCOPE_SET_NAME.test(name)) {
    problems.push({
      path: "name",
      message:
        "required: identity, or <area>.<access> in lowercase (gmail.send)",
    });
  } else if (policy && Object.hasOwn(policy.sets, name)) {
    problems.push({
      path: "name",
      message: `${name} is one of ${client.id}'s own sets; an overlay adds a set, never replaces one`,
    });
  }
  // The set's own fields alone: an unknown one was reported above.
  const fields = Object.fromEntries(
    Object.entries(input).filter(([field]) => SCOPE_SET_FIELDS.includes(field)),
  );
  const set = parseScopeSet(fields, "(set)", client.capability.api, problems, {
    overlay: true,
  });
  if (problems.length > 0 || !set || typeof name !== "string") {
    return { ok: false, problems };
  }
  return { ok: true, name, set };
}

/**
 * `capability` with `sets` added to its scope policy: the sets after the
 * client's own, in the order given, and each set's scopes added to the
 * authorize URL's list (what the operator's client must be allowed), as
 * `parseOAuthUserSpec` builds it. A name the client already has is left
 * as the client's (the registry refuses such an overlay before this).
 */
export function withScopeSets(
  capability: OAuthClientCapability,
  sets: Readonly<Record<string, OAuthScopeSet>>,
): OAuthClientCapability {
  const policy = capability.scopePolicy;
  if (!policy) return capability;
  const merged: Record<string, OAuthScopeSet> = { ...policy.sets };
  const scopes = [...capability.authorize.scopes];
  for (const [name, set] of Object.entries(sets)) {
    if (Object.hasOwn(merged, name)) continue;
    merged[name] = set;
    for (const scope of set.scopes) {
      if (!scopes.includes(scope)) scopes.push(scope);
    }
  }
  return {
    ...capability,
    authorize: { ...capability.authorize, scopes },
    scopePolicy: { ...policy, sets: merged },
  };
}

function identity(
  value: unknown,
  hosts: readonly string[],
  problems: SpecProblem[],
): OAuthIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push({
      path: "auth.identity",
      message: "must be { url, label, id? }",
    });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!["url", "label", "id"].includes(field)) {
      problems.push({
        path: `auth.identity.${field}`,
        message: "unknown field",
      });
    }
  }
  const url = endpoint(value["url"], "auth.identity.url", problems, {
    query: true,
  });
  if (value["url"] === undefined) {
    problems.push({ path: "auth.identity.url", message: "required" });
  } else if (url && !hosts.includes(url.host)) {
    problems.push({
      path: "auth.identity.url",
      message: "must be on one of hosts (the token is sent there)",
    });
  }
  const label = printable(value["label"], "auth.identity.label", problems, 128);
  if (label !== undefined && !DOT_PATH.test(label)) {
    problems.push({
      path: "auth.identity.label",
      message: "must be a JSON field name, or a dotted path to a nested one",
    });
  }
  if (value["label"] === undefined) {
    problems.push({ path: "auth.identity.label", message: "required" });
  }
  const id = printable(value["id"], "auth.identity.id", problems, 128);
  if (id !== undefined && !DOT_PATH.test(id)) {
    problems.push({
      path: "auth.identity.id",
      message: "must be a JSON field name, or a dotted path to a nested one",
    });
  }
  if (!url || label === undefined) return undefined;
  return { url: url.url, label, ...(id === undefined ? {} : { id }) };
}

/** What `parseOAuthUserSpec` returns on success, before the registry's rules. */
export interface ParsedOAuthSpec {
  capability: OAuthClientCapability;
  /** Every host a row's rules must accept: the API hosts and the endpoints'. */
  hosts: string[];
}

/**
 * Parse the OAuth half of a spec whose `auth.kind` is `oauth2-user`:
 * `auth` itself, `scopeSets`, `alwaysRequested` and `tolerated`, with
 * the common fields already parsed. Every problem is reported; on
 * success the catalog-shaped capability with its `flow`.
 */
export function parseOAuthUserSpec(
  input: Record<string, unknown>,
  common: OAuthSpecCommon,
  problems: SpecProblem[],
): ParsedOAuthSpec | undefined {
  const settingName_ = (value: unknown, path: string, into: SpecProblem[]) =>
    settingName(value, path, into, /^[A-Z][A-Z0-9_]{2,63}$/);
  const auth = input["auth"] as Record<string, unknown>;
  for (const field of Object.keys(auth)) {
    if (!(OAUTH_AUTH_FIELDS as readonly string[]).includes(field)) {
      problems.push({
        path: `auth.${field}`,
        message: "not a field of auth.kind oauth2-user",
      });
    }
  }
  const authorize = endpoint(
    auth["authorizeUrl"],
    "auth.authorizeUrl",
    problems,
    {
      query: true,
    },
  );
  if (auth["authorizeUrl"] === undefined) {
    problems.push({ path: "auth.authorizeUrl", message: "required" });
  }
  const token = endpoint(auth["tokenUrl"], "auth.tokenUrl", problems, {
    query: false,
  });
  if (auth["tokenUrl"] === undefined) {
    problems.push({ path: "auth.tokenUrl", message: "required" });
  }
  const revoke = endpoint(auth["revokeUrl"], "auth.revokeUrl", problems, {
    query: false,
  });
  const revokeMethod = auth["revokeMethod"];
  if (
    revokeMethod !== undefined &&
    revokeMethod !== "POST" &&
    revokeMethod !== "DELETE"
  ) {
    problems.push({
      path: "auth.revokeMethod",
      message: "must be POST or DELETE",
    });
  }
  if (revokeMethod !== undefined && revoke === undefined) {
    problems.push({
      path: "auth.revokeMethod",
      message: "needs a revokeUrl",
    });
  }
  const clientId = settingName_(auth["clientId"], "auth.clientId", problems);
  const clientSecret =
    auth["clientSecret"] === undefined
      ? undefined
      : settingName_(auth["clientSecret"], "auth.clientSecret", problems);
  if (clientSecret !== undefined && clientSecret === clientId) {
    problems.push({
      path: "auth.clientSecret",
      message: "must be another setting than auth.clientId",
    });
  }
  const inject = auth["inject"] ?? "form";
  if (!(INJECTIONS as readonly unknown[]).includes(inject)) {
    problems.push({
      path: "auth.inject",
      message: "must be form (the client in the body) or basic (HTTP Basic)",
    });
  }
  const pkce = auth["pkce"] ?? true;
  if (typeof pkce !== "boolean") {
    problems.push({ path: "auth.pkce", message: "must be true or false" });
  }
  const dialect = auth["scopeDialect"] ?? "space";
  if (!(DIALECTS as readonly unknown[]).includes(dialect)) {
    problems.push({
      path: "auth.scopeDialect",
      message: `must be one of ${DIALECTS.join(", ")}`,
    });
  }
  const authorizeParams = stringMap(
    auth["authorizeParams"],
    "auth.authorizeParams",
    problems,
    (name, at) => {
      if (!PARAM_NAME.test(name)) {
        problems.push({ path: at, message: "must be a query parameter name" });
      }
      if (
        [
          "client_id",
          "redirect_uri",
          "response_type",
          "scope",
          "state",
          "code_challenge",
          "code_challenge_method",
        ].includes(name)
      ) {
        problems.push({
          path: at,
          message: `${name} is a parameter the Gateway sets itself`,
        });
      }
    },
  );
  const tokenHeaders = stringMap(
    auth["tokenHeaders"],
    "auth.tokenHeaders",
    problems,
    (name, at) => {
      if (!HEADER_NAME.test(name)) {
        problems.push({ path: at, message: "must be a header name" });
      } else if (
        RESERVED_TOKEN_HEADERS.has(name.toLowerCase()) ||
        name.toLowerCase().startsWith("x-everyapp-")
      ) {
        problems.push({
          path: at,
          message: `${name} is a header the Gateway sets itself`,
        });
      }
    },
  );
  const parsedIdentity = identity(auth["identity"], common.hosts, problems);
  const sets = scopeSets(input["scopeSets"], common.hosts, problems);
  const alwaysRequested = scopeList(
    input["alwaysRequested"],
    "alwaysRequested",
    problems,
  );
  const tolerated = scopeList(input["tolerated"], "tolerated", problems);
  if (
    !authorize ||
    !token ||
    clientId === undefined ||
    !sets ||
    typeof pkce !== "boolean" ||
    !(DIALECTS as readonly unknown[]).includes(dialect) ||
    !(INJECTIONS as readonly unknown[]).includes(inject)
  ) {
    return undefined;
  }
  const union: string[] = [];
  const add = (scopes: readonly string[]) => {
    for (const scope of scopes) if (!union.includes(scope)) union.push(scope);
  };
  for (const set of Object.values(sets)) {
    add(set.scopes);
    add(set.userScopes ?? []);
  }
  add(alwaysRequested ?? []);
  const policy: OAuthScopePolicy = {
    sets,
    tolerated: tolerated ?? [],
    alwaysRequested: alwaysRequested ?? [],
    dialect: dialect as OAuthScopeDialect,
    grantTypes: ["authorization_code", "refresh_token"],
    requestScope: "keep",
    deniedSegments: [...DEFAULT_DENIED_SEGMENTS],
  };
  const flow: OAuthFlow = {
    tokenUrl: token.url,
    ...(revoke === undefined ? {} : { revokeUrl: revoke.url }),
    ...(revokeMethod === undefined
      ? {}
      : { revokeMethod: revokeMethod as "POST" | "DELETE" }),
    pkce,
    scopeDialect: dialect as OAuthScopeDialect,
    ...(authorizeParams === undefined ? {} : { authorizeParams }),
    ...(tokenHeaders === undefined ? {} : { tokenHeaders }),
    ...(parsedIdentity === undefined ? {} : { identity: parsedIdentity }),
  };
  const tokenPath = new URL(token.url).pathname;
  const capability: OAuthClientCapability = {
    mode: "oauth_client",
    label: common.name,
    secrets: {
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
    },
    token: [
      {
        host: token.host,
        path: tokenPath,
        methods: ["POST"],
        inject: inject as OAuthClientInjection,
      },
    ],
    access: common.access ?? ["read"],
    console: common.docs,
    authorize: { url: authorize.url, scopes: union },
    scopePolicy: policy,
    api: [...common.hosts],
    redirectPaths: [],
    flow,
    ...(common.readMethods === undefined
      ? {}
      : { readMethods: common.readMethods }),
    ...(common.writeMethods === undefined
      ? {}
      : { writeMethods: common.writeMethods }),
    ...(common.description === undefined
      ? {}
      : { description: common.description }),
    ...(common.reference === undefined ? {} : { reference: common.reference }),
    ...(common.hint === undefined ? {} : { hint: common.hint }),
    ...(common.example === undefined ? {} : { example: common.example }),
    ...(common.tags === undefined ? {} : { tags: common.tags }),
  };
  const hosts = [...common.hosts];
  for (const host of [authorize.host, token.host, revoke?.host]) {
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return { capability, hosts };
}

/**
 * The JSON spec of an OAuth capability that has a `flow` (`provider
 * show`, a preset's round trip): `parseProviderSpec` of it gives the
 * capability back. A catalog client without a `flow` has no spec.
 */
export function oauthSpecOf(
  id: string,
  capability: OAuthClientCapability,
): Record<string, unknown> | null {
  const flow = capability.flow;
  const policy = capability.scopePolicy;
  if (!flow || !policy) return null;
  const inject = capability.token[0]?.inject ?? "form";
  return {
    id,
    name: capability.label,
    ...(capability.description === undefined
      ? {}
      : { description: capability.description }),
    docs: capability.console,
    ...(capability.reference === undefined
      ? {}
      : { api: capability.reference }),
    hosts: [...capability.api],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: capability.authorize.url,
      tokenUrl: flow.tokenUrl,
      ...(flow.revokeUrl === undefined ? {} : { revokeUrl: flow.revokeUrl }),
      ...(flow.revokeMethod === undefined
        ? {}
        : { revokeMethod: flow.revokeMethod }),
      clientId: capability.secrets.clientId,
      ...(capability.secrets.clientSecret === undefined
        ? {}
        : { clientSecret: capability.secrets.clientSecret }),
      inject,
      pkce: flow.pkce,
      scopeDialect: flow.scopeDialect,
      ...(flow.authorizeParams === undefined
        ? {}
        : { authorizeParams: { ...flow.authorizeParams } }),
      ...(flow.tokenHeaders === undefined
        ? {}
        : { tokenHeaders: { ...flow.tokenHeaders } }),
      ...(flow.identity === undefined
        ? {}
        : { identity: { ...flow.identity } }),
    },
    scopeSets: Object.fromEntries(
      Object.entries(policy.sets).map(([name, set]) => [
        name,
        {
          label: set.label,
          access: set.access,
          scopes: [...set.scopes],
          ...(set.userScopes === undefined
            ? {}
            : { userScopes: [...set.userScopes] }),
          ...(set.routes.length === 0
            ? {}
            : {
                routes: set.routes.map((route) => ({
                  host: route.host,
                  paths: [...route.paths],
                  // `source` escapes `/` as `\/`; the spec wrote it bare.
                  ...(route.posts === undefined
                    ? {}
                    : {
                        posts: route.posts.map((pattern) =>
                          pattern.source.replace(/\\\//g, "/"),
                        ),
                      }),
                })),
              }),
        },
      ]),
    ),
    ...(policy.alwaysRequested.length === 0
      ? {}
      : { alwaysRequested: [...policy.alwaysRequested] }),
    ...(policy.tolerated.length === 0
      ? {}
      : { tolerated: [...policy.tolerated] }),
    access: [...capability.access],
    ...(capability.readMethods === undefined
      ? {}
      : { readMethods: [...capability.readMethods] }),
    ...(capability.writeMethods === undefined
      ? {}
      : { writeMethods: [...capability.writeMethods] }),
    ...(capability.hint === undefined ? {} : { hint: capability.hint }),
    ...(capability.example === undefined
      ? {}
      : { example: capability.example }),
    ...(capability.tags === undefined ? {} : { tags: [...capability.tags] }),
  };
}

/** The methods a held-token write may use on `capability` beyond its reads. */
export function oauthWriteMethods(
  capability: OAuthClientCapability,
): readonly string[] {
  return capability.writeMethods ?? DEFAULT_WRITE_METHODS;
}

/** The methods a read grant may use on `capability` (GET and HEAD unless the spec says). */
export function oauthReadMethods(
  capability: OAuthClientCapability,
): readonly string[] {
  return capability.readMethods ?? ["GET", "HEAD"];
}
