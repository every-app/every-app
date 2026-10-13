/**
 * Dynamic client registration (RFC 7591) as the library gets it: small,
 * and holding only what Every App uses.
 *
 * Anyone may register, and each registration is stored in OAUTH_KV for
 * months, so a registration is read with a 16 KiB cap and reaches the
 * library holding only the metadata it needs: the client's name (control
 * and formatting characters removed, clipped to 200 characters), at most
 * ten redirect URIs of at most 2 KiB each, its grant and response types,
 * and its token endpoint authentication method. Contacts, logo, policy and
 * terms URIs, localized variants and the rest are dropped: no page shows
 * them, and a client's own say-so about them is worth nothing anyway.
 *
 * And, ported from OpenSEO's connector (which Claude, Codex and Cursor use
 * daily): RFC 7591 says a registration that omits
 * `token_endpoint_auth_method` gets `client_secret_basic`, and the library
 * follows it. But most MCP clients that omit it are public clients that
 * never keep the secret they're issued, so they fail on their first
 * refresh. Such a registration is registered as public (`none`, PKCE
 * required) instead, unless it names a redirect URI of a client known to
 * keep its secret, or says it supports methods that don't include `none`.
 */
import { payloadTooLarge, readBodyWithLimit, withBody } from "./body";

const PUBLIC_CLIENT_AUTH_METHOD = "none";
const CONFIDENTIAL_CLIENT_AUTH_METHOD = "client_secret_post";
// Registers without a method but needs a real secret.
const CONFIDENTIAL_CLIENT_REDIRECT_URIS = new Set([
  "https://www.perplexity.ai/api/mcp/oauth/callback",
]);
const MAX_REGISTRATION_BODY_BYTES = 16 * 1024;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
/** grant_types, response_types and the methods a client supports. */
const MAX_LIST_ENTRIES = 10;
const MAX_TOKEN_LENGTH = 100;

/**
 * The registration request for the library: its body read (refused past
 * 16 KiB), reduced to what Every App keeps and, for a client that names no
 * method, given one. A body that isn't a JSON object passes through for
 * the library to refuse.
 */
export async function normalizeClientRegistrationRequest(
  request: Request,
): Promise<Request | Response> {
  if (request.method !== "POST") return request;
  const body = await readBodyWithLimit(request, MAX_REGISTRATION_BODY_BYTES);
  if (!body) return payloadTooLarge("16 KiB");

  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return withBody(request, body);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return withBody(request, body);
  }
  const kept = keptMetadata(metadata as Record<string, unknown>);
  if (kept instanceof Response) return kept;
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return withBody(request, JSON.stringify(withAuthMethod(kept)), headers);
}

function invalidRedirectUri(description: string): Response {
  return Response.json(
    { error: "invalid_redirect_uri", error_description: description },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}

/** A client's self-chosen name, without control or formatting characters. */
function cleanName(name: string): string | undefined {
  const characters = [
    ...name
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  ];
  return characters.length
    ? characters.slice(0, MAX_CLIENT_NAME_LENGTH).join("")
    : undefined;
}

/** A list of short strings, or undefined when it isn't one. */
function tokenList(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length <= MAX_LIST_ENTRIES &&
    value.every(
      (entry) => typeof entry === "string" && entry.length <= MAX_TOKEN_LENGTH,
    )
    ? (value as string[])
    : undefined;
}

/**
 * The metadata the library gets: only the fields Every App uses, the name
 * cleaned and clipped. Too many redirect URIs, or one too long, refuse the
 * registration: dropping one could drop the one the client uses.
 */
function keptMetadata(
  fields: Record<string, unknown>,
): Record<string, unknown> | Response {
  const kept: Record<string, unknown> = {};
  const redirectUris = fields["redirect_uris"];
  if (Array.isArray(redirectUris)) {
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      return invalidRedirectUri(
        `At most ${MAX_REDIRECT_URIS} redirect URIs may be registered.`,
      );
    }
    if (
      redirectUris.some(
        (uri) =>
          typeof uri === "string" && uri.length > MAX_REDIRECT_URI_LENGTH,
      )
    ) {
      return invalidRedirectUri(
        `A redirect URI may be at most ${MAX_REDIRECT_URI_LENGTH} characters.`,
      );
    }
  }
  // Anything malformed is the library's to refuse.
  if (redirectUris !== undefined) kept["redirect_uris"] = redirectUris;
  const name =
    typeof fields["client_name"] === "string"
      ? cleanName(fields["client_name"])
      : undefined;
  if (name) kept["client_name"] = name;
  for (const field of [
    "grant_types",
    "response_types",
    "token_endpoint_auth_methods_supported",
  ]) {
    const list = tokenList(fields[field]);
    if (list) kept[field] = list;
    else if (fields[field] !== undefined) kept[field] = fields[field];
  }
  const method = fields["token_endpoint_auth_method"];
  if (method !== undefined) {
    kept["token_endpoint_auth_method"] =
      typeof method === "string" ? method.slice(0, MAX_TOKEN_LENGTH) : method;
  }
  return kept;
}

/** The registration with the method it should get. */
function withAuthMethod(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (fields["token_endpoint_auth_method"] !== undefined) return fields;

  const redirectUris = Array.isArray(fields["redirect_uris"])
    ? fields["redirect_uris"]
    : [];
  const method = redirectUris.some(
    (uri) =>
      typeof uri === "string" && CONFIDENTIAL_CLIENT_REDIRECT_URIS.has(uri),
  )
    ? CONFIDENTIAL_CLIENT_AUTH_METHOD
    : PUBLIC_CLIENT_AUTH_METHOD;
  // A client that lists the methods it supports gets its own choice.
  const supported = fields["token_endpoint_auth_methods_supported"];
  if (Array.isArray(supported) && !supported.includes(method)) return fields;

  return { ...fields, token_endpoint_auth_method: method };
}
