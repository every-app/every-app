/**
 * The AI apps a user connected to the gateway's /mcp over OAuth.
 *
 * A connection's D1 row is what every /mcp request checks, so revoking it
 * stops the client on its next request. Its grant in the authorization
 * server (OAUTH_KV) is revoked too, so its tokens can no longer even be
 * refreshed; that part is best effort, since the row alone already shuts
 * the client out.
 */
import { env, waitUntil } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { PublicError } from "@/server/errors";
import { sameInstallation } from "@/server/mcp-auth/installation";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";

/** What the consent decision records with a grant. */
type GrantMetadata = {
  connectionId?: unknown;
  organizationId?: unknown;
  /** The connection's created_at, in milliseconds. */
  connectionCreatedAt?: unknown;
};

type UserGrant = {
  id: string;
  clientId: string;
  /** Absent on grants older than the library recording it. */
  redirectUri: string | undefined;
  metadata: GrantMetadata;
};

/**
 * A connection younger than this is listed whatever its grant: KV lists are
 * eventually consistent, so a grant just written may not be listed yet.
 */
const NEW_GRANT_GRACE_MS = 5 * 60_000;

/** The user's grants in the authorization server, or null without one. */
async function userGrants(userId: string) {
  // Loaded on demand: the OAuth library stays out of control-plane starts.
  const { getMcpAuth } = await import("@/server/mcp-auth/config");
  const mcpAuth = getMcpAuth(env);
  if (!mcpAuth) return null;
  const oauth = mcpAuth.authorizationServer.getOAuthApi(env);
  const grants: UserGrant[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    for (const grant of page.items) {
      grants.push({
        id: grant.id,
        clientId: grant.clientId,
        redirectUri: grant.redirectUri,
        metadata: (grant.metadata ?? {}) as GrantMetadata,
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return { oauth, grants };
}

/** Revoke the user's grants that `match`. */
async function revokeGrants(
  userId: string,
  matches: (grant: UserGrant) => boolean,
): Promise<number> {
  const found = await userGrants(userId);
  if (!found) return 0;
  const doomed = found.grants.filter(matches);
  for (const grant of doomed) await found.oauth.revokeGrant(grant.id, userId);
  return doomed.length;
}

/** Revoke grants after the response; the D1 rows already shut them out. */
function revokeGrantsLater(
  userId: string,
  matches: (grant: UserGrant) => boolean,
  context: Record<string, unknown>,
): void {
  waitUntil(
    revokeGrants(userId, matches).catch((error: unknown) =>
      logEvent(
        "mcp.connection.grant_revoke_failed",
        {
          ...context,
          user_id: userId,
          message: error instanceof Error ? error.message : String(error),
        },
        "warn",
      ),
    ),
  );
}

/**
 * A user's connections that still work. One whose grant is gone (the client
 * revoked its own token, or the grant lapsed) is marked ended here, so the
 * list never shows an AI app that can no longer get in.
 */
async function listForUser(userId: string) {
  let connections = await McpConnectionRepository.listActiveForUser(userId);
  const found = await userGrants(userId).catch((error: unknown) => {
    logEvent(
      "mcp.connection.grants_unreadable",
      { message: error instanceof Error ? error.message : String(error) },
      "warn",
    );
    return null;
  });
  if (found) {
    const live = new Set(
      found.grants.map((grant) => grant.metadata.connectionId),
    );
    const now = Date.now();
    const ended = connections.filter(
      (connection) =>
        !live.has(connection.id) &&
        now - connection.createdAt.getTime() > NEW_GRANT_GRACE_MS,
    );
    for (const connection of ended) {
      await McpConnectionRepository.revokeById(connection.id, "ended");
    }
    connections = connections.filter(
      (connection) => !ended.includes(connection),
    );
  }
  return {
    connections: connections.map((connection) => ({
      id: connection.id,
      organizationName: connection.organizationName,
      clientName: connection.clientName,
      clientDomain: connection.clientDomain,
      redirectHost: connection.redirectHost,
      apps:
        connection.appScope === "all" ? ("all" as const) : connection.appNames,
      access: connection.access as "read" | "write",
      createdAt: connection.createdAt.toISOString(),
      lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
    })),
  };
}

async function revokeForUser(userId: string, connectionId: string) {
  const revoked = await McpConnectionRepository.revokeForUser(
    connectionId,
    userId,
    "user",
  );
  if (!revoked) {
    throw new PublicError("CONNECTION_NOT_FOUND", "Connection not found");
  }
  // The row already shuts the client out; its grant goes too if it can.
  await revokeGrants(
    userId,
    (grant) => grant.metadata.connectionId === connectionId,
  ).catch((error: unknown) =>
    logEvent(
      "mcp.connection.grant_revoke_failed",
      {
        connection: connectionId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    ),
  );
  logEvent("mcp.connection.revoked", {
    connection: connectionId,
    user_id: userId,
    reason: "user",
  });
  return { ok: true };
}

/** Whether a grant's connection was made before `createdAt`. */
function madeBefore(metadata: GrantMetadata, createdAt: Date): boolean {
  // A grant recorded without it is older than any connection made now.
  return (
    typeof metadata.connectionCreatedAt !== "number" ||
    metadata.connectionCreatedAt < createdAt.getTime()
  );
}

/**
 * Retire what a just-completed connection replaces: the user's connections
 * through the same client in the same organization made before it, and
 * their grants (a member of two organizations keeps a connection to each).
 * For a Client ID Metadata Document client (one client id for every
 * installation) only the same installation's, by redirect URI, a loopback
 * redirect's port not counting (sameInstallation). This replaces the authorization server's own
 * replacement (`revokeExistingGrants`, turned off), which compares redirect
 * URIs exactly: Claude Code listens on a new port each time it connects, so
 * reconnecting it (to downgrade to read only, say) left the earlier grant
 * working.
 *
 * Only what was made before this connection, so two consents completing at
 * once don't retire each other. Best effort: a failure is logged and the
 * code still goes to the client. Rows and grants are retired independently,
 * and either alone shuts out an earlier connection.
 */
async function supersedeEarlier(connection: {
  id: string;
  userId: string;
  organizationId: string;
  clientId: string;
  clientDomain: string | null;
  redirectUri: string;
  createdAt: Date;
}): Promise<void> {
  const inInstallation = (redirectUri: string | undefined) =>
    connection.clientDomain === null ||
    (redirectUri !== undefined &&
      sameInstallation(redirectUri, connection.redirectUri));
  const [rows, grants] = await Promise.allSettled([
    McpConnectionRepository.supersedeEarlier(connection, inInstallation),
    revokeGrants(
      connection.userId,
      (grant) =>
        grant.clientId === connection.clientId &&
        grant.metadata.organizationId === connection.organizationId &&
        grant.metadata.connectionId !== connection.id &&
        madeBefore(grant.metadata, connection.createdAt) &&
        inInstallation(grant.redirectUri),
    ),
  ]);
  for (const [step, result] of [
    ["connections", rows],
    ["grants", grants],
  ] as const) {
    if (result.status === "rejected") {
      logEvent(
        "mcp.connection.supersede_failed",
        {
          connection: connection.id,
          step,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
        "warn",
      );
    }
  }
}

/**
 * Mark an offboarded user's connections revoked, as a statement of its own
 * after the offboarding transaction, never inside it: best effort, since
 * /mcp and every refresh already refuse a removed member or a banned user.
 * So a failure here (D1 unavailable, or a database that doesn't have the
 * connections tables yet) is logged, and the removal or deactivation stands.
 */
async function markRevoked(
  userId: string,
  reason: "member_removed" | "user_deactivated",
  organizationId?: string,
): Promise<void> {
  try {
    await McpConnectionRepository.revokeAllForUser(
      userId,
      reason,
      organizationId,
    );
  } catch (error) {
    logEvent(
      "mcp.connection.revoke_failed",
      {
        user_id: userId,
        ...(organizationId ? { org: organizationId } : {}),
        reason,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
  }
}

/**
 * After a member was removed from an organization: revoke their connections
 * there, and their grants there after the response.
 */
async function revokeForRemovedMember(
  userId: string,
  organizationId: string,
): Promise<void> {
  await markRevoked(userId, "member_removed", organizationId);
  revokeGrantsLater(
    userId,
    (grant) => grant.metadata.organizationId === organizationId,
    { org: organizationId, reason: "member_removed" },
  );
}

/**
 * After a user was deactivated: revoke all of their connections, and every
 * grant they hold after the response.
 */
async function revokeForDeactivatedUser(userId: string): Promise<void> {
  await markRevoked(userId, "user_deactivated");
  revokeGrantsLater(userId, () => true, { reason: "user_deactivated" });
}

export const McpConnectionService = {
  listForUser,
  revokeForUser,
  supersedeEarlier,
  revokeForRemovedMember,
  revokeForDeactivatedUser,
} as const;
