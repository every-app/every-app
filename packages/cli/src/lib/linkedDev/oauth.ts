/**
 * The CLI as an OAuth client of a Gateway, for linked dev
 * (docs/design/linked-dev.md §4.1): the native sign-in flow
 * (docs/design/native-sign-in.md §12) with the resource
 * `${gateway}/linked-dev/<app id>`. Discovery, one dynamic registration
 * per Gateway, PKCE S256, a loopback listener on a free port (RFC 8252
 * §7.3), `state` and `iss` checked, the code exchanged, refreshed and
 * revoked at the Gateway's endpoints. Nothing here reads a cookie or holds
 * a client secret: the CLI is a public client.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { EveryAppError, errorMessage } from "@/lib/errors";
import { CLI } from "@/lib/output/command";

/** Where the linked dev resources live under the issuer (a copy of the Gateway's `LINKED_DEV_PATH`). */
const LINKED_DEV_RESOURCE_PATH = "/linked-dev";
const CALLBACK_PATH = "/callback";
/** Registered once per Gateway; the port is the request's (RFC 8252 §7.3). */
const REGISTERED_REDIRECT = `http://127.0.0.1${CALLBACK_PATH}`;
/** How long the browser has to come back. */
const AUTHORIZE_TIMEOUT_MS = 10 * 60_000;

export interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  resource: string;
}

/** The resource of linked dev for `appId` on `gateway` (its origin). */
export function linkedDevResource(gateway: string, appId: string): string {
  return `${new URL(gateway).origin}${LINKED_DEV_RESOURCE_PATH}/${appId}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The Gateway's authorization-server metadata (RFC 8414). */
export async function discover(
  gateway: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerMetadata> {
  const origin = new URL(gateway).origin;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new EveryAppError(
      "LINKED_DEV_GATEWAY_UNREACHABLE",
      `Can't reach the Gateway at ${origin}\n${errorMessage(error)}`,
      { data: { gateway: origin } },
    );
  }
  const body = await readJson(response);
  if (!response.ok || typeof body["issuer"] !== "string") {
    throw new EveryAppError(
      "LINKED_DEV_OAUTH_OFF",
      `${origin} offers no sign-in for everyapp dev\nIts OAuth server answered ${response.status} on /.well-known/oauth-authorization-server (MCP_OAUTH_ENABLED may be off, or this isn't an Every App Gateway).`,
      { data: { gateway: origin, status: response.status } },
    );
  }
  if (body["issuer"] !== origin) {
    throw new EveryAppError(
      "LINKED_DEV_OAUTH_OFF",
      `${origin} names another issuer (${String(body["issuer"])}), so everyapp dev can't sign in there.`,
      { data: { gateway: origin, issuer: body["issuer"] } },
    );
  }
  // Every endpoint must be the issuer's own (its origin, so http(s) and
  // this host): what the system browser is opened at and what the code,
  // the verifier and the refresh token are posted to.
  const endpoint = (name: string, required: boolean): string | undefined => {
    const value = body[name];
    if (typeof value !== "string") {
      if (!required) return undefined;
      throw new EveryAppError(
        "LINKED_DEV_OAUTH_OFF",
        `${origin}'s OAuth metadata names no ${name}, so everyapp dev can't sign in there.`,
        { data: { gateway: origin, missing: name } },
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      url = new URL("invalid:");
    }
    if (url.origin !== origin) {
      throw new EveryAppError(
        "LINKED_DEV_OAUTH_OFF",
        `${origin}'s OAuth metadata names a ${name} on another origin (${value}), so everyapp dev can't sign in there.`,
        { data: { gateway: origin, endpoint: name } },
      );
    }
    return url.toString();
  };
  const revocation = endpoint("revocation_endpoint", false);
  const registration = endpoint("registration_endpoint", false);
  return {
    issuer: origin,
    authorization_endpoint: endpoint("authorization_endpoint", true)!,
    token_endpoint: endpoint("token_endpoint", true)!,
    ...(revocation ? { revocation_endpoint: revocation } : {}),
    ...(registration ? { registration_endpoint: registration } : {}),
  };
}

/** Register the CLI as a public client, once per Gateway (the id lasts 60 days unused, renewed by use). */
export async function registerClient(
  metadata: ServerMetadata,
  clientName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!metadata.registration_endpoint) {
    throw new EveryAppError(
      "LINKED_DEV_REGISTRATION_OFF",
      `${metadata.issuer} doesn't register clients, so everyapp dev can't sign in there\nIts operator turned dynamic registration off (MCP_DCR_ENABLED=false).`,
      { data: { gateway: metadata.issuer } },
    );
  }
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REGISTERED_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await readJson(response);
  if (response.status !== 201 || typeof body["client_id"] !== "string") {
    throw new EveryAppError(
      "LINKED_DEV_SIGNIN_FAILED",
      `${metadata.issuer} refused to register everyapp dev as a client (${response.status}${body["error"] ? `: ${String(body["error_description"] ?? body["error"])}` : ""})`,
      { data: { gateway: metadata.issuer, status: response.status } },
    );
  }
  return body["client_id"];
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

const CLOSE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>everyapp dev</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2937}h1{font-size:1.25rem}p{color:#4b5563}</style></head>
<body><h1>everyapp dev is linked</h1><p>You can close this window and go back to the terminal.</p></body></html>`;

function page(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

interface AuthorizeOptions {
  metadata: ServerMetadata;
  clientId: string;
  resource: string;
  /** Opens the system browser at the URL; the URL is also handed to `onUrl`. */
  openBrowser: (url: string) => Promise<unknown>;
  /** Told the URL once, for the terminal (and a run without a browser). */
  onUrl: (url: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The authorization: listen on a free loopback port first (RFC 8252
 * §7.3), open the browser at the Gateway's authorization endpoint with
 * PKCE, `state` and the resource, take the code on the callback (its
 * `state` and `iss` must match), exchange it. A code to the wrong listener
 * is useless without the verifier, which never leaves this process.
 */
export async function authorize(options: AuthorizeOptions): Promise<Tokens> {
  const { metadata, clientId, resource } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");

  let settle: (code: string) => void;
  let fail: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // The browser may answer (or refuse) before `await callback` below is
  // reached, while the opener is still running: no unhandled rejection.
  void callback.catch(() => undefined);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      page(res, 404, "<!doctype html><p>Not found.</p>");
      return;
    }
    // The state first: only the sign-in this process started may end it,
    // with a code or with the Gateway's refusal.
    if (url.searchParams.get("state") !== state) {
      page(res, 400, "<!doctype html><p>This isn't the sign-in that was started. Run everyapp dev again.</p>");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      page(res, 200, `<!doctype html><p>Sign-in didn't finish: ${escapeHtml(url.searchParams.get("error_description") ?? error)}. You can close this window.</p>`);
      fail(
        new EveryAppError(
          "LINKED_DEV_SIGNIN_FAILED",
          `The Gateway didn't sign everyapp dev in: ${url.searchParams.get("error_description") ?? error}`,
          { data: { gateway: metadata.issuer, error } },
        ),
      );
      return;
    }
    if (url.searchParams.get("iss") !== metadata.issuer) {
      page(res, 400, "<!doctype html><p>This isn't the sign-in that was started. Run everyapp dev again.</p>");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      page(res, 400, "<!doctype html><p>No code came back. Run everyapp dev again.</p>");
      return;
    }
    page(res, 200, CLOSE_PAGE);
    settle(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const url = new URL(metadata.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
  })) {
    url.searchParams.set(name, value);
  }
  const timer = setTimeout(
    () =>
      fail(
        new EveryAppError(
          "LINKED_DEV_SIGNIN_FAILED",
          `No sign-in came back from the browser in ${Math.round((options.timeoutMs ?? AUTHORIZE_TIMEOUT_MS) / 60_000)} minutes`,
          { data: { gateway: metadata.issuer, timeout: true } },
        ),
      ),
    options.timeoutMs ?? AUTHORIZE_TIMEOUT_MS,
  );
  try {
    options.onUrl(url.toString());
    await options.openBrowser(url.toString());
    const code = await callback;
    return await exchange(
      metadata,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      },
      fetchImpl,
    );
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A token request; the Gateway's error as `LINKED_DEV_SIGNIN_FAILED` (`data.error` has the OAuth code). */
async function exchange(
  metadata: ServerMetadata,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Tokens> {
  const response = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body["access_token"] !== "string") {
    const error = typeof body["error"] === "string" ? body["error"] : `http_${response.status}`;
    throw new EveryAppError(
      "LINKED_DEV_SIGNIN_FAILED",
      params["grant_type"] === "refresh_token"
        ? `The Gateway no longer takes everyapp dev's token (${error}): it was revoked, you're no longer an owner or admin, or linked dev was turned off\nRun ${CLI} dev --gateway ${metadata.issuer} again to sign in.`
        : `The Gateway didn't issue a token (${error}${body["error_description"] ? `: ${String(body["error_description"])}` : ""})`,
      { data: { gateway: metadata.issuer, error, status: response.status } },
    );
  }
  return {
    accessToken: body["access_token"],
    refreshToken: typeof body["refresh_token"] === "string" ? body["refresh_token"] : "",
    expiresIn: typeof body["expires_in"] === "number" ? body["expires_in"] : 3600,
    resource: typeof body["resource"] === "string" ? body["resource"] : params["resource"] ?? "",
  };
}

/** A new access token (and the rotated refresh token) for the grant. */
export function refresh(
  metadata: ServerMetadata,
  clientId: string,
  refreshToken: string,
  resource: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Tokens> {
  return exchange(
    metadata,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource },
    fetchImpl,
  );
}

/** RFC 7009: end the grant. Best effort; the Gateway answers 200 for a token it doesn't know. */
export async function revoke(
  metadata: ServerMetadata,
  clientId: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!metadata.revocation_endpoint) return false;
  try {
    const response = await fetchImpl(metadata.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
