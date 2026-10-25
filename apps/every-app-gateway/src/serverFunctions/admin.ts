import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  organizationAdminMiddleware,
  organizationOwnerMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AdminService } from "@/server/services/AdminService";
import { InvitationService } from "@/server/services/InvitationService";
import { MembershipService } from "@/server/services/MembershipService";
import { isEmailConfigured } from "@/server/email/sendEmail";

// Roles an invitation carries; ownership is given to a member, never invited.
const assignableRoleSchema = z.enum(["member", "admin"]);
// Roles a member can be changed to; MembershipService says who may do which.
const memberRoleSchema = z.enum(["member", "admin", "owner"]);

// ============================================================================
// Owner Setup
// ============================================================================

/**
 * Check if an owner exists in the system, i.e. whether the gateway has been
 * claimed with its setup link (see SetupService). No authentication required
 * since the sign-up and setup pages need it.
 */
export const hasOwner = createServerFn()
  .middleware([publicErrorMiddleware])
  .handler(async () => {
    return AdminService.hasOwner();
  });

// ============================================================================
// User Management Functions
// ============================================================================

/**
 * List all users in the active organization.
 * Only accessible by organization admins and owners.
 */
export const listMembers = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => {
    return AdminService.listMembers(context.org);
  });

const deleteUserSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

/**
 * Delete a user from the system.
 * Only accessible by owners.
 * Cannot delete yourself, or the last owner.
 */
export const deleteUser = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .validator((data: unknown) => deleteUserSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AdminService.deleteUser(context.org, data.userId);
  });

const memberActionSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

const updateMemberRoleSchema = memberActionSchema.extend({
  role: memberRoleSchema,
});

/**
 * Change a member's role: member, admin or owner.
 * Owners and admins; an admin changes members only, an owner changes
 * anyone but themselves and the last owner (MembershipService).
 */
export const updateMemberRole = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => updateMemberRoleSchema.parse(data))
  .handler(async ({ data, context }) => {
    return MembershipService.changeRole(context.org, data.userId, data.role);
  });

/**
 * Deactivate a user: no sign-in, no sessions, no personal access tokens.
 * Owners and admins; only an owner can deactivate an admin or another
 * owner, never the last one.
 */
export const deactivateUser = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => memberActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return MembershipService.deactivate(context.org, data.userId);
  });

/**
 * A one-hour, single-use password-reset link for the admin to share (for
 * gateways without email). Not for owners, yourself, or anyone who also
 * belongs to another organization; admins only for members.
 */
export const createPasswordResetLink = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => memberActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return MembershipService.createPasswordResetLink(context.org, data.userId);
  });

/** Let a deactivated user sign in again (revoked tokens stay revoked). */
export const reactivateUser = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => memberActionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return MembershipService.reactivate(context.org, data.userId);
  });

// ============================================================================
// Invitation Functions
// ============================================================================

const inviteMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: assignableRoleSchema.default("member"),
});

/**
 * Invite someone. The invitation is always created; the response says
 * whether it was emailed and carries the link to share when it wasn't.
 * Only accessible by organization admins and owners.
 */
export const inviteMember = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => inviteMemberSchema.parse(data))
  .handler(async ({ data, context }) => {
    const request = getRequest();
    return InvitationService.invite(context.org, request.headers, data);
  });

const invitationLinkSchema = z.object({
  invitationId: z.string().min(1, "Invitation ID is required"),
});

/**
 * The link for a pending invitation, to share by hand. POST: it reveals a
 * credential, so it is never a cacheable or linkable GET.
 */
export const getInvitationLink = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => invitationLinkSchema.parse(data))
  .handler(async ({ data, context }) => {
    return InvitationService.getInvitationLink(context.org, data.invitationId);
  });

/** Whether the gateway can send email (otherwise admins share links). */
export const getEmailStatus = createServerFn()
  .middleware([organizationAdminMiddleware])
  .handler(async () => {
    return { configured: isEmailConfigured() };
  });

const cancelInvitationSchema = z.object({
  invitationId: z.string().min(1, "Invitation ID is required"),
});

/**
 * Cancel a pending invitation in the active organization.
 * Only accessible by organization admins and owners.
 */
export const cancelInvitation = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => cancelInvitationSchema.parse(data))
  .handler(async ({ data, context }) => {
    const request = getRequest();

    return AdminService.cancelInvitation(
      context.org,
      data.invitationId,
      request.headers,
    );
  });

const sendPasswordResetEmailSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

/**
 * Mail a password-reset link to a member of the active organization, under
 * the same member-management rules as the copyable link (MembershipService).
 * Only accessible by organization admins and owners.
 */
export const sendPasswordResetEmail = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => sendPasswordResetEmailSchema.parse(data))
  .handler(async ({ data, context }) => {
    return MembershipService.sendPasswordResetEmail(context.org, data.userId);
  });
