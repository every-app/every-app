/**
 * The handlers behind `everyapp_provider_connections` and
 * `everyapp_provider_disconnect` on the gateway's own /mcp
 * (docs/design/2026-11-oauth-one-connection.md), run like the workspace
 * tools (workspace-tools.ts spreads them into its handler map) for a
 * resolved caller, through the OAuth service the UI's server functions
 * use (server/oauth/service.ts), so the roles are the same: a member sees
 * and removes their own connections, an owner or admin the
 * organization's. A connection is one person's to one provider, used by
 * the apps that person allowed. No answer carries a token; a disconnect
 * revokes the grant at the provider where the spec knows how and says
 * whether it did, and with `app` it takes that one app's access away and
 * leaves the connection.
 */
import { eq, sql } from "drizzle-orm";
import type { JsonObject, McpPrincipal } from "@every-app/toolbus";
import { db } from "@/db";
import { users } from "@/db/schema";
import { userActor } from "@/server/events/subjects";
import {
  disconnect,
  listConnections,
  removeAppAccess,
  type ConnectionSummary,
} from "@/server/oauth/service";
import type { OrgContext } from "@/server/organization/orgContext";

type Handler = (
  ctx: OrgContext,
  args: JsonObject,
  principal: McpPrincipal,
) => Promise<JsonObject>;

/** A tool error the caller can act on, `CODE: message`. */
function refuse(code: string, message: string): JsonObject {
  return { error: `${code}: ${message}` };
}

function isAdmin(ctx: OrgContext): boolean {
  return ctx.role === "owner" || ctx.role === "admin";
}

/** A connection as the tool answers it: ISO times, never a token. */
function listed(connection: ConnectionSummary): JsonObject {
  return {
    id: connection.id,
    provider: connection.providerId,
    providerName: connection.providerName,
    userId: connection.userId,
    ...(connection.userEmail ? { userEmail: connection.userEmail } : {}),
    apps: connection.apps.map((app) => ({
      rowId: app.rowId,
      id: app.id,
      name: app.name,
    })),
    label: connection.label,
    scopes: [...connection.scopes],
    status: connection.status,
    needsReconnect: connection.needsReconnect,
    createdAt: new Date(connection.createdAt).toISOString(),
    lastUsedAt:
      connection.lastUsedAt === null
        ? null
        : new Date(connection.lastUsedAt).toISOString(),
    expiresAt:
      connection.expiresAt === null
        ? null
        : new Date(connection.expiresAt).toISOString(),
  };
}

/**
 * The user id `user` names: an id as it is, or an email matched without
 * case. Null when no such user exists (the caller learns only that; the
 * service then checks the connection is in the caller's organization).
 */
async function userIdOf(user: string): Promise<string | null> {
  const trimmed = user.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, trimmed.toLowerCase()))
      .limit(1);
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, trimmed))
    .limit(1);
  return row?.id ?? null;
}

export const PROVIDER_CONNECTION_HANDLERS: Record<string, Handler> = {
  async provider_connections(ctx, args) {
    const all = args["all"] === true;
    if (all && !isAdmin(ctx)) {
      return refuse(
        "ADMIN_REQUIRED",
        "only an owner or admin lists the whole organization's connections; leave `all` out for your own",
      );
    }
    const provider =
      typeof args["provider"] === "string" ? args["provider"] : null;
    // The service's refusals (PublicError) reach the caller as
    // `CODE: message` through the workspace tool runner.
    let connections = await listConnections(ctx, all ? { user: "all" } : {});
    if (provider) {
      connections = connections.filter(
        (connection) => connection.providerId === provider,
      );
    }
    return {
      connections: connections.map(listed),
      scope: all ? "organization" : "own",
      next:
        connections.length === 0
          ? "No connections. A person connects a provider once, from inside an app that lists it; everyapp_provider_list says which providers have a client."
          : "A connection with needsReconnect is reconnected by its person, under Your connections → Accounts or from inside an app that uses it; everyapp_provider_disconnect removes one, or with `app` takes one app's access away.",
    };
  },

  async provider_disconnect(ctx, args) {
    const connectionId =
      typeof args["connection"] === "string" ? args["connection"] : null;
    const provider =
      typeof args["provider"] === "string" ? args["provider"] : null;
    const app = typeof args["app"] === "string" ? args["app"] : null;
    const user = typeof args["user"] === "string" ? args["user"] : null;
    if (!connectionId && !provider) {
      return refuse(
        "INVALID_INPUT",
        "name the connection (its id, from everyapp_provider_connections) or the provider",
      );
    }
    if (connectionId && (provider || user)) {
      return refuse(
        "INVALID_INPUT",
        "a connection id names the connection alone; leave provider and user out",
      );
    }
    let userId: string | undefined;
    if (user) {
      const found = await userIdOf(user);
      if (!found) {
        return refuse(
          "PROVIDER_CONNECTION_NOT_FOUND",
          `no member ${user} on this Gateway`,
        );
      }
      if (found !== ctx.userId && !isAdmin(ctx)) {
        return refuse(
          "ADMIN_REQUIRED",
          "only an owner or admin removes another person's connection",
        );
      }
      userId = found;
    }
    const ref = connectionId
      ? { connectionId }
      : { providerId: provider!, ...(userId ? { userId } : {}) };
    if (app) {
      // One app's access: the connection stays for the other apps.
      const taken = await removeAppAccess(ctx, { ...ref, app });
      if (!taken.removed) {
        return refuse(
          "PROVIDER_CONNECTION_NOT_FOUND",
          "the app's access was removed while this ran",
        );
      }
      return {
        connection: listed(taken.connection),
        app,
        removed: true,
        revoked: false,
        next: "That app can't use the connection until the person allows it again; the connection stays for the other apps.",
      };
    }
    const result = await disconnect(ctx, await userActor(ctx.userId), ref);
    if (!result.removed) {
      return refuse(
        "PROVIDER_CONNECTION_NOT_FOUND",
        "the connection was removed while this ran",
      );
    }
    return {
      connection: listed(result.connection),
      removed: true,
      revoked: result.revoked,
      next: result.revoked
        ? "The grant was revoked at the provider; connecting again asks for consent anew."
        : "The Gateway dropped the tokens; the grant stays at the provider until revoked in its console.",
    };
  },
};
