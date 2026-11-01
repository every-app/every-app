/**
 * The connections the proxy reads for a held-token call
 * (docs/design/2026-10-oauth-providers.md section 7), as a port: the
 * gateway's D1 implementation here, an in-memory one in tests. Hands out
 * an access token (refreshed first when due) and nothing else about it.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import type {
  ConnectionAccount,
  OAuthClientCapability,
} from "@every-app/sdk/internal";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { GATEWAY_ACTOR, userSubject } from "@/server/events/subjects";
import {
  ORGANIZATION_SUBJECT,
  ProviderConnectionRepository,
} from "@/server/repositories/ProviderConnectionRepository";
import type { ResolvedOAuthClient } from "./client";
import { accessTokenFor, type Fetch, type RefreshOutcome } from "./tokens";

/** What the proxy learns about a connection: never a token. */
interface HeldConnection {
  id: string;
  account: ConnectionAccount;
  userId: string | null;
  label: string | null;
  scopeSets: string[];
  status: "active" | "expired";
  expiresAt: number | null;
}

export interface HeldTokenPort {
  find(input: {
    organizationId: string;
    providerId: string;
    account: ConnectionAccount;
    userId: string | null;
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
  touch(connectionId: string): Promise<void>;
}

/** The gateway's own port over D1. */
export function gatewayHeldTokens(options: {
  fetchUpstream: Fetch;
}): HeldTokenPort {
  return {
    async find({ organizationId, providerId, account, userId }) {
      const subject = account === "user" ? userId : ORGANIZATION_SUBJECT;
      if (!subject) return null;
      const row = await ProviderConnectionRepository.find(
        organizationId,
        providerId,
        subject,
      );
      if (!row) return null;
      return {
        id: row.id,
        account: row.accountKind,
        userId: row.userId,
        label: row.label,
        scopeSets: row.scopeSets,
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
          account: connection.account,
        },
        "warn",
      );
      const member = connection.userId
        ? await userSubject(connection.userId).catch(() => null)
        : null;
      await emit({
        organizationId,
        actor: GATEWAY_ACTOR,
        ...catalogue.providerConnectionExpired({
          provider: { id: providerId, name: capability.label, kind: "oauth" },
          account: {
            kind: connection.account,
            ...(member
              ? {
                  user: {
                    id: member.id,
                    email: member.email,
                    name: member.name,
                  },
                }
              : connection.userId
                ? { user: { id: connection.userId } }
                : {}),
            label: connection.label,
          },
          connectionId: connection.id,
        }),
      });
    },
    touch(connectionId) {
      return ProviderConnectionRepository.touchLastUsed(connectionId);
    },
  };
}
