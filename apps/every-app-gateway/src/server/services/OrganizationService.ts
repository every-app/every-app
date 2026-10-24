import { logEvent } from "@every-app/perimeter";
import { GatewayError, PublicError } from "@/server/errors";
import {
  resolveOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { validOrganizationName } from "@/server/organization/organization-name";
import { OrganizationRepository } from "../repositories/OrganizationRepository";

/**
 * The session's active organization, with only what the UI shows: its id,
 * name and slug, and the caller's role. Never its members or invitations,
 * which Better Auth's get-full-organization returned to any member (that
 * endpoint is closed). Like it, this is null while the session has no active
 * organization, even for a member of just one: the organization picker then
 * offers to make it active.
 */
async function getActive(user: {
  userId: string;
  activeOrganizationId: string | null;
}) {
  if (!user.activeOrganizationId) return null;
  const org = await resolveOrgContext(user);
  if (!org) return null;

  const organization = await OrganizationRepository.findSummaryById(org.orgId);
  return organization ? { ...organization, role: org.role } : null;
}

/**
 * Rename the organization (Manage workspace → Rename). Owners and admins
 * only: the server function's gate, checked here again since the name
 * reaches every member's switcher and the invitations it sends. The name
 * follows the shared rule (`validOrganizationName`); the slug stays, since
 * Better Auth's `/organization/update` is closed and nothing else keys on
 * it changing.
 */
async function rename(
  ctx: OrgContext,
  rawName: string,
): Promise<{ id: string; name: string }> {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    throw new GatewayError(
      "UNAUTHORIZED",
      "Unauthorized: Organization admin access required",
    );
  }
  const name = validOrganizationName(rawName);
  if (!name) {
    throw new PublicError(
      "INVALID_ORGANIZATION_NAME",
      "Use 1 to 64 characters with no line breaks.",
    );
  }
  await OrganizationRepository.rename(ctx.orgId, name);
  logEvent("organization.renamed", {
    organizationId: ctx.orgId,
    by: ctx.userId,
    name,
  });
  return { id: ctx.orgId, name };
}

export const OrganizationService = {
  getActive,
  rename,
} as const;
