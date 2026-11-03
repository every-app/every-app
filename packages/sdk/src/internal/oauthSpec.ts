/**
 * The `oauth2-user` half of a provider spec: a registered OAuth provider,
 * a preset (./oauthPresets.ts) or a built-in one (./oauthBuiltIns.ts), as
 * JSON, turned into an {@link OAuthClientCapability} whose `flow` the
 * Gateway runs. `parseProviderSpec` (./providerSpec.ts) hands the common
 * fields here once it sees `auth.kind: "oauth2-user"`. Nothing here reads
 * a value: a spec names Gateway settings, never holds one.
 *
 * Every difference between providers is a field here, never code: the
 * endpoints, how the client goes on the token request, PKCE, the scope
 * separator and prefix, extra authorize parameters and token headers, the
 * identity URL with the scopes it needs, and the scopes a token may carry
 * beyond what was asked (`tolerated`). Which scopes an app gets is its own
 * `everyapp.config.ts`, never the spec.
 *
 * Only type imports from ./capabilities.ts: the catalog builds its
 * built-in entries with {@link oauthCapabilityFromSpec} at load.
 */
import type {
  OAuthClientCapability,
  OAuthClientInjection,
  OAuthFlow,
  OAuthIdentity,
  OAuthScopeSeparator,
} from "./capabilities.js";

export interface SpecProblem {
  path: string;
  message: string;
}

const SEPARATORS: readonly OAuthScopeSeparator[] = ["space", "comma"];
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
/**
 * Authorize parameters the Gateway sets itself, and
 * `include_granted_scopes`, which would widen a token to every scope the
 * person ever granted the client (the mint check would refuse it anyway).
 */
const RESERVED_AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "include_granted_scopes",
];
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** A dot path into a JSON answer, at most four segments. */
const DOT_PATH =
  /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
const MAX_SCOPES = 40;
const MAX_PARAMS = 10;

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
  "scopeSeparator",
  "scopePrefix",
  "authorizeParams",
  "tokenHeaders",
  "identity",
  "tolerated",
] as const;

/**
 * Fields an `oauth2-user` spec had before scopes moved to each app's
 * `everyapp.config.ts`, each with what to write instead: refused with
 * that message rather than "unknown field".
 */
export const REMOVED_OAUTH_FIELDS: Readonly<Record<string, string>> = {
  scopeSets:
    "scope sets are gone: each app lists the provider's own scopes in its everyapp.config.ts. Remove scopeSets.",
  alwaysRequested:
    "alwaysRequested is gone: put scopes every connect needs (a refresh token's, the identity URL's) in auth.identity.scopes.",
  tolerated:
    "tolerated moved into auth: auth.tolerated lists the scopes a token may carry beyond what was asked.",
  access:
    "access is gone for an OAuth provider: the scopes an app lists are the grant, for every method.",
  readMethods:
    "readMethods is gone for an OAuth provider: the scopes an app lists are the grant, for every method.",
  writeMethods:
    "writeMethods is gone for an OAuth provider: the scopes an app lists are the grant, for every method.",
};

/** `auth` fields renamed, each with its new name. */
const RENAMED_AUTH_FIELDS: Readonly<Record<string, string>> = {
  scopeDialect:
    "renamed auth.scopeSeparator: space or comma (a provider's prefix goes in auth.scopePrefix)",
};

/** The common fields `parseProviderSpec` parsed before handing over. */
export interface OAuthSpecCommon {
  id: string;
  name: string;
  docs: string;
  hosts: readonly string[];
  description?: string;
  reference?: string;
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
): string | undefined {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
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

/** A list of provider scope strings: each one scope, with no space or comma, each once. */
export function scopeList(
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

function identity(
  value: unknown,
  hosts: readonly string[],
  problems: SpecProblem[],
): { identity: OAuthIdentity; scopes: string[] } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push({
      path: "auth.identity",
      message: "must be { url, label, id?, scopes? }",
    });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!["url", "label", "id", "scopes"].includes(field)) {
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
  const scopes = scopeList(value["scopes"], "auth.identity.scopes", problems);
  if (!url || label === undefined) return undefined;
  return {
    identity: { url: url.url, label, ...(id === undefined ? {} : { id }) },
    scopes: scopes ?? [],
  };
}

/** What `parseOAuthUserSpec` returns on success, before the registry's rules. */
export interface ParsedOAuthSpec {
  capability: OAuthClientCapability;
  /** Every host a row's rules must accept: the API hosts and the endpoints'. */
  hosts: string[];
}

/**
 * Parse the OAuth half of a spec whose `auth.kind` is `oauth2-user`, with
 * the common fields already parsed. Every problem is reported; on success
 * the capability with its `flow`.
 */
export function parseOAuthUserSpec(
  input: Record<string, unknown>,
  common: OAuthSpecCommon,
  problems: SpecProblem[],
): ParsedOAuthSpec | undefined {
  const auth = input["auth"] as Record<string, unknown>;
  for (const field of Object.keys(auth)) {
    const renamed = RENAMED_AUTH_FIELDS[field];
    if (renamed) {
      problems.push({ path: `auth.${field}`, message: renamed });
    } else if (!(OAUTH_AUTH_FIELDS as readonly string[]).includes(field)) {
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
    { query: true },
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
    problems.push({ path: "auth.revokeMethod", message: "needs a revokeUrl" });
  }
  const clientId = settingName(auth["clientId"], "auth.clientId", problems);
  const clientSecret =
    auth["clientSecret"] === undefined
      ? undefined
      : settingName(auth["clientSecret"], "auth.clientSecret", problems);
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
  const separator = auth["scopeSeparator"] ?? "space";
  if (!(SEPARATORS as readonly unknown[]).includes(separator)) {
    problems.push({
      path: "auth.scopeSeparator",
      message: `must be one of ${SEPARATORS.join(", ")}`,
    });
  }
  const prefix = endpoint(auth["scopePrefix"], "auth.scopePrefix", problems, {
    query: false,
  });
  if (prefix && !prefix.url.endsWith("/")) {
    problems.push({
      path: "auth.scopePrefix",
      message:
        "must end in / (https://www.googleapis.com/auth/): an app's scope is joined onto it",
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
      if (RESERVED_AUTHORIZE_PARAMS.includes(name)) {
        problems.push({
          path: at,
          message:
            name === "include_granted_scopes"
              ? "include_granted_scopes would widen the token beyond the app's scopes; the Gateway never sends it"
              : `${name} is a parameter the Gateway sets itself`,
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
  const tolerated = scopeList(auth["tolerated"], "auth.tolerated", problems);
  if (
    !authorize ||
    !token ||
    clientId === undefined ||
    typeof pkce !== "boolean" ||
    !(SEPARATORS as readonly unknown[]).includes(separator) ||
    !(INJECTIONS as readonly unknown[]).includes(inject)
  ) {
    return undefined;
  }
  const flow: OAuthFlow = {
    authorizeUrl: authorize.url,
    tokenUrl: token.url,
    ...(revoke === undefined ? {} : { revokeUrl: revoke.url }),
    ...(revokeMethod === undefined
      ? {}
      : { revokeMethod: revokeMethod as "POST" | "DELETE" }),
    inject: inject as OAuthClientInjection,
    pkce,
    scopeSeparator: separator as OAuthScopeSeparator,
    ...(prefix === undefined ? {} : { scopePrefix: prefix.url }),
    ...(authorizeParams === undefined ? {} : { authorizeParams }),
    ...(tokenHeaders === undefined ? {} : { tokenHeaders }),
    ...(parsedIdentity === undefined
      ? {}
      : { identity: parsedIdentity.identity }),
    identityScopes: parsedIdentity?.scopes ?? [],
    tolerated: tolerated ?? [],
  };
  const capability = oauthCapabilityOf(
    common,
    {
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
    },
    flow,
  );
  const hosts = [...common.hosts];
  for (const host of [authorize.host, token.host, revoke?.host]) {
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return { capability, hosts };
}

function oauthCapabilityOf(
  common: OAuthSpecCommon,
  secrets: { clientId: string; clientSecret?: string },
  flow: OAuthFlow,
): OAuthClientCapability {
  return {
    mode: "oauth_client",
    label: common.name,
    secrets,
    console: common.docs,
    api: [...common.hosts],
    flow,
    ...(common.description === undefined
      ? {}
      : { description: common.description }),
    ...(common.reference === undefined ? {} : { reference: common.reference }),
    ...(common.hint === undefined ? {} : { hint: common.hint }),
    ...(common.example === undefined ? {} : { example: common.example }),
    ...(common.tags === undefined ? {} : { tags: common.tags }),
  };
}

/** The JSON shape of an `oauth2-user` spec, as the built-ins and presets write it. */
export interface OAuthSpecJson {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly docs: string;
  readonly api?: string;
  readonly hosts: readonly string[];
  readonly auth: {
    readonly kind: "oauth2-user";
    readonly authorizeUrl: string;
    readonly tokenUrl: string;
    readonly revokeUrl?: string;
    readonly revokeMethod?: "POST" | "DELETE";
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly inject?: OAuthClientInjection;
    readonly pkce?: boolean;
    readonly scopeSeparator?: OAuthScopeSeparator;
    readonly scopePrefix?: string;
    readonly authorizeParams?: Readonly<Record<string, string>>;
    readonly tokenHeaders?: Readonly<Record<string, string>>;
    readonly identity?: {
      readonly url: string;
      readonly label: string;
      readonly id?: string;
      readonly scopes?: readonly string[];
    };
    readonly tolerated?: readonly string[];
  };
  readonly hint?: string;
  readonly example?: string;
  readonly tags?: readonly string[];
}

/**
 * A spec already known to be good (a built-in, checked by its test) as
 * its capability, without the parse: what the catalog runs at load, where
 * calling the full parser would be an import cycle.
 */
export function oauthCapabilityFromSpec(
  spec: OAuthSpecJson,
): OAuthClientCapability {
  const { auth } = spec;
  const flow: OAuthFlow = {
    authorizeUrl: auth.authorizeUrl,
    tokenUrl: auth.tokenUrl,
    ...(auth.revokeUrl === undefined ? {} : { revokeUrl: auth.revokeUrl }),
    ...(auth.revokeMethod === undefined
      ? {}
      : { revokeMethod: auth.revokeMethod }),
    inject: auth.inject ?? "form",
    pkce: auth.pkce ?? true,
    scopeSeparator: auth.scopeSeparator ?? "space",
    ...(auth.scopePrefix === undefined
      ? {}
      : { scopePrefix: auth.scopePrefix }),
    ...(auth.authorizeParams === undefined
      ? {}
      : { authorizeParams: { ...auth.authorizeParams } }),
    ...(auth.tokenHeaders === undefined
      ? {}
      : { tokenHeaders: { ...auth.tokenHeaders } }),
    ...(auth.identity === undefined
      ? {}
      : {
          identity: {
            url: auth.identity.url,
            label: auth.identity.label,
            ...(auth.identity.id === undefined ? {} : { id: auth.identity.id }),
          },
        }),
    identityScopes: [...(auth.identity?.scopes ?? [])],
    tolerated: [...(auth.tolerated ?? [])],
  };
  return oauthCapabilityOf(
    {
      id: spec.id,
      name: spec.name,
      docs: spec.docs,
      hosts: spec.hosts,
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
      ...(spec.api === undefined ? {} : { reference: spec.api }),
      ...(spec.hint === undefined ? {} : { hint: spec.hint }),
      ...(spec.example === undefined ? {} : { example: spec.example }),
      ...(spec.tags === undefined ? {} : { tags: spec.tags }),
    },
    {
      clientId: auth.clientId,
      ...(auth.clientSecret === undefined
        ? {}
        : { clientSecret: auth.clientSecret }),
    },
    flow,
  );
}

/**
 * The JSON spec of an OAuth capability (`provider show`, a preset's round
 * trip): `parseProviderSpec` of it gives the capability back.
 */
export function oauthSpecOf(
  id: string,
  capability: OAuthClientCapability,
): Record<string, unknown> {
  const { flow } = capability;
  const identity =
    flow.identity === undefined
      ? undefined
      : {
          ...flow.identity,
          ...(flow.identityScopes.length === 0
            ? {}
            : { scopes: [...flow.identityScopes] }),
        };
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
      authorizeUrl: flow.authorizeUrl,
      tokenUrl: flow.tokenUrl,
      ...(flow.revokeUrl === undefined ? {} : { revokeUrl: flow.revokeUrl }),
      ...(flow.revokeMethod === undefined
        ? {}
        : { revokeMethod: flow.revokeMethod }),
      clientId: capability.secrets.clientId,
      ...(capability.secrets.clientSecret === undefined
        ? {}
        : { clientSecret: capability.secrets.clientSecret }),
      inject: flow.inject,
      pkce: flow.pkce,
      scopeSeparator: flow.scopeSeparator,
      ...(flow.scopePrefix === undefined
        ? {}
        : { scopePrefix: flow.scopePrefix }),
      ...(flow.authorizeParams === undefined
        ? {}
        : { authorizeParams: { ...flow.authorizeParams } }),
      ...(flow.tokenHeaders === undefined
        ? {}
        : { tokenHeaders: { ...flow.tokenHeaders } }),
      ...(identity === undefined ? {} : { identity }),
      ...(flow.tolerated.length === 0
        ? {}
        : { tolerated: [...flow.tolerated] }),
    },
    ...(capability.hint === undefined ? {} : { hint: capability.hint }),
    ...(capability.example === undefined
      ? {}
      : { example: capability.example }),
    ...(capability.tags === undefined ? {} : { tags: [...capability.tags] }),
  };
}
