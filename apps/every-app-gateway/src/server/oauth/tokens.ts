/**
 * The Gateway's own calls to an OAuth provider's token and revoke
 * endpoints (docs/design/2026-10-oauth-providers.md section 5): the code
 * exchange at the end of `/connect/<id>/callback`, the refresh the proxy
 * runs before a held-token call, and the revoke a disconnect makes. Every
 * call puts the client on the request as the provider's rule says (form
 * or Basic), reads the answer under the token body cap, never follows a
 * redirect, and logs names only: never a code, a token, the client or the
 * provider's answer.
 */
import { logEvent } from "@every-app/perimeter";
import {
  OAUTH_TOKEN_BODY_LIMIT,
  base64Utf8,
  grantedScopes,
  jsonObject,
  scopeExcess,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import type { SealingEnv } from "@/server/secrets/sealed";
import type { ResolvedOAuthClient } from "./client";

export type Fetch = (request: Request) => Promise<Response>;

/** The parsed token answer the Gateway keeps. */
interface IssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, or null when the provider gave no `expires_in`. */
  expiresAt: number | null;
  /** The whole JSON answer, for the scopes it says it granted. */
  body: Record<string, unknown>;
}

type TokenCallResult =
  | { ok: true; tokens: IssuedTokens }
  | {
      ok: false;
      /** `invalid_grant` and the other 4xx answers: the grant is gone; others: try later. */
      kind: "refused" | "failed";
      error: string;
      status: number | null;
    };

/** Read a body under the token cap; undefined when it is larger. */
async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > OAUTH_TOKEN_BODY_LIMIT) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * POST the token endpoint with `fields` and the client, as the provider's
 * rule says. `now` fixes `expiresAt` for tests.
 */
export async function tokenCall({
  capability,
  client,
  fields,
  fetchUpstream,
  now = Date.now(),
  log,
}: {
  capability: OAuthClientCapability;
  client: ResolvedOAuthClient;
  fields: Record<string, string>;
  fetchUpstream: Fetch;
  now?: number;
  /** What a log line says about this call, never a value. */
  log: { provider: string; grant: string; org?: string };
}): Promise<TokenCallResult> {
  const flow = capability.flow;
  const form = new URLSearchParams(fields);
  // The resource the tokens are for (RFC 8707), on the code exchange and
  // every refresh: an MCP server's authorization server mints a token for
  // that server alone.
  if (flow.resource) form.set("resource", flow.resource);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });
  for (const [name, value] of Object.entries(flow.tokenHeaders ?? {})) {
    headers.set(name, value);
  }
  if (flow.inject === "basic") {
    headers.set(
      "authorization",
      `Basic ${base64Utf8(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? "")}`)}`,
    );
  } else {
    form.set("client_id", client.clientId);
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  let response: Response;
  try {
    response = await fetchUpstream(
      new Request(flow.tokenUrl, {
        method: "POST",
        headers,
        body: form.toString(),
        redirect: "manual",
      }),
    );
  } catch (error) {
    logEvent(
      "oauth.token_call_failed",
      {
        ...log,
        phase: "request",
        error: error instanceof Error ? error.name : "unknown",
      },
      "warn",
    );
    return { ok: false, kind: "failed", error: "network", status: null };
  }
  let text: string | undefined;
  try {
    text = await readCapped(response);
  } catch {
    text = undefined;
  }
  const body = text === undefined ? null : jsonObject(text);
  if (!response.ok) {
    const error =
      typeof body?.["error"] === "string"
        ? (body["error"] as string).slice(0, 64)
        : `http_${response.status}`;
    logEvent(
      "oauth.token_call_refused",
      { ...log, status: response.status, reason: error },
      "warn",
    );
    return {
      ok: false,
      kind:
        response.status >= 400 && response.status < 500 ? "refused" : "failed",
      error,
      status: response.status,
    };
  }
  if (!body) {
    logEvent(
      "oauth.token_call_failed",
      {
        ...log,
        phase: "answer",
        error: text === undefined ? "too_large" : "not_json",
      },
      "warn",
    );
    return {
      ok: false,
      kind: "failed",
      error: "invalid_answer",
      status: response.status,
    };
  }
  // The top-level token only (Slack's is its bot token).
  const fieldsOut = {
    access: body["access_token"],
    refresh: body["refresh_token"],
    expiresIn: body["expires_in"],
  };
  if (typeof fieldsOut.access !== "string" || !fieldsOut.access) {
    logEvent(
      "oauth.token_call_failed",
      { ...log, phase: "answer", error: "no_access_token" },
      "warn",
    );
    return {
      ok: false,
      kind: "failed",
      error: "no_access_token",
      status: response.status,
    };
  }
  const expiresIn =
    typeof fieldsOut.expiresIn === "number"
      ? fieldsOut.expiresIn
      : typeof fieldsOut.expiresIn === "string" &&
          /^\d+$/.test(fieldsOut.expiresIn)
        ? Number(fieldsOut.expiresIn)
        : null;
  return {
    ok: true,
    tokens: {
      accessToken: fieldsOut.access,
      refreshToken:
        typeof fieldsOut.refresh === "string" && fieldsOut.refresh
          ? fieldsOut.refresh
          : null,
      expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
      body,
    },
  };
}

/** How long one refresh may hold the lease. */
const LEASE_MS = 30_000;
/** A token this close to expiry is refreshed before use. */
const REFRESH_SKEW_MS = 60_000;

export type RefreshOutcome =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      reason: "expired" | "unavailable" | "no_refresh_token" | "lost";
    };

/**
 * The connection's access token, refreshed first when it is within
 * {@link REFRESH_SKEW_MS} of expiry and a refresh token is held, under a
 * lease so parallel calls don't race the provider. A refresh the provider
 * refuses marks the connection expired (the caller emits the event once);
 * so does one whose answer names scopes beyond the connection's (the mint
 * check, against `scopes`), its tokens dropped. One that fails for another
 * reason keeps the old token for the caller to try with, or reports
 * `unavailable` when that one has already expired.
 */
export async function accessTokenFor({
  connectionId,
  scopes,
  capability,
  client,
  env,
  fetchUpstream,
  now = Date.now(),
  log,
}: {
  connectionId: string;
  /** The scopes the connection holds, canonical: what a refreshed token may carry. */
  scopes: readonly string[];
  capability: OAuthClientCapability;
  client: ResolvedOAuthClient;
  env: SealingEnv;
  fetchUpstream: Fetch;
  now?: number;
  log: { provider: string; org?: string };
}): Promise<RefreshOutcome> {
  const tokens = await ProviderConnectionRepository.readTokens(
    connectionId,
    env,
  );
  if (!tokens) return { ok: false, reason: "lost" };
  const fresh =
    tokens.expiresAt === null || tokens.expiresAt - now > REFRESH_SKEW_MS;
  if (fresh) return { ok: true, accessToken: tokens.accessToken };
  if (!tokens.refreshToken) {
    if (tokens.expiresAt !== null && tokens.expiresAt <= now) {
      await ProviderConnectionRepository.markExpired(
        connectionId,
        new Date(now),
      );
      return { ok: false, reason: "no_refresh_token" };
    }
    return { ok: true, accessToken: tokens.accessToken };
  }
  const leased = await ProviderConnectionRepository.tryLease(
    connectionId,
    new Date(now),
    LEASE_MS,
  );
  if (!leased) {
    // Another call is refreshing: give it a moment, then read what it stored.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = await ProviderConnectionRepository.readTokens(
        connectionId,
        env,
      );
      if (!again) return { ok: false, reason: "lost" };
      if (
        again.expiresAt === null ||
        again.expiresAt - Date.now() > REFRESH_SKEW_MS
      ) {
        return { ok: true, accessToken: again.accessToken };
      }
    }
    return tokens.expiresAt !== null && tokens.expiresAt <= now
      ? { ok: false, reason: "unavailable" }
      : { ok: true, accessToken: tokens.accessToken };
  }
  const result = await tokenCall({
    capability,
    client,
    fields: { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
    fetchUpstream,
    now,
    log: { ...log, grant: "refresh_token" },
  });
  if (result.ok) {
    // The mint check again: a refreshed token that names scopes beyond the
    // connection's is dropped, never stored or used, and the connection
    // needs a reconnect. One that names none keeps the stored scopes.
    const named = "scope" in result.tokens.body;
    const granted = named
      ? grantedScopes(capability.flow, result.tokens.body, scopes)
      : null;
    const excess =
      named && granted
        ? scopeExcess(capability.flow, granted, scopes)
        : named
          ? ["(unreadable)"]
          : [];
    if (excess.length > 0) {
      logEvent(
        "oauth.refresh_refused",
        { ...log, reason: "scope_excess", excess: excess.slice(0, 10) },
        "warn",
      );
      await ProviderConnectionRepository.markExpired(
        connectionId,
        new Date(now),
      );
      return { ok: false, reason: "expired" };
    }
    await ProviderConnectionRepository.storeTokens(
      connectionId,
      {
        accessToken: result.tokens.accessToken,
        // A provider that rotates sends a new one; one that doesn't keeps ours.
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt,
        ...(named && granted ? { scopes: granted } : {}),
        now: new Date(now),
      },
      env,
    );
    return { ok: true, accessToken: result.tokens.accessToken };
  }
  if (result.kind === "refused") {
    await ProviderConnectionRepository.markExpired(connectionId, new Date(now));
    return { ok: false, reason: "expired" };
  }
  await ProviderConnectionRepository.releaseLease(connectionId);
  return tokens.expiresAt !== null && tokens.expiresAt <= now
    ? { ok: false, reason: "unavailable" }
    : { ok: true, accessToken: tokens.accessToken };
}

/**
 * Revoke a connection's tokens at the provider, when its flow names a
 * revoke endpoint: `{client_id}` in the URL is replaced, the client goes
 * on as the token rule says, the token in the form body (`token`), or for
 * GitHub's DELETE in a JSON body (`access_token`). The form sends the
 * access token while it is live and, when that is refused or the access
 * token has expired, the refresh token with `token_type_hint=refresh_token`
 * (RFC 7009): Google answers `invalid_token` for an expired access token,
 * and revokes the whole grant from its refresh token. True when the
 * provider answered 2xx. Never throws.
 */
export async function revokeAtProvider({
  capability,
  client,
  tokens,
  fetchUpstream,
  log,
  now = Date.now(),
}: {
  capability: OAuthClientCapability;
  client: ResolvedOAuthClient;
  tokens: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
  };
  fetchUpstream: Fetch;
  log: { provider: string; org?: string };
  now?: number;
}): Promise<boolean> {
  const flow = capability.flow;
  if (!flow.revokeUrl) return false;
  const method = flow.revokeMethod ?? "POST";
  const url = flow.revokeUrl.replace(
    "{client_id}",
    encodeURIComponent(client.clientId),
  );
  const send = async (
    token: "access" | "refresh",
    body: string,
  ): Promise<boolean> => {
    const headers = new Headers({
      accept: "application/json",
      "content-type":
        method === "DELETE"
          ? "application/json"
          : "application/x-www-form-urlencoded",
    });
    if (flow.inject === "basic" || method === "DELETE") {
      headers.set(
        "authorization",
        `Basic ${base64Utf8(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? "")}`)}`,
      );
    }
    try {
      const response = await fetchUpstream(
        new Request(url, { method, headers, body, redirect: "manual" }),
      );
      await response.body?.cancel();
      if (!response.ok) {
        logEvent(
          "oauth.revoke_refused",
          { ...log, token, status: response.status },
          "warn",
        );
      }
      return response.ok;
    } catch (error) {
      logEvent(
        "oauth.revoke_failed",
        {
          ...log,
          token,
          error: error instanceof Error ? error.name : "unknown",
        },
        "warn",
      );
      return false;
    }
  };
  if (method === "DELETE") {
    return send("access", JSON.stringify({ access_token: tokens.accessToken }));
  }
  const form = (fields: Record<string, string>): string => {
    const params = new URLSearchParams(fields);
    if (flow.inject !== "basic") {
      params.set("client_id", client.clientId);
      if (client.clientSecret) params.set("client_secret", client.clientSecret);
    }
    return params.toString();
  };
  const expired = tokens.expiresAt !== null && tokens.expiresAt <= now;
  if (!expired && (await send("access", form({ token: tokens.accessToken }))))
    return true;
  if (!tokens.refreshToken) return false;
  return send(
    "refresh",
    form({ token: tokens.refreshToken, token_type_hint: "refresh_token" }),
  );
}
