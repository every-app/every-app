import { createAuth, type Auth } from "@/auth";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { GatewayError } from "@/server/errors";
import {
  resolvePrimaryOrganizationRole,
  type OrganizationRole,
} from "@/server/org-roles";

interface AuthContext {
  user: Auth["$Infer"]["Session"]["user"];
  session: Auth["$Infer"]["Session"]["session"];
  activeOrganizationId: string | null;
  activeOrganizationRole: OrganizationRole | null;
}

export interface OrganizationContext extends AuthContext {
  activeOrganizationId: string;
  activeOrganizationRole: OrganizationRole;
}

export const authMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const auth = createAuth();

  // Get the request object using TanStack Start's helper
  const request = getRequest();

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session || !session.user || !session.user.id) {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }

  const authContext: AuthContext = {
    user: session.user,
    session: session.session,
    activeOrganizationId: session.session.activeOrganizationId ?? null,
    activeOrganizationRole: null,
  };

  return next({ context: authContext });
});

/**
 * Middleware that requires the current user to be a member
 * of an active organization.
 */
export const organizationMemberMiddleware = createMiddleware({
  type: "function",
})
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (!context.activeOrganizationId) {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Active organization required",
      );
    }

    const auth = createAuth();
    const request = getRequest();

    const activeMember = await auth.api.getActiveMember({
      headers: request.headers,
    });

    if (!activeMember) {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Organization membership required",
      );
    }

    const activeOrganizationRole = resolvePrimaryOrganizationRole(
      activeMember.role,
    );

    if (!activeOrganizationRole) {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Organization role required",
      );
    }

    const organizationContext: OrganizationContext = {
      ...context,
      activeOrganizationId: context.activeOrganizationId,
      activeOrganizationRole,
    };

    return next({ context: organizationContext });
  });

/**
 * Middleware that requires owner access for the active organization.
 */
export const organizationOwnerMiddleware = createMiddleware({
  type: "function",
})
  .middleware([organizationMemberMiddleware])
  .server(async ({ next, context }) => {
    if (context.activeOrganizationRole !== "owner") {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Organization owner access required",
      );
    }

    return next({ context });
  });
