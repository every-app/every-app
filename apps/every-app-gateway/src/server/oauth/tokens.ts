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

/**
 * The User-Agent on every call the Gateway makes to a provider for the OAuth
 * flow (the token exchange and refresh, the account lookup, the revoke).
 * A Worker's fetch sends none, and some APIs refuse a request without one:
 * api.github.com answers 403, so a GitHub connection's account went
 * unnamed and its revoke failed.
 */
export const OAUTH_USER_AGENT = "every-app-gateway";

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
    "user-agent": OAUTH_USER_AGENT,
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

/** A token this close to expiry is refreshed before use. */
const REFRESH_SKEW_MS = 60_000;
/** How long a call waits for another call's refresh: 50 looks, 200 ms apart. */
const REFRESH_WAIT_LOOKS = 50;
const REFRESH_WAIT_MS = 200;

export type RefreshOutcome =
  | {
      ok: true;
      accessToken: string;
      /** Which write of the tokens this is: pass it back as `rejected` when the provider answers 401. */
      version: number;
    }
  | {
      ok: false;
      /**
       * `reconnect`: the person has to connect again (`first` on the one
       * call that found it out, which says so once). `retry`: nothing is
       * wrong with the connection; the provider could not be asked just now.
       */
      reason: "reconnect";
      first: boolean;
    }
  | { ok: false; reason: "retry" };

/**
 * The connection's access token, refreshed first when it is due: within
 * {@link REFRESH_SKEW_MS} of expiry, or the one the provider just answered
 * 401 for (`rejected`, the version a call was given).
 *
 * The stored tokens carry a version that every write of them raises, and
 * each step here is one conditional UPDATE on the version it read:
 *
 * - the lease (one refresh at the provider at a time, since a provider
 *   that rotates refresh tokens refuses a second use of one);
 * - storing what the refresh returned;
 * - marking the connection expired when the provider refuses the refresh,
 *   or its answer names scopes beyond the connection's (the mint check).
 *
 * A step that finds the version changed writes nothing and looks again:
 * someone else refreshed or reconnected, and theirs are the tokens to
 * use. So a connection is only ever marked expired for the tokens it
 * holds now, and exactly one call makes that change.
 *
 * A refresh that fails for another reason (the provider is down) keeps
 * the old token for the caller to try with, or answers `retry` when that
 * one is already past its expiry or was the one rejected.
 */
export async function accessTokenFor({
  connectionId,
  scopes,
  capability,
  client,
  env,
  fetchUpstream,
  rejected,
  now,
  log,
}: {
  connectionId: string;
  /** The scopes the connection holds, canonical: what a refreshed token may carry. */
  scopes: readonly string[];
  capability: OAuthClientCapability;
  client: ResolvedOAuthClient;
  env: SealingEnv;
  fetchUpstream: Fetch;
  /** The version of the access token the provider answered 401 for, if one was. */
  rejected?: number;
  /** A fixed clock, for tests. */
  now?: number;
  log: { provider: string; org?: string };
}): Promise<RefreshOutcome> {
  const clock = now === undefined ? () => Date.now() : () => now;
  const Connections = ProviderConnectionRepository;
  const reconnect = (first: boolean): RefreshOutcome => ({
    ok: false,
    reason: "reconnect",
    first,
  });
  for (let look = 0; look <= REFRESH_WAIT_LOOKS; look += 1) {
    const at = clock();
    const tokens = await Connections.readTokens(connectionId, env);
    // Gone, or sealed under a key this Gateway no longer has.
    if (!tokens) {
      return reconnect(
        await Connections.markExpired(connectionId, new Date(at)),
      );
    }
    if (tokens.status === "expired") return reconnect(false);
    const use: RefreshOutcome = {
      ok: true,
      accessToken: tokens.accessToken,
      version: tokens.version,
    };
    const refused = tokens.version === rejected;
    const lapsed = tokens.expiresAt !== null && tokens.expiresAt <= at;
    const due =
      refused ||
      (tokens.expiresAt !== null && tokens.expiresAt - at <= REFRESH_SKEW_MS);
    if (!due) return use;
    if (!tokens.refreshToken) {
      if (!refused && !lapsed) return use;
      return reconnect(
        await Connections.markExpired(
          connectionId,
          new Date(at),
          tokens.version,
        ),
      );
    }
    const leased = await Connections.claimRefresh(
      connectionId,
      tokens.version,
      new Date(at),
    );
    if (!leased) {
      // Another call is refreshing these tokens, or just has: wait for
      // what it stores. A token still good is used when the wait runs out.
      if (look === REFRESH_WAIT_LOOKS) {
        return refused || lapsed ? { ok: false, reason: "retry" } : use;
      }
      await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS));
      continue;
    }
    const result = await tokenCall({
      capability,
      client,
      fields: {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      },
      fetchUpstream,
      now: at,
      log: { ...log, grant: "refresh_token" },
    });
    if (!result.ok && result.kind === "failed") {
      await Connections.releaseRefresh(connectionId, tokens.version);
      return refused || lapsed ? { ok: false, reason: "retry" } : use;
    }
    let expire = !result.ok;
    let granted: string[] | null = null;
    if (result.ok) {
      // The mint check again: a refreshed token that names scopes beyond
      // the connection's is dropped, never stored or used, and the
      // connection needs a reconnect. One that names none keeps the
      // stored scopes.
      const named = "scope" in result.tokens.body;
      granted = named
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
        expire = true;
      }
    }
    if (expire) {
      const first = await Connections.markExpired(
        connectionId,
        new Date(at),
        tokens.version,
      );
      if (first) return reconnect(true);
      // The tokens were replaced while the provider was asked (this
      // call's lease ran out, or the person reconnected): look again.
      continue;
    }
    if (!result.ok) continue;
    const stored = await Connections.storeTokens(
      connectionId,
      {
        accessToken: result.tokens.accessToken,
        // A provider that rotates sends a new one; one that doesn't keeps ours.
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt,
        ...(granted ? { scopes: granted } : {}),
        now: new Date(at),
        version: tokens.version,
      },
      env,
    );
    if (stored) {
      return {
        ok: true,
        accessToken: result.tokens.accessToken,
        version: tokens.version + 1,
      };
    }
    // Replaced meanwhile: use what is stored, not what this call got.
  }
  return { ok: false, reason: "retry" };
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
      "user-agent": OAUTH_USER_AGENT,
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
