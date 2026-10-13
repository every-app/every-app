import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { InvitationService } from "@/server/services/InvitationService";
import { OrganizationService } from "@/server/services/OrganizationService";

/**
 * The organization the session acts under (id, name, slug) and the caller's
 * role, or null without one. Replaces Better Auth's get-full-organization,
 * which also returned every member and pending invitation to any member.
 */
export const getActiveOrganization = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return OrganizationService.getActive({
      userId: context.user.id,
      activeOrganizationId: context.session.activeOrganizationId ?? null,
    });
  });

const acceptInvitationSchema = z.object({
  token: z.string().min(1, "Invitation link is required").max(256),
});

/**
 * Join an organization with an invite link. The link's token is the
 * credential (never the invitation id), and the signed-in account must have
 * the invited email.
 */
export const acceptInvitation = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, authMiddleware])
  .validator((data: unknown) => acceptInvitationSchema.parse(data))
  .handler(async ({ data, context }) => {
    const request = getRequest();
    return InvitationService.accept(context.user, request.headers, data.token);
  });
