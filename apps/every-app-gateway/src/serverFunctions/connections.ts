import { createServerFn } from "@tanstack/react-start";
import {
  organizationAdminMiddleware,
  organizationMemberMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { GatewayError } from "@/server/errors";
import type { EventActor } from "@/server/events/catalogue";
import * as oauth from "@/server/oauth/service";
import { disconnectConnectionSchema } from "@/schemas/oauth-provider";

// Connected accounts (docs/design/2026-10-oauth-providers.md section 5):
// the OAuth accounts a person connected through the Gateway, and the
// organization's own. A member sees and disconnects their own; an owner or
// admin sees every connection in the organization and may disconnect any,
// the organization's included. A token never appears on any surface.

function actorOf(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): EventActor {
  return {
    kind: "user",
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.name ? { name: user.name } : {}),
  };
}

/** The caller's own connections, in the active organization. */
export const listMyConnections = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(async ({ context }) => ({
    connections: await oauth.listConnections(context.org, {
      user: context.user.id,
    }),
  }));

/**
 * The OAuth providers a member may connect: those with a live client, by
 * id and name only (the client's source and redirect URI are the admin
 * listing's).
 */
export const listConnectableProviders = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(async ({ context }) => {
    const providers = await oauth.listOAuthProviders(context.org);
    return {
      providers: providers
        .filter((provider) => provider.client.source !== null)
        .map((provider) => ({ id: provider.id, name: provider.name })),
    };
  });

/** Every connection in the organization: each member's and the organization's. */
export const listAllConnections = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => ({
    connections: await oauth.listConnections(context.org, { user: "all" }),
  }));

/**
 * Disconnect: the caller's own account (any member), or, for an owner or
 * admin, another member's or the organization's. Revokes at the provider
 * when the provider's flow has a revoke endpoint.
 */
export const disconnectConnection = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .validator((data: unknown) => disconnectConnectionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const own =
      data.account === "user" &&
      (data.userId === undefined || data.userId === context.user.id);
    const admin = context.org.role === "owner" || context.org.role === "admin";
    if (!own && !admin) {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Only an owner or admin can disconnect another account.",
      );
    }
    await oauth.disconnect(context.org, actorOf(context.user), {
      providerId: data.providerId,
      account: data.account,
      ...(data.account === "user"
        ? { userId: data.userId ?? context.user.id }
        : {}),
    });
    return { ok: true as const };
  });
