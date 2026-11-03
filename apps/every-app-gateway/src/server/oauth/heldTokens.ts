/**
 * The connections the proxy reads for a held-token call
 * (docs/design/2026-11-oauth-simplify.md), as a port: the gateway's D1
 * implementation here, an in-memory one in tests. A connection is one
 * person's in one app. Hands out an access token (refreshed first when
 * due) and nothing else about it.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import type { OAuthClientCapability } from "@every-app/sdk/internal";
import { emit } from "@/server/events/bus";
import {
  catalogue,
  type EventApp,
  type EventUser,
} from "@/server/events/catalogue";
import { GATEWAY_ACTOR, userSubject } from "@/server/events/subjects";
import { AppRepository } from "@/server/repositories/AppRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import type { ResolvedOAuthClient } from "./client";
import { accessTokenFor, type Fetch, type RefreshOutcome } from "./tokens";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the proxy learns about a connection: never a token. */
interface HeldConnection {
  id: string;
  userId: string;
  appRowId: string;
  label: string | null;
  /** The scopes the token holds, canonical. */
  scopes: string[];
  status: "active" | "expired";
  expiresAt: number | null;
}

export interface HeldTokenPort {
  find(input: {
    organizationId: string;
    providerId: string;
    userId: string;
    appRowId: string;
  }): Promise<HeldConnection | null>;
  /** The access token to send, refreshed when due. */
  accessToken(input: {
    connection: HeldConnection;
    providerId: string;
    capability: OAuthClientCapability;
    client: ResolvedOAuthClient;
    organizationId: string;
  }): Promise<RefreshOutcome>;
  /** The provider refused a refresh: the connection is expired until reconnected. */
  expired(input: {
    connection: HeldConnection;
    providerId: string;
    capability: OAuthClientCapability;
    organizationId: string;
  }): Promise<void>;
  /**
   * The call went through: `last_used_at`, and the first call of a UTC
   * day on the connection a `connection.used` event (after the response).
   */
  used(input: {
    connection: HeldConnection;
    providerId: string;
    capability: OAuthClientCapability;
    organizationId: string;
    appId: string;
  }): Promise<void>;
}

async function eventApp(
  appRowId: string,
  organizationId: string,
): Promise<EventApp> {
  const row = await AppRepository.findCallableById(
    appRowId,
    organizationId,
  ).catch(() => undefined);
  return row
    ? { id: row.appSlug, rowId: row.id, name: row.name }
    : { id: "unknown", rowId: appRowId, name: "a removed app" };
}

function eventUser(userId: string): Promise<EventUser> {
  return userSubject(userId).catch(() => ({
    id: userId,
    email: null,
    name: null,
  }));
}

/** The gateway's own port over D1. */
export function gatewayHeldTokens(options: {
  fetchUpstream: Fetch;
}): HeldTokenPort {
  return {
    async find({ organizationId, providerId, userId, appRowId }) {
      const row = await ProviderConnectionRepository.find({
        organizationId,
        providerId,
        userId,
        appRowId,
      });
      if (!row) return null;
      return {
        id: row.id,
        userId: row.userId,
        appRowId: row.appRowId,
        label: row.label,
        scopes: row.scopes,
        status: row.status,
        expiresAt: row.expiresAt,
      };
    },
    accessToken({
      connection,
      providerId,
      capability,
      client,
      organizationId,
    }) {
      return accessTokenFor({
        connectionId: connection.id,
        scopes: connection.scopes,
        capability,
        client,
        env: env as never,
        fetchUpstream: options.fetchUpstream,
        log: { provider: providerId, org: organizationId },
      });
    },
    async expired({ connection, providerId, capability, organizationId }) {
      logEvent(
        "oauth.connection_expired",
        {
          provider: providerId,
          org: organizationId,
          user_id: connection.userId,
          app_row_id: connection.appRowId,
        },
        "warn",
      );
      await emit(async () => ({
        organizationId,
        actor: GATEWAY_ACTOR,
        ...catalogue.providerConnectionExpired({
          provider: { id: providerId, name: capability.label, kind: "oauth" },
          account: {
            user: await eventUser(connection.userId),
            label: connection.label,
          },
          app: await eventApp(connection.appRowId, organizationId),
          connectionId: connection.id,
        }),
      }));
    },
    async used({ connection, providerId, capability, organizationId, appId }) {
      await ProviderConnectionRepository.touchLastUsed(connection.id).catch(
        () => undefined,
      );
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      const tomorrow = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
      const task = RateLimitCounterRepository.claimOnce(
        `connection:used:${connection.id}:${day}`,
        new Date(tomorrow),
      )
        .then(async (first) => {
          if (!first) return;
          await emit(async () => ({
            organizationId,
            actor: { kind: "app" as const, id: appId },
            ...catalogue.providerConnectionUsed({
              connectionId: connection.id,
              provider: {
                id: providerId,
                name: capability.label,
                kind: "oauth",
              },
              app: await eventApp(connection.appRowId, organizationId),
              user: await eventUser(connection.userId),
            }),
          }));
        })
        .catch((error: unknown) => {
          logEvent(
            "oauth.connection_used_failed",
            { error: error instanceof Error ? error.name : "unknown" },
            "warn",
          );
        });
      try {
        waitUntil(task);
      } catch {
        // Outside a request (tests): the task runs on its own.
      }
    },
  };
}
