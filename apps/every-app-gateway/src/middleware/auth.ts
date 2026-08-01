import { auth, type Auth } from "@/auth";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { GatewayError } from "@/server/errors";
import {
  resolveOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";

interface AuthContext {
  user: Auth["$Infer"]["Session"]["user"];
  session: Auth["$Infer"]["Session"]["session"];
}

interface OrganizationContext extends AuthContext {
  org: OrgContext;
}

export const authMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
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
    const org = await resolveOrgContext({
      userId: context.user.id,
      activeOrganizationId: context.session.activeOrganizationId ?? null,
    });

    if (!org) {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Organization membership required",
      );
    }

    const organizationContext: OrganizationContext = {
      ...context,
      org,
    };

    return next({ context: organizationContext });
  });

/**
 * Middleware that requires admin access for the active organization.
 */
export const organizationAdminMiddleware = createMiddleware({
  type: "function",
})
  .middleware([organizationMemberMiddleware])
  .server(async ({ next, context }) => {
    if (context.org.role !== "owner" && context.org.role !== "admin") {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Organization admin access required",
      );
    }

    return next({ context });
  });

/**
 * Middleware that requires owner access for the active organization.
 */
export const organizationOwnerMiddleware = createMiddleware({
  type: "function",
})
  .middleware([organizationMemberMiddleware])
  .server(async ({ next, context }) => {
    if (context.org.role !== "owner") {
      throw new GatewayError(
        "UNAUTHORIZED",
        "Unauthorized: Organization owner access required",
      );
    }

    return next({ context });
  });
