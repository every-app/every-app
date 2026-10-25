/**
 * The handlers behind `everyapp_provider_connections` and
 * `everyapp_provider_disconnect` on the gateway's own /mcp
 * (docs/design/2026-10-oauth-providers.md, section 9), run like the
 * workspace tools (workspace-tools.ts spreads them into its handler map)
 * for a resolved caller, through the OAuth service the UI's server
 * functions use (server/oauth/service.ts), so the roles are the same: a
 * member sees and removes their own connections, an owner or admin the
 * organization's. No answer carries a token; a disconnect revokes the
 * grant at the provider where the preset knows how and says whether it
 * did.
 */
import { eq, sql } from "drizzle-orm";
import type { JsonObject, McpPrincipal } from "@every-app/toolbus";
import { db } from "@/db";
import { users } from "@/db/schema";
import { PublicError } from "@/server/errors";
import { userActor } from "@/server/events/subjects";
import {
  disconnect,
  listConnections,
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
    account: connection.account,
    ...(connection.userId ? { userId: connection.userId } : {}),
    ...(connection.userEmail ? { userEmail: connection.userEmail } : {}),
    label: connection.label,
    scopeSets: [...connection.scopeSets],
    status: connection.status,
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

/** The service's refusal as the tool's `CODE: message`; anything else rethrown. */
function refusalOf(error: unknown): JsonObject | null {
  if (error instanceof PublicError) {
    return refuse(error.code, error.message);
  }
  return null;
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
    let connections: ConnectionSummary[];
    try {
      connections = await listConnections(ctx, all ? { user: "all" } : {});
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) return refusal;
      throw error;
    }
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
          ? "No connections. A person connects in the browser at <gateway>/connect/<provider> (Settings → Connected accounts); everyapp_provider_list says which providers have a client."
          : "An expired connection is connected again in the browser; everyapp_provider_disconnect removes one.",
    };
  },

  async provider_disconnect(ctx, args) {
    const provider =
      typeof args["provider"] === "string" ? args["provider"] : "";
    const account =
      args["account"] === "organization" ? "organization" : "user";
    const user = typeof args["user"] === "string" ? args["user"] : null;
    if (account === "organization" && user) {
      return refuse(
        "INVALID_INPUT",
        "the organization's connection has no user; give one or the other",
      );
    }
    let userId: string | undefined;
    if (account === "user" && user) {
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
    if (account === "organization" && !isAdmin(ctx)) {
      return refuse(
        "ADMIN_REQUIRED",
        "only an owner or admin removes the organization's connection",
      );
    }
    let result: { removed: boolean; revoked: boolean };
    try {
      result = await disconnect(ctx, await userActor(ctx.userId), {
        providerId: provider,
        account,
        ...(userId ? { userId } : {}),
      });
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) return refusal;
      throw error;
    }
    if (!result.removed) {
      return refuse(
        "PROVIDER_CONNECTION_NOT_FOUND",
        `no connection to ${provider} ${account === "organization" ? "for the organization" : userId && userId !== ctx.userId ? `for ${user}` : "of your own"}`,
      );
    }
    return {
      provider,
      account,
      ...(userId ? { userId } : {}),
      removed: true,
      revoked: result.revoked,
      next: result.revoked
        ? "The grant was revoked at the provider; connecting again asks for consent anew."
        : "The Gateway dropped the tokens; the grant stays at the provider until revoked in its console.",
    };
  },
};
