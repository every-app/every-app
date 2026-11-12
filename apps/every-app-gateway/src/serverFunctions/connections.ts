import { createServerFn } from "@tanstack/react-start";
import {
  organizationAdminMiddleware,
  organizationMemberMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import type { EventActor } from "@/server/events/catalogue";
import { startReconnect } from "@/server/oauth/flow";
import * as oauth from "@/server/oauth/service";
import {
  disconnectConnectionSchema,
  providerActionSchema,
  removeConnectionAppSchema,
} from "@/schemas/oauth-provider";

// Connected accounts (docs/design/2026-11-oauth-one-connection.md): the
// OAuth accounts people connected through the Gateway, each one person's
// to one provider, with the apps that person allowed to use it. People
// connect from inside an app; Reconnect here refreshes a person's own
// connection for the apps they already allowed. A member sees,
// reconnects, disconnects and takes apps off their own; an owner or admin
// sees, disconnects and takes apps off every connection in the
// organization. A token never appears on any surface.

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

/** The caller's own connections, in the active organization, each with the apps allowed to use it. */
export const listMyConnections = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(async ({ context }) => ({
    connections: await oauth.listConnections(context.org, {
      user: context.user.id,
    }),
  }));

/** Every connection in the organization, with its person and the apps allowed to use it. */
export const listAllConnections = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => ({
    connections: await oauth.listConnections(context.org, { user: "all" }),
  }));

/**
 * Reconnect the caller's own connection to a provider, for every app they
 * allowed to use it: the provider's URL to send the browser to, or, when
 * the connection already holds what those apps list, the apps allowed for
 * it there and then.
 */
export const reconnectConnection = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .validator((data: unknown) => providerActionSchema.parse(data))
  .handler(async ({ data, context }) =>
    startReconnect({
      organizationId: context.org.orgId,
      providerId: data.providerId,
      userId: context.user.id,
    }),
  );

/**
 * Take one app's access to a connection away: the caller's own (any
 * member), or another member's for an owner or admin (the service
 * checks). The connection stays for the other apps.
 */
export const removeConnectionApp = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .validator((data: unknown) => removeConnectionAppSchema.parse(data))
  .handler(async ({ data, context }) => {
    await oauth.removeAppAccess(context.org, {
      connectionId: data.connectionId,
      app: data.appRowId,
    });
    return { ok: true as const };
  });

/**
 * Disconnect one connection by its id: the caller's own (any member), or
 * another member's for an owner or admin (the service checks). Every app
 * allowed to use it stops at once. Revokes at the provider when the
 * provider's flow has a revoke endpoint.
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
