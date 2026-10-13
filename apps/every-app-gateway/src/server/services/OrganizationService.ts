import { resolveOrgContext } from "@/server/organization/orgContext";
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

export const OrganizationService = {
  getActive,
} as const;
