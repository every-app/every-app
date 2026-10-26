/**
 * A provider spec: the shape `everyapp provider add` takes as JSON (and
 * `everyapp_provider_add` as a tool argument), and the shape every
 * built-in catalog entry has in TypeScript (./capabilities.ts), so a
 * catalog entry is nothing a row couldn't be. `parseProviderSpec` turns
 * JSON into an {@link ApiKeyCapability} or names every problem; nothing
 * here reads a value: a spec names Gateway settings, never holds one.
 *
 * Three kinds parse: API-key providers (`auth.kind` bearer, header, query
 * or basic), OAuth providers (`auth.kind` oauth2-user, the half in
 * ./oauthSpec.ts: the Gateway runs the flow and holds the tokens,
 * docs/design/2026-10-oauth-providers.md), and OpenAI-compatible model
 * providers (`mode: "ai"`: a `baseUrl`, the key's placement, the models
 * it serves and the default, its inference routes; the AI proxy serves a
 * row exactly as it serves a catalog `ai` entry, inference POSTs alone,
 * `store: false` on chat, the usage tap, so a new model vendor is a
 * registered spec, not a catalog release).
 *
 * The rules that make a row safe on a particular gateway (its secret names
 * are its own, its hosts are public, it shadows no catalog entry) are the
 * registry's (./providerRegistry.ts), run after this parse.
 */
import {
  DEFAULT_WRITE_METHODS,
  authSettingNames,
  type AiProviderCapability,
  type ApiKeyAuth,
  type ApiKeyCapability,
  type OAuthClientCapability,
  type ProviderCost,
  type ProviderRate,
  type ProviderSecretDetail,
  type ProviderVerification,
  type SmokeRequest,
} from "./capabilities.js";
import { oauthSpecOf, parseOAuthUserSpec } from "./oauthSpec.js";

/** A provider id: lowercase, a letter first, 2 to 40 characters. */
export const PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** A Gateway setting name a provider may hold: upper case, 3 to 64 characters. */
export const PROVIDER_SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
/** A bare lowercase host with at least one dot: labels of letters, digits and hyphens. */
export const PROVIDER_HOST =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const SEGMENT = /^[a-z0-9_-]{1,64}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const QUERY_PARAM = /^[A-Za-z0-9_.-]{1,64}$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
/**
 * A JSON field name, or a dotted path to a nested one (`usage.cost`, at
 * most four segments): the capability proxy reads a top-level name off the
 * answer's head, the AI proxy a path into the usage object off its tail.
 */
const RESPONSE_FIELD =
  /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[a-z][a-z0-9-]{0,31}$/;
/** Control and format characters: in no text a spec carries. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
/** Headers the proxy sets or strips itself: a spec can't put the key in one. */
const RESERVED_HEADERS = new Set([
  "host",
  "cookie",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
const MAX_HOSTS = 20;
const MAX_ACCOUNT_WIDE_PATHS = 50;
/** An inference route an `ai` row names: `/v1/chat/completions`, segments of lowercase letters, digits, `_` and `-`. */
const AI_ROUTE = /^(?:\/[a-z0-9_-]+)+$/;
const MAX_AI_ROUTES = 20;
const MAX_MODELS = 100;
/** A model name as OpenAI-compatible APIs spell them: `gpt-6-luna`, `meta-llama/llama-4`, `claude-haiku-5-5:beta`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
/** What an `ai` row serves by default: chat, and embeddings when it names an embeddings model. */
export const AI_SPEC_CHAT_ROUTE = "/v1/chat/completions";
export const AI_SPEC_EMBEDDINGS_ROUTE = "/v1/embeddings";

const KNOWN_FIELDS = new Set([
  "id",
  "mode",
  "name",
  "description",
  "docs",
  "api",
  "hosts",
  "hostSetting",
  "data",
  "auth",
  "secrets",
  "access",
  "readMethods",
  "writeMethods",
  "accountWidePaths",
  "hint",
  "smoke",
  "cost",
  "rate",
  "example",
  "verified",
  "tags",
  // An `oauth2-user` spec's own (./oauthSpec.ts).
  "scopeSets",
  "alwaysRequested",
  "tolerated",
  // An `ai` spec's own.
  "baseUrl",
  "models",
  "defaultModel",
  "embeddingsModel",
  "routes",
  "chatRoute",
  "embeddingsRoute",
]);
/** Fields only an `ai` spec has. */
const AI_ONLY_FIELDS = [
  "baseUrl",
  "models",
  "defaultModel",
  "embeddingsModel",
  "routes",
  "chatRoute",
  "embeddingsRoute",
] as const;
/** Fields an `ai` spec never has: the key goes to one base URL, and the AI proxy's rules replace the capability proxy's. */
const NOT_AI_FIELDS = [
  "hosts",
  "hostSetting",
  "data",
  "access",
  "readMethods",
  "writeMethods",
  "accountWidePaths",
  ...OAUTH_ONLY_FIELDS_LIST(),
] as const;
function OAUTH_ONLY_FIELDS_LIST(): readonly string[] {
  return ["scopeSets", "alwaysRequested", "tolerated"];
}
/** Fields an API-key spec has that an `oauth2-user` spec does not. */
const API_KEY_ONLY_FIELDS = [
  "hostSetting",
  "data",
  "secrets",
  "accountWidePaths",
  "smoke",
  "cost",
  "rate",
  "verified",
] as const;
const OAUTH_ONLY_FIELDS = [
  "scopeSets",
  "alwaysRequested",
  "tolerated",
] as const;

export interface ProviderSpecProblem {
  /** Dotted: `auth.secret`, `hosts.1`, or `(root)`. */
  path: string;
  message: string;
}

/** What a row or a preset may be: an API key, an OAuth provider with a `flow`, or an OpenAI-compatible model provider. */
export type RegistrableCapability =
  | ApiKeyCapability
  | OAuthClientCapability
  | AiProviderCapability;

export type ParsedProviderSpec =
  | { ok: true; id: string; capability: RegistrableCapability }
  | { ok: false; problems: ProviderSpecProblem[] };

type Problems = ProviderSpecProblem[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(
  value: unknown,
  path: string,
  problems: Problems,
  { max, min = 1 }: { max: number; min?: number },
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push({ path, message: "must be a string" });
    return undefined;
  }
  if (value.length < min || value.length > max) {
    problems.push({
      path,
      message: `must be ${min} to ${max} characters`,
    });
    return undefined;
  }
  if (UNPRINTABLE.test(value)) {
    problems.push({ path, message: "holds a control character" });
    return undefined;
  }
  return value;
}

function httpsUrl(
  value: unknown,
  path: string,
  problems: Problems,
): string | undefined {
  const url = text(value, path, problems, { max: 500 });
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push({ path, message: "must be an https URL" });
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    problems.push({ path, message: "must be an https URL" });
    return undefined;
  }
  return url;
}

function stringList(
  value: unknown,
  path: string,
  problems: Problems,
  { max, each }: { max: number; each: (item: string, at: string) => void },
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push({ path, message: "must be a list" });
    return undefined;
  }
  if (value.length > max) {
    problems.push({ path, message: `at most ${max} entries` });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      problems.push({ path: `${path}.${index}`, message: "must be a string" });
      return;
    }
    each(item, `${path}.${index}`);
    out.push(item);
  });
  if (new Set(out).size !== out.length) {
    problems.push({ path, message: "lists an entry twice" });
  }
  return out;
}

function methods(
  value: unknown,
  path: string,
  problems: Problems,
): string[] | undefined {
  return stringList(value, path, problems, {
    max: METHODS.length,
    each: (method, at) => {
      if (!(METHODS as readonly string[]).includes(method)) {
        problems.push({
          path: at,
          message: `must be one of ${METHODS.join(", ")}`,
        });
      }
    },
  });
}

function secretName(
  value: unknown,
  path: string,
  problems: Problems,
): string | undefined {
  if (typeof value !== "string" || !PROVIDER_SECRET_NAME.test(value)) {
    problems.push({
      path,
      message:
        "must name a Gateway setting: upper case letters, digits and underscores, a letter first, 3 to 64 characters (STRIPE_API_KEY)",
    });
    return undefined;
  }
  return value;
}

function auth(value: unknown, problems: Problems): ApiKeyAuth | undefined {
  if (!isRecord(value)) {
    problems.push({
      path: "auth",
      message: "must be an object with a kind: bearer, header, query or basic",
    });
    return undefined;
  }
  const kind = value["kind"];
  const secret = secretName(value["secret"], "auth.secret", problems);
  const known = (fields: string[]) => {
    for (const field of Object.keys(value)) {
      if (!fields.includes(field)) {
        problems.push({
          path: `auth.${field}`,
          message: `not a field of auth.kind ${String(kind)}`,
        });
      }
    }
  };
  switch (kind) {
    case "bearer": {
      known(["kind", "secret", "scheme"]);
      const scheme = text(value["scheme"], "auth.scheme", problems, {
        max: 32,
      });
      if (scheme !== undefined && !SCHEME.test(scheme)) {
        problems.push({
          path: "auth.scheme",
          message: "must be a token such as Bearer, Token or Api-Key",
        });
      }
      if (!secret) return undefined;
      return { kind, secret, ...(scheme === undefined ? {} : { scheme }) };
    }
    case "header": {
      known(["kind", "secret", "header", "prefix"]);
      const header = text(value["header"], "auth.header", problems, {
        max: 64,
      });
      if (header !== undefined) {
        if (!HEADER_NAME.test(header)) {
          problems.push({
            path: "auth.header",
            message: "must be a header name (letters, digits, hyphens)",
          });
        } else if (
          RESERVED_HEADERS.has(header.toLowerCase()) ||
          header.toLowerCase().startsWith("x-everyapp-")
        ) {
          problems.push({
            path: "auth.header",
            message: `${header} is a header the Gateway sets or strips itself`,
          });
        }
      }
      const prefix = text(value["prefix"], "auth.prefix", problems, {
        max: 32,
        min: 0,
      });
      if (!secret || header === undefined) return undefined;
      return {
        kind,
        secret,
        header,
        ...(prefix === undefined ? {} : { prefix }),
      };
    }
    case "query": {
      known(["kind", "secret", "param"]);
      const param = text(value["param"], "auth.param", problems, { max: 64 });
      if (param !== undefined && !QUERY_PARAM.test(param)) {
        problems.push({
          path: "auth.param",
          message: "must be a query parameter name",
        });
      }
      if (!secret || param === undefined) return undefined;
      return { kind, secret, param };
    }
    case "basic": {
      known(["kind", "secret", "as", "user"]);
      const as = value["as"];
      if (as !== "password" && as !== "username" && as !== "pair") {
        problems.push({
          path: "auth.as",
          message:
            'must say where the key goes: "password" (beside user), "username" (with an empty password), or "pair" (the key is login:password)',
        });
        return undefined;
      }
      if (as !== "password") {
        if (value["user"] !== undefined) {
          problems.push({
            path: "auth.user",
            message: `not a field of auth.as ${as}`,
          });
        }
        if (!secret) return undefined;
        return { kind, secret, as };
      }
      const raw = value["user"];
      let user: string | { secret: string } | undefined;
      if (typeof raw === "string") {
        const literal = text(raw, "auth.user", problems, { max: 128 });
        if (literal !== undefined && literal.includes(":")) {
          problems.push({ path: "auth.user", message: "may not hold a colon" });
        }
        user = literal;
      } else if (isRecord(raw) && Object.keys(raw).join() === "secret") {
        const named = secretName(raw["secret"], "auth.user.secret", problems);
        if (named !== undefined && named === secret) {
          problems.push({
            path: "auth.user.secret",
            message: "must be another setting than auth.secret",
          });
        }
        user = named === undefined ? undefined : { secret: named };
      } else {
        problems.push({
          path: "auth.user",
          message: "required with as: password: a string, or { secret: NAME }",
        });
      }
      if (!secret || user === undefined) return undefined;
      return { kind, secret, as, user };
    }
    default:
      problems.push({
        path: "auth.kind",
        message:
          "must be bearer, header, query, basic or oauth2-user (an AI provider is a catalog entry, not a spec this gateway takes)",
      });
      return undefined;
  }
}

function secretDetails(
  value: unknown,
  names: readonly string[],
  problems: Problems,
): ProviderSecretDetail[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push({ path: "secrets", message: "must be a list" });
    return undefined;
  }
  const out: ProviderSecretDetail[] = [];
  value.forEach((item, index) => {
    const at = `secrets.${index}`;
    if (!isRecord(item)) {
      problems.push({ path: at, message: "must be an object" });
      return;
    }
    for (const field of Object.keys(item)) {
      if (!["name", "hint"].includes(field)) {
        problems.push({ path: `${at}.${field}`, message: "unknown field" });
      }
    }
    const name = secretName(item["name"], `${at}.name`, problems);
    if (name !== undefined && !names.includes(name)) {
      problems.push({
        path: `${at}.name`,
        message: `auth names no setting ${name}`,
      });
    }
    const hint = text(item["hint"], `${at}.hint`, problems, { max: 300 });
    if (name === undefined) return;
    out.push({ name, ...(hint === undefined ? {} : { hint }) });
  });
  if (new Set(out.map((detail) => detail.name)).size !== out.length) {
    problems.push({ path: "secrets", message: "names a setting twice" });
  }
  return out;
}

function accountWidePaths(
  value: unknown,
  problems: Problems,
): string[][] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push({
      path: "accountWidePaths",
      message: 'must be a list of segment runs: [["v1", "account"]]',
    });
    return undefined;
  }
  if (value.length > MAX_ACCOUNT_WIDE_PATHS) {
    problems.push({
      path: "accountWidePaths",
      message: `at most ${MAX_ACCOUNT_WIDE_PATHS} entries`,
    });
    return undefined;
  }
  const out: string[][] = [];
  value.forEach((run, index) => {
    const at = `accountWidePaths.${index}`;
    if (!Array.isArray(run) || run.length === 0) {
      problems.push({
        path: at,
        message: "must be a non-empty list of segments",
      });
      return;
    }
    const segments: string[] = [];
    run.forEach((segment, offset) => {
      if (typeof segment !== "string" || !SEGMENT.test(segment)) {
        problems.push({
          path: `${at}.${offset}`,
          message:
            "must be a lowercase path segment (letters, digits, _ and -)",
        });
        return;
      }
      segments.push(segment);
    });
    if (segments.length === run.length) out.push(segments);
  });
  return out;
}

function smoke(
  value: unknown,
  hosts: readonly string[],
  problems: Problems,
): SmokeRequest | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push({ path: "smoke", message: "must be an object" });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!["method", "host", "path", "expect", "free", "note"].includes(field)) {
      problems.push({ path: `smoke.${field}`, message: "unknown field" });
    }
  }
  const method = value["method"];
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    problems.push({
      path: "smoke.method",
      message: "must be GET, HEAD or POST",
    });
  }
  const host = text(value["host"], "smoke.host", problems, { max: 253 });
  if (host !== undefined && !hosts.includes(host)) {
    problems.push({ path: "smoke.host", message: "must be one of hosts" });
  }
  const path = text(value["path"], "smoke.path", problems, { max: 500 });
  if (path !== undefined && (!path.startsWith("/") || path.startsWith("//"))) {
    problems.push({ path: "smoke.path", message: "must start with one /" });
  }
  const expect = value["expect"];
  const statuses =
    Array.isArray(expect) &&
    expect.length > 0 &&
    expect.every(
      (status) =>
        Number.isInteger(status) &&
        (status as number) >= 100 &&
        (status as number) <= 599,
    )
      ? (expect as number[])
      : undefined;
  if (!statuses) {
    problems.push({
      path: "smoke.expect",
      message: "must list the HTTP statuses that mean the key works",
    });
  }
  const free = value["free"];
  if (typeof free !== "boolean") {
    problems.push({ path: "smoke.free", message: "must be true or false" });
  }
  const note = text(value["note"], "smoke.note", problems, { max: 200 });
  if (
    (method !== "GET" && method !== "HEAD" && method !== "POST") ||
    path === undefined ||
    !statuses ||
    typeof free !== "boolean"
  ) {
    return undefined;
  }
  return {
    method,
    ...(host === undefined ? {} : { host }),
    path,
    expect: statuses,
    free,
    ...(note === undefined ? {} : { note }),
  };
}

function nonNegative(
  value: unknown,
  path: string,
  problems: Problems,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    problems.push({ path, message: "must be a number, zero or more" });
    return undefined;
  }
  return value;
}

function cost(value: unknown, problems: Problems): ProviderCost | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push({ path: "cost", message: "must be an object" });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!["unit", "usd", "note", "responseField"].includes(field)) {
      problems.push({ path: `cost.${field}`, message: "unknown field" });
    }
  }
  const unit = value["unit"];
  if (unit !== "call" && unit !== "result" && unit !== "token") {
    problems.push({
      path: "cost.unit",
      message: "must be call, result or token",
    });
  }
  const usd = nonNegative(value["usd"], "cost.usd", problems);
  const note = text(value["note"], "cost.note", problems, { max: 200 });
  const responseField = text(
    value["responseField"],
    "cost.responseField",
    problems,
    { max: 128 },
  );
  if (responseField !== undefined && !RESPONSE_FIELD.test(responseField)) {
    problems.push({
      path: "cost.responseField",
      message: "must be a JSON field name, or a dotted path to a nested one",
    });
  }
  if (unit !== "call" && unit !== "result" && unit !== "token")
    return undefined;
  return {
    unit,
    ...(usd === undefined ? {} : { usd }),
    ...(note === undefined ? {} : { note }),
    ...(responseField === undefined ? {} : { responseField }),
  };
}

function rate(value: unknown, problems: Problems): ProviderRate | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push({ path: "rate", message: "must be an object" });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!["perSecond", "perMinute", "perDay", "note"].includes(field)) {
      problems.push({ path: `rate.${field}`, message: "unknown field" });
    }
  }
  const perSecond = nonNegative(value["perSecond"], "rate.perSecond", problems);
  const perMinute = nonNegative(value["perMinute"], "rate.perMinute", problems);
  const perDay = nonNegative(value["perDay"], "rate.perDay", problems);
  const note = text(value["note"], "rate.note", problems, { max: 200 });
  return {
    ...(perSecond === undefined ? {} : { perSecond }),
    ...(perMinute === undefined ? {} : { perMinute }),
    ...(perDay === undefined ? {} : { perDay }),
    ...(note === undefined ? {} : { note }),
  };
}

function verified(
  value: unknown,
  problems: Problems,
): ProviderVerification | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (
    isRecord(value) &&
    typeof value["on"] === "string" &&
    DATE.test(value["on"]) &&
    (value["how"] === "docs" || value["how"] === "live") &&
    Object.keys(value).length === 2
  ) {
    return { on: value["on"], how: value["how"] };
  }
  problems.push({
    path: "verified",
    message: 'must be false, or { "on": "YYYY-MM-DD", "how": "docs" | "live" }',
  });
  return undefined;
}

/** `access`, `readMethods` and `writeMethods`, shared by both kinds. */
function grants(
  input: Record<string, unknown>,
  problems: Problems,
): {
  access: string[] | undefined;
  readMethods: string[] | undefined;
  writeMethods: string[] | undefined;
} {
  const access = stringList(input["access"], "access", problems, {
    max: 2,
    each: (level, at) => {
      if (level !== "read" && level !== "write") {
        problems.push({ path: at, message: "must be read or write" });
      }
    },
  });
  if (access && access.length === 0) {
    problems.push({ path: "access", message: "must list read, write or both" });
  }
  const readMethods = methods(input["readMethods"], "readMethods", problems);
  // A write-only provider (a sender, a GraphQL API) reads with nothing:
  // every call needs the write grant. Anything that offers read lists how.
  if (
    readMethods &&
    readMethods.length === 0 &&
    (!Array.isArray(access) || access.includes("read"))
  ) {
    problems.push({
      path: "readMethods",
      message: "must list a method unless access is write alone",
    });
  }
  const writeMethods = methods(input["writeMethods"], "writeMethods", problems);
  return { access, readMethods, writeMethods };
}

function tagList(value: unknown, problems: Problems): string[] | undefined {
  return stringList(value, "tags", problems, {
    max: 10,
    each: (tag, at) => {
      if (!TAG.test(tag)) {
        problems.push({ path: at, message: "must be a lowercase word" });
      }
    },
  });
}

/**
 * Parse a provider spec. Every problem is reported, with its path, so a
 * person fixes the file once. On success the id and the catalog-shaped
 * capability, defaults filled in (`access` read, `readMethods` GET and
 * HEAD, no account-wide paths).
 */
export function parseProviderSpec(input: unknown): ParsedProviderSpec {
  const problems: Problems = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      problems: [{ path: "(root)", message: "must be a JSON object" }],
    };
  }
  for (const field of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(field)) {
      problems.push({ path: field, message: "unknown field" });
    }
  }
  const id = input["id"];
  if (typeof id !== "string" || !PROVIDER_ID.test(id)) {
    problems.push({
      path: "id",
      message:
        "must be lowercase letters, digits and hyphens, a letter first, 2 to 40 characters (stripe)",
    });
  }
  const isOAuth =
    isRecord(input["auth"]) && input["auth"]["kind"] === "oauth2-user";
  const isAi = input["mode"] === "ai";
  const expectedMode = isOAuth ? "oauth_client" : "api_key";
  if (!isAi && input["mode"] !== undefined && input["mode"] !== expectedMode) {
    problems.push({
      path: "mode",
      message: isOAuth
        ? "an oauth2-user spec's mode is oauth_client (or left out)"
        : 'this gateway registers api_key, oauth_client (auth.kind oauth2-user) and ai (mode: "ai", an OpenAI-compatible model provider) providers',
    });
  }
  if (isAi && isOAuth) {
    problems.push({
      path: "auth.kind",
      message:
        "an ai spec's key is a bearer, header, query or basic key, never oauth2-user",
    });
  }
  const name = text(input["name"], "name", problems, { max: 64 });
  if (input["name"] === undefined) {
    problems.push({ path: "name", message: "required" });
  }
  const description = text(input["description"], "description", problems, {
    max: 200,
  });
  const docs = httpsUrl(input["docs"], "docs", problems);
  if (input["docs"] === undefined) {
    problems.push({
      path: "docs",
      message: "required: where the person gets the key, an https URL",
    });
  }
  const api = httpsUrl(input["api"], "api", problems);
  const hosts = stringList(input["hosts"], "hosts", problems, {
    max: MAX_HOSTS,
    each: (host, at) => {
      if (!PROVIDER_HOST.test(host)) {
        problems.push({
          path: at,
          message:
            "must be a bare lowercase host with a dot and no port, path or scheme (api.stripe.com)",
        });
      }
    },
  });
  if (isAi && !isOAuth) {
    return parseAiSpec(input, problems, { id, name, description, docs, api });
  }
  if (isOAuth) {
    const { access, readMethods, writeMethods } = grants(input, problems);
    const hint = text(input["hint"], "hint", problems, { max: 500 });
    const example = text(input["example"], "example", problems, { max: 200 });
    const tags = tagList(input["tags"], problems);
    // An OAuth provider: its token goes to `hosts` alone, so the API-key
    // fields that shape a key's placement have no meaning here.
    for (const field of API_KEY_ONLY_FIELDS) {
      if (input[field] !== undefined) {
        problems.push({
          path: field,
          message: "not a field of an oauth2-user spec",
        });
      }
    }
    if (input["hosts"] === undefined || (hosts && hosts.length === 0)) {
      problems.push({
        path: "hosts",
        message: "required: at least one API host the token is sent to",
      });
    }
    const parsed =
      typeof id === "string" &&
      name !== undefined &&
      docs !== undefined &&
      hosts !== undefined
        ? parseOAuthUserSpec(
            input,
            {
              id,
              name,
              docs,
              hosts,
              ...(description === undefined ? {} : { description }),
              ...(api === undefined ? {} : { reference: api }),
              ...(access === undefined
                ? {}
                : { access: access as ("read" | "write")[] }),
              ...(readMethods === undefined ? {} : { readMethods }),
              ...(writeMethods === undefined ? {} : { writeMethods }),
              ...(hint === undefined ? {} : { hint }),
              ...(example === undefined ? {} : { example }),
              ...(tags === undefined ? {} : { tags }),
            },
            problems,
          )
        : undefined;
    if (problems.length > 0 || !parsed || typeof id !== "string") {
      return { ok: false, problems };
    }
    return { ok: true, id, capability: parsed.capability };
  }
  for (const field of OAUTH_ONLY_FIELDS) {
    if (input[field] !== undefined) {
      problems.push({
        path: field,
        message: "only an oauth2-user spec has it",
      });
    }
  }

  const hostSetting =
    input["hostSetting"] === undefined
      ? undefined
      : secretName(input["hostSetting"], "hostSetting", problems);
  if (
    hostSetting === undefined &&
    (input["hosts"] === undefined || (hosts && hosts.length === 0))
  ) {
    problems.push({
      path: "hosts",
      message: "required: at least one host, or a hostSetting naming one",
    });
  }
  const rawData = input["data"];
  if (
    rawData !== undefined &&
    rawData !== "per-call" &&
    rawData !== "account"
  ) {
    problems.push({ path: "data", message: "must be per-call or account" });
  }
  const data: "per-call" | "account" | undefined =
    rawData === "per-call" || rawData === "account" ? rawData : undefined;
  const parsedAuth = auth(input["auth"], problems);
  if (input["auth"] === undefined) {
    problems.push({ path: "auth", message: "required" });
  }
  if (
    hostSetting !== undefined &&
    parsedAuth &&
    authSettingNames(parsedAuth).includes(hostSetting)
  ) {
    problems.push({
      path: "hostSetting",
      message: "must be another setting than the key",
    });
  }
  const secrets = secretDetails(
    input["secrets"],
    [
      ...(parsedAuth ? authSettingNames(parsedAuth) : []),
      ...(hostSetting === undefined ? [] : [hostSetting]),
    ],
    problems,
  );
  const { access, readMethods, writeMethods } = grants(input, problems);
  const paths = accountWidePaths(input["accountWidePaths"], problems);
  const hint = text(input["hint"], "hint", problems, { max: 500 });
  const smokeRequest = smoke(input["smoke"], hosts ?? [], problems);
  const parsedCost = cost(input["cost"], problems);
  const parsedRate = rate(input["rate"], problems);
  const example = text(input["example"], "example", problems, { max: 200 });
  const parsedVerified = verified(input["verified"], problems);
  const tags = tagList(input["tags"], problems);
  if (
    problems.length > 0 ||
    typeof id !== "string" ||
    name === undefined ||
    docs === undefined ||
    (!hosts && hostSetting === undefined) ||
    !parsedAuth
  ) {
    return { ok: false, problems };
  }
  const capability: ApiKeyCapability = {
    mode: "api_key",
    label: name,
    auth: parsedAuth,
    docs,
    hosts: hosts ?? [],
    ...(hostSetting === undefined ? {} : { hostSetting }),
    ...(data === undefined ? {} : { data }),
    access: (access as ("read" | "write")[] | undefined) ?? ["read"],
    readMethods: readMethods ?? ["GET", "HEAD"],
    accountWidePaths: paths ?? [],
    ...(description === undefined ? {} : { description }),
    ...(api === undefined ? {} : { api }),
    ...(secrets === undefined ? {} : { secrets }),
    ...(writeMethods === undefined ? {} : { writeMethods }),
    ...(hint === undefined ? {} : { hint }),
    ...(smokeRequest === undefined ? {} : { smoke: smokeRequest }),
    ...(parsedCost === undefined ? {} : { cost: parsedCost }),
    ...(parsedRate === undefined ? {} : { rate: parsedRate }),
    ...(example === undefined ? {} : { example }),
    ...(parsedVerified === undefined ? {} : { verified: parsedVerified }),
    ...(tags === undefined ? {} : { tags }),
  };
  return { ok: true, id, capability };
}

/**
 * The `ai` half of `parseProviderSpec`: an OpenAI-compatible model
 * provider. `baseUrl` is where the app's path is joined (`https://api.groq.com/openai`:
 * the origin, and a base path the proxy keeps in front of every route);
 * `auth` places the key as an API-key spec does; `models` lists what the
 * provider serves (1 to 100; the proxy refuses any other) with
 * `defaultModel` the one the Gateway's default route fills in and
 * `embeddingsModel` the one for `/api/ai/default/v1/embeddings`; `routes`
 * are the inference paths apps may POST to (default chat, and embeddings
 * with an embeddings model), `chatRoute` and `embeddingsRoute` which of
 * them the default route maps onto. Chat answers are never stored
 * (`store: false` on the chat route). `cost.responseField` is where the
 * answer carries the call's price, read by the usage tap as OpenRouter's
 * `usage.cost` is.
 */
function parseAiSpec(
  input: Record<string, unknown>,
  problems: Problems,
  common: {
    id: unknown;
    name: string | undefined;
    description: string | undefined;
    docs: string | undefined;
    api: string | undefined;
  },
): ParsedProviderSpec {
  for (const field of NOT_AI_FIELDS) {
    if (input[field] !== undefined) {
      problems.push({ path: field, message: "not a field of an ai spec" });
    }
  }
  const base = httpsUrl(input["baseUrl"], "baseUrl", problems);
  let origin: string | undefined;
  let basePath: string | undefined;
  if (input["baseUrl"] === undefined) {
    problems.push({
      path: "baseUrl",
      message:
        "required: the https URL the app's paths are joined onto (https://api.groq.com/openai)",
    });
  } else if (base !== undefined) {
    const url = new URL(base);
    if (url.search || url.hash || url.username || url.password || url.port) {
      problems.push({
        path: "baseUrl",
        message:
          "must be an https URL with no query, fragment, credentials or port",
      });
    } else if (!PROVIDER_HOST.test(url.hostname)) {
      problems.push({
        path: "baseUrl",
        message: "must name a public host with a dot (api.groq.com)",
      });
    } else {
      origin = url.origin;
      const path = url.pathname.replace(/\/+$/, "");
      if (path && !AI_ROUTE.test(path)) {
        problems.push({
          path: "baseUrl",
          message:
            "its path must be segments of lowercase letters, digits, _ and -",
        });
      } else if (path) {
        basePath = path;
      }
    }
  }
  const parsedAuth = auth(input["auth"], problems);
  if (input["auth"] === undefined) {
    problems.push({ path: "auth", message: "required" });
  }
  const secrets = secretDetails(
    input["secrets"],
    parsedAuth ? authSettingNames(parsedAuth) : [],
    problems,
  );
  const models = stringList(input["models"], "models", problems, {
    max: MAX_MODELS,
    each: (model, at) => {
      if (!MODEL_NAME.test(model)) {
        problems.push({
          path: at,
          message: "must be a model name (gpt-6-luna, meta-llama/llama-4)",
        });
      }
    },
  });
  if (input["models"] === undefined || (models && models.length === 0)) {
    problems.push({
      path: "models",
      message: "required: the models the provider serves, at least one",
    });
  }
  const defaultModel = text(input["defaultModel"], "defaultModel", problems, {
    max: 200,
  });
  if (input["defaultModel"] === undefined) {
    problems.push({
      path: "defaultModel",
      message:
        "required: the chat model the Gateway fills in when an app names none; one of models",
    });
  } else if (
    defaultModel !== undefined &&
    models &&
    !models.includes(defaultModel)
  ) {
    problems.push({ path: "defaultModel", message: "must be one of models" });
  }
  const embeddingsModel = text(
    input["embeddingsModel"],
    "embeddingsModel",
    problems,
    { max: 200 },
  );
  if (
    embeddingsModel !== undefined &&
    models &&
    !models.includes(embeddingsModel)
  ) {
    problems.push({
      path: "embeddingsModel",
      message: "must be one of models",
    });
  }
  const routeList = (value: unknown, path: string) =>
    stringList(value, path, problems, {
      max: MAX_AI_ROUTES,
      each: (route, at) => {
        if (!AI_ROUTE.test(route)) {
          problems.push({
            path: at,
            message:
              "must be a path of lowercase segments starting with / (/v1/chat/completions)",
          });
        }
      },
    });
  const chatRoute =
    text(input["chatRoute"], "chatRoute", problems, { max: 200 }) ??
    AI_SPEC_CHAT_ROUTE;
  const embeddingsRoute =
    text(input["embeddingsRoute"], "embeddingsRoute", problems, { max: 200 }) ??
    AI_SPEC_EMBEDDINGS_ROUTE;
  for (const [field, route] of [
    ["chatRoute", chatRoute],
    ["embeddingsRoute", embeddingsRoute],
  ] as const) {
    if (!AI_ROUTE.test(route)) {
      problems.push({
        path: field,
        message: "must be a path of lowercase segments starting with /",
      });
    }
  }
  const routes = routeList(input["routes"], "routes") ?? [
    chatRoute,
    ...(embeddingsModel !== undefined ? [embeddingsRoute] : []),
  ];
  if (routes.length === 0) {
    problems.push({ path: "routes", message: "must list a route" });
  }
  if (!routes.includes(chatRoute)) {
    problems.push({ path: "chatRoute", message: "must be one of routes" });
  }
  if (embeddingsModel !== undefined && !routes.includes(embeddingsRoute)) {
    problems.push({
      path: "embeddingsRoute",
      message: "must be one of routes",
    });
  }
  const hint = text(input["hint"], "hint", problems, { max: 500 });
  const smokeRequest = smoke(
    input["smoke"],
    origin ? [new URL(origin).host] : [],
    problems,
  );
  const parsedCost = cost(input["cost"], problems);
  const parsedRate = rate(input["rate"], problems);
  const example = text(input["example"], "example", problems, { max: 200 });
  const parsedVerified = verified(input["verified"], problems);
  const tags = tagList(input["tags"], problems);
  const { id, name, description, docs, api } = common;
  if (
    problems.length > 0 ||
    typeof id !== "string" ||
    name === undefined ||
    docs === undefined ||
    origin === undefined ||
    !parsedAuth ||
    !models ||
    defaultModel === undefined
  ) {
    return { ok: false, problems };
  }
  const capability: AiProviderCapability = {
    mode: "ai",
    label: name,
    auth: parsedAuth,
    docs,
    origin,
    ...(basePath === undefined ? {} : { basePath }),
    inferenceRoutes: routes,
    unstoredRoutes: [chatRoute],
    shape: "openai",
    chat: { path: chatRoute, seedModel: defaultModel },
    ...(embeddingsModel === undefined
      ? {}
      : { embeddings: { path: embeddingsRoute, seedModel: embeddingsModel } }),
    models,
    ...(description === undefined ? {} : { description }),
    ...(api === undefined ? {} : { api }),
    ...(secrets === undefined ? {} : { secrets }),
    ...(hint === undefined ? {} : { hint }),
    ...(smokeRequest === undefined ? {} : { smoke: smokeRequest }),
    ...(parsedCost === undefined ? {} : { cost: parsedCost }),
    ...(parsedRate === undefined ? {} : { rate: parsedRate }),
    ...(example === undefined ? {} : { example }),
    ...(parsedVerified === undefined ? {} : { verified: parsedVerified }),
    ...(tags === undefined ? {} : { tags }),
  };
  return { ok: true, id, capability };
}

/** The problems as one line: `auth.secret: must name a Gateway setting; hosts.0: …`. */
export function describeSpecProblems(
  problems: readonly ProviderSpecProblem[],
): string {
  return problems
    .map((problem) => `${problem.path}: ${problem.message}`)
    .join("; ");
}

/**
 * The spec of an API-key capability as JSON (`provider show`, the
 * catalog's round trip): the entry's fields in the spec's names, with the
 * defaults the parser fills in spelled out, so `parseProviderSpec` of it
 * gives the entry back.
 */
export function providerSpecOf(
  id: string,
  capability: RegistrableCapability,
): Record<string, unknown> {
  if (capability.mode === "oauth_client") {
    const spec = oauthSpecOf(id, capability);
    if (!spec) {
      throw new Error(
        `${id} is a catalog OAuth client without a Gateway-owned flow: it has no spec`,
      );
    }
    return spec;
  }
  if (capability.mode === "ai") {
    if (!capability.chat || !capability.models) {
      throw new Error(
        `${id} is a catalog AI entry without a model list: it has no spec`,
      );
    }
    return {
      id,
      mode: "ai",
      name: capability.label,
      ...(capability.description === undefined
        ? {}
        : { description: capability.description }),
      docs: capability.docs,
      ...(capability.api === undefined ? {} : { api: capability.api }),
      baseUrl: `${capability.origin}${capability.basePath ?? ""}`,
      auth: { ...capability.auth },
      ...(capability.secrets === undefined
        ? {}
        : { secrets: capability.secrets.map((detail) => ({ ...detail })) }),
      models: [...capability.models],
      defaultModel: capability.chat.seedModel,
      ...(capability.embeddings === undefined
        ? {}
        : { embeddingsModel: capability.embeddings.seedModel }),
      routes: [...capability.inferenceRoutes],
      chatRoute: capability.chat.path,
      ...(capability.embeddings === undefined
        ? {}
        : { embeddingsRoute: capability.embeddings.path }),
      ...(capability.hint === undefined ? {} : { hint: capability.hint }),
      ...(capability.smoke === undefined
        ? {}
        : {
            smoke: {
              ...capability.smoke,
              expect: [...capability.smoke.expect],
            },
          }),
      ...(capability.cost === undefined
        ? {}
        : { cost: { ...capability.cost } }),
      ...(capability.rate === undefined
        ? {}
        : { rate: { ...capability.rate } }),
      ...(capability.example === undefined
        ? {}
        : { example: capability.example }),
      ...(capability.verified === undefined
        ? {}
        : { verified: capability.verified }),
      ...(capability.tags === undefined ? {} : { tags: [...capability.tags] }),
    };
  }
  return {
    id,
    name: capability.label,
    ...(capability.description === undefined
      ? {}
      : { description: capability.description }),
    docs: capability.docs,
    ...(capability.api === undefined ? {} : { api: capability.api }),
    hosts: [...capability.hosts],
    ...(capability.hostSetting === undefined
      ? {}
      : { hostSetting: capability.hostSetting }),
    ...(capability.data === undefined ? {} : { data: capability.data }),
    auth: { ...capability.auth },
    ...(capability.secrets === undefined
      ? {}
      : { secrets: capability.secrets.map((detail) => ({ ...detail })) }),
    access: [...capability.access],
    readMethods: [...capability.readMethods],
    ...(capability.writeMethods === undefined
      ? {}
      : { writeMethods: [...capability.writeMethods] }),
    accountWidePaths: capability.accountWidePaths.map((run) => [...run]),
    ...(capability.hint === undefined ? {} : { hint: capability.hint }),
    ...(capability.smoke === undefined
      ? {}
      : {
          smoke: { ...capability.smoke, expect: [...capability.smoke.expect] },
        }),
    ...(capability.cost === undefined ? {} : { cost: { ...capability.cost } }),
    ...(capability.rate === undefined ? {} : { rate: { ...capability.rate } }),
    ...(capability.example === undefined
      ? {}
      : { example: capability.example }),
    ...(capability.verified === undefined
      ? {}
      : { verified: capability.verified }),
    ...(capability.tags === undefined ? {} : { tags: [...capability.tags] }),
  };
}

/** The methods an app with `access: "write"` may use on `capability` besides its read methods. */
export function writeMethodsOf(
  capability: RegistrableCapability,
): readonly string[] {
  return (
    (capability.mode === "ai" ? undefined : capability.writeMethods) ??
    DEFAULT_WRITE_METHODS
  );
}
