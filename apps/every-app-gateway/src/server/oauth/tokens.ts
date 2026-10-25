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
  jsonObject,
  type OAuthClientCapability,
  type OAuthFlow,
} from "@every-app/sdk/internal";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import type { SealingEnv } from "@/server/secrets/sealed";
import type { ResolvedOAuthClient } from "./client";

export type Fetch = (request: Request) => Promise<Response>;

/** The flow block a Gateway-owned call needs; null for an app-driven-only entry. */
export function flowOf(capability: OAuthClientCapability): OAuthFlow | null {
  return capability.flow ?? null;
}

/** How the client goes on the token request: the first token endpoint's rule. */
function injection(capability: OAuthClientCapability): "form" | "basic" {
  const inject = capability.token[0]?.inject;
  return inject === "basic" ? "basic" : "form";
}

/** The parsed token answer the Gateway keeps. */
interface IssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, or null when the provider gave no `expires_in`. */
  expiresAt: number | null;
  /** The whole JSON answer, for the scope parsers and Slack's `authed_user`. */
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

/** Slack puts the person's token under `authed_user`; everyone else at the top. */
function tokenFields(
  body: Record<string, unknown>,
  dialect: OAuthFlow["scopeDialect"],
): { access: unknown; refresh: unknown; expiresIn: unknown } {
  if (dialect === "slack") {
    const user = body["authed_user"];
    if (user && typeof user === "object" && !Array.isArray(user)) {
      const record = user as Record<string, unknown>;
      if (typeof record["access_token"] === "string") {
        return {
          access: record["access_token"],
          refresh: record["refresh_token"] ?? body["refresh_token"],
          expiresIn: record["expires_in"] ?? body["expires_in"],
        };
      }
    }
  }
  return {
    access: body["access_token"],
    refresh: body["refresh_token"],
    expiresIn: body["expires_in"],
  };
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
  const flow = flowOf(capability);
  if (!flow) {
    return { ok: false, kind: "failed", error: "no_flow", status: null };
  }
  const form = new URLSearchParams(fields);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });
  for (const [name, value] of Object.entries(flow.tokenHeaders ?? {})) {
    headers.set(name, value);
  }
  if (injection(capability) === "basic") {
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
  const fieldsOut = tokenFields(body, flow.scopeDialect);
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
 * one that fails for another reason keeps the old token for the caller to
 * try with, or reports `unavailable` when that one has already expired.
 */
export async function accessTokenFor({
  connectionId,
  capability,
  client,
  env,
  fetchUpstream,
  now = Date.now(),
  log,
}: {
  connectionId: string;
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
    await ProviderConnectionRepository.storeTokens(
      connectionId,
      {
        accessToken: result.tokens.accessToken,
        // A provider that rotates sends a new one; one that doesn't keeps ours.
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt,
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
 * GitHub's DELETE in a JSON body (`access_token`). True when the provider
 * answered 2xx. Never throws.
 */
export async function revokeAtProvider({
  capability,
  client,
  accessToken,
  fetchUpstream,
  log,
}: {
  capability: OAuthClientCapability;
  client: ResolvedOAuthClient;
  accessToken: string;
  fetchUpstream: Fetch;
  log: { provider: string; org?: string };
}): Promise<boolean> {
  const flow = flowOf(capability);
  if (!flow?.revokeUrl) return false;
  const method = flow.revokeMethod ?? "POST";
  const url = flow.revokeUrl.replace(
    "{client_id}",
    encodeURIComponent(client.clientId),
  );
  const headers = new Headers({ accept: "application/json" });
  let body: string;
  if (method === "DELETE") {
    headers.set("content-type", "application/json");
    body = JSON.stringify({ access_token: accessToken });
  } else {
    headers.set("content-type", "application/x-www-form-urlencoded");
    const form = new URLSearchParams({ token: accessToken });
    if (injection(capability) !== "basic") {
      form.set("client_id", client.clientId);
      if (client.clientSecret) form.set("client_secret", client.clientSecret);
    }
    body = form.toString();
  }
  if (injection(capability) === "basic" || method === "DELETE") {
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
        { ...log, status: response.status },
        "warn",
      );
    }
    return response.ok;
  } catch (error) {
    logEvent(
      "oauth.revoke_failed",
      { ...log, error: error instanceof Error ? error.name : "unknown" },
      "warn",
    );
    return false;
  }
}
