/**
 * The `oauth_client` capability's wire rules (docs/capabilities.md "OAuth
 * clients"), shared by the gateway, which puts the operator's client on an
 * app's token request, and the SDK's local-dev fallback, which puts the
 * developer's own on it the same way.
 */
import {
  base64Utf8,
  oauthClientOrigin,
  type CapabilitySettings,
  type OAuthClientCapability,
  type OAuthTokenEndpoint,
} from "./capabilities.js";

/** The largest token request body the gateway reads: real ones are a few hundred bytes. */
export const OAUTH_TOKEN_BODY_LIMIT = 64 * 1024;

/** An OAuth client as the gateway (or `.dev.vars`) holds it. */
export interface OAuthClientCredentials {
  clientId: string;
  /** Absent for a public client. */
  clientSecret?: string;
}

/**
 * The client `settings` hold for `capability`, or null until every setting
 * it needs is set: the id, the secret (unless it is a public client), and a
 * `hostSetting` that is an https origin when it is set at all.
 */
export function oauthClientCredentials(
  capability: OAuthClientCapability,
  settings: CapabilitySettings,
): OAuthClientCredentials | null {
  const clientId = settingValue(settings[capability.secrets.clientId]);
  const secretName = capability.secrets.clientSecret;
  const clientSecret = secretName
    ? settingValue(settings[secretName])
    : undefined;
  if (!clientId || (secretName && !clientSecret)) return null;
  if (capability.hostSetting && !oauthClientOrigin(capability, settings)) {
    return null;
  }
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

function settingValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A token request: where it goes, its headers, its (buffered) body. */
export interface TokenRequest {
  url: URL;
  headers: Headers;
  body: string | null;
}

export type InjectedTokenRequest =
  | ({ ok: true } & TokenRequest)
  | { ok: false; problem: string };

const FORM = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";

/**
 * `request` with `client` put where `rule` says (the form body, HTTP Basic,
 * the query string or the JSON body), and every client credential the app
 * sent removed wherever it was: the `Authorization` header, and
 * `client_id`/`client_secret` (or the rule's names for them, in any case) in
 * the query string and the body. Bodies are re-serialised from their parsed
 * values, so a crafted body can't carry a second secret past the parser.
 * Token requests are form-encoded or JSON; anything else is refused.
 */
export function injectClientCredentials(
  request: TokenRequest,
  rule: OAuthTokenEndpoint,
  client: OAuthClientCredentials,
): InjectedTokenRequest {
  const idName = rule.params?.clientId ?? "client_id";
  const secretName = rule.params?.clientSecret ?? "client_secret";
  const credentialNames = new Set(
    ["client_id", "client_secret", idName, secretName].map((name) =>
      name.toLowerCase(),
    ),
  );
  const isCredential = (name: string) =>
    credentialNames.has(name.toLowerCase());
  const fields: [string, string][] = [
    [idName, client.clientId],
    ...(client.clientSecret
      ? [[secretName, client.clientSecret] as [string, string]]
      : []),
  ];

  // The query keeps the app's other fields as they were sent.
  const url = new URL(request.url);
  const query = url.search
    .slice(1)
    .split("&")
    .filter((pair) => {
      const [name] = new URLSearchParams(pair).keys();
      return pair !== "" && !(name !== undefined && isCredential(name));
    });
  if (rule.inject === "query") {
    query.push(new URLSearchParams(fields).toString());
  }
  url.search = query.join("&");

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("content-length");
  if (rule.inject === "basic") {
    headers.set(
      "authorization",
      `Basic ${base64Utf8(`${client.clientId}:${client.clientSecret ?? ""}`)}`,
    );
  }

  const type = mediaType(headers.get("content-type"));
  let body = request.body;
  if (body === null || body === "") {
    // Nothing the app sent; the form and JSON rules make the body.
    if (rule.inject === "form") {
      headers.set("content-type", FORM);
      body = new URLSearchParams(fields).toString();
    } else if (rule.inject === "json") {
      headers.set("content-type", JSON_TYPE);
      body = JSON.stringify(Object.fromEntries(fields));
    }
  } else if (type === FORM) {
    if (rule.inject === "json") {
      return { ok: false, problem: "This token endpoint takes a JSON body." };
    }
    const params = new URLSearchParams(body);
    for (const name of new Set([...params.keys()].filter(isCredential))) {
      params.delete(name);
    }
    if (rule.inject === "form") {
      for (const [name, value] of fields) params.set(name, value);
    }
    body = params.toString();
  } else if (type === JSON_TYPE) {
    if (rule.inject === "form") {
      return {
        ok: false,
        problem: `This token endpoint takes a form-encoded body (${FORM}).`,
      };
    }
    const parsed = jsonObject(body);
    if (!parsed) {
      return { ok: false, problem: "The body is not a JSON object." };
    }
    for (const name of Object.keys(parsed)) {
      if (isCredential(name)) delete parsed[name];
    }
    if (rule.inject === "json") {
      for (const [name, value] of fields) parsed[name] = value;
    }
    body = JSON.stringify(parsed);
  } else {
    return {
      ok: false,
      problem: `A token request's body is form-encoded (${FORM}) or JSON (${JSON_TYPE}).`,
    };
  }
  return { ok: true, url, headers, body };
}

/** The grant types logs may name; anything else is logged as `other`. */
const GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "fb_exchange_token",
  "ig_exchange_token",
  "th_exchange_token",
  "urn:ietf:params:oauth:grant-type:token-exchange",
]);

/**
 * A token request's `grant_type`, from its body or query string, for logs:
 * one of the known grant types, `other`, or null when it names none (Meta's
 * code exchange). Never the request's other fields.
 */
export function tokenGrantType(request: TokenRequest): string | null {
  let value: unknown = null;
  const type = mediaType(request.headers.get("content-type"));
  if (request.body && type === FORM) {
    value = new URLSearchParams(request.body).get("grant_type");
  } else if (request.body && type === JSON_TYPE) {
    value = jsonObject(request.body)?.["grant_type"] ?? null;
  }
  value ??= request.url.searchParams.get("grant_type");
  if (typeof value !== "string" || !value) return null;
  return GRANT_TYPES.has(value) ? value : "other";
}

/** A Content-Type's media type, lowercased and without parameters. */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
