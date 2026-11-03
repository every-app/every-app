import { createServerFn } from "@tanstack/react-start";
import {
  organizationAdminMiddleware,
  organizationMemberMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import type { EventActor } from "@/server/events/catalogue";
import * as oauth from "@/server/oauth/service";
import { disconnectConnectionSchema } from "@/schemas/oauth-provider";

// Connected accounts (docs/design/2026-11-oauth-simplify.md): the OAuth
// accounts people connected through the Gateway, each one person's in one
// app. People connect inside each app, so nothing here starts a connect. A
// member sees and disconnects their own; an owner or admin sees every
// connection in the organization and may disconnect any. A token never
// appears on any surface.

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

/** The caller's own connections, in the active organization, each with its app. */
export const listMyConnections = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(async ({ context }) => ({
    connections: await oauth.listConnections(context.org, {
      user: context.user.id,
    }),
  }));

/** Every connection in the organization, with its person and app. */
export const listAllConnections = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => ({
    connections: await oauth.listConnections(context.org, { user: "all" }),
  }));

/**
 * Disconnect one connection by its id: the caller's own (any member), or
 * another member's for an owner or admin (the service checks). Revokes at
 * the provider when the provider's flow has a revoke endpoint.
 */
export const disconnectConnection = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .validator((data: unknown) => disconnectConnectionSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { revoked } = await oauth.disconnect(
      context.org,
      actorOf(context.user),
      { connectionId: data.connectionId },
    );
    return { ok: true as const, revoked };
  });
