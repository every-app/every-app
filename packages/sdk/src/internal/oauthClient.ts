/**
 * The `oauth_client` capability's wire rules (docs/capabilities.md "OAuth
 * clients"), shared by the gateway, which puts the operator's client on an
 * app's token request, and the SDK's local-dev fallback, which puts the
 * developer's own on it the same way.
 */
import {
  base64Utf8,
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
 * it needs is set: the id, and the secret unless it is a public client.
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

const isCredential = (name: string) =>
  ["client_id", "client_secret"].includes(name.toLowerCase());

/**
 * `request` with `client` put where `rule` says (the form body or HTTP
 * Basic), and every client credential the app sent removed wherever it
 * was: the `Authorization` header, and `client_id`/`client_secret` (in any
 * case) in the query string and the body. The body is re-serialised from
 * its parsed values, so a crafted body can't carry a second secret past
 * the parser. Token requests are form-encoded; anything else is refused.
 */
export function injectClientCredentials(
  request: TokenRequest,
  rule: OAuthTokenEndpoint,
  client: OAuthClientCredentials,
): InjectedTokenRequest {
  const fields: [string, string][] = [
    ["client_id", client.clientId],
    ...(client.clientSecret
      ? [["client_secret", client.clientSecret] as [string, string]]
      : []),
  ];

  // The query keeps the app's other fields as they were sent.
  const url = new URL(request.url);
  url.search = url.search
    .slice(1)
    .split("&")
    .filter((pair) => {
      const [name] = new URLSearchParams(pair).keys();
      return pair !== "" && !(name !== undefined && isCredential(name));
    })
    .join("&");

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("content-length");
  if (rule.inject === "basic") {
    headers.set(
      "authorization",
      `Basic ${base64Utf8(`${client.clientId}:${client.clientSecret ?? ""}`)}`,
    );
  }

  let body = request.body;
  if (body === null || body === "") {
    // Nothing the app sent; the form rule makes the body.
    if (rule.inject === "form") {
      headers.set("content-type", FORM);
      body = new URLSearchParams(fields).toString();
    }
  } else if (mediaType(headers.get("content-type")) === FORM) {
    const params = new URLSearchParams(body);
    for (const name of new Set([...params.keys()].filter(isCredential))) {
      params.delete(name);
    }
    if (rule.inject === "form") {
      for (const [name, value] of fields) params.set(name, value);
    }
    body = params.toString();
  } else {
    return {
      ok: false,
      problem: `A token request's body is form-encoded (${FORM}).`,
    };
  }
  return { ok: true, url, headers, body };
}

/** The grant types logs may name; anything else is logged as `other`. */
const GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:token-exchange",
]);

/**
 * The grants the gateway completes: each ends in a user's own tokens. The
 * client-credentials grant, and anything else a network serves on the same
 * endpoint, would mint a token for the gateway's own application instead,
 * which on many providers manages the application's settings, its
 * webhooks and every tenant's tokens.
 */
export const USER_BOUND_GRANT_TYPES: ReadonlySet<string> = new Set([
  "authorization_code",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:token-exchange",
]);

/**
 * A token request's `grant_type` as the app sent it, from its body or query
 * string, or null when it names none (Slack's code exchange). Never the
 * request's other fields.
 */
export function requestedGrantType(request: TokenRequest): string | null {
  let value: unknown = null;
  const type = mediaType(request.headers.get("content-type"));
  if (request.body && type === FORM) {
    value = new URLSearchParams(request.body).get("grant_type");
  }
  value ??= request.url.searchParams.get("grant_type");
  return typeof value === "string" && value ? value : null;
}

/**
 * A token request's `grant_type` for logs: one of the known grant types,
 * `other`, or null when it names none.
 */
export function tokenGrantType(request: TokenRequest): string | null {
  const value = requestedGrantType(request);
  if (value === null) return null;
  return GRANT_TYPES.has(value) ? value : "other";
}

/** A Content-Type's media type, lowercased and without parameters. */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}
