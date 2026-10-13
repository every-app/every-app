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

// Roles an owner or admin can give; ownership is never handed out here.
const assignableRoleSchema = z.enum(["member", "admin"]);

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
 * Cannot delete yourself.
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
  role: assignableRoleSchema,
});

/**
 * Make a member an admin, or an admin a member.
 * Owners and admins; only an owner can change another admin.
 */
export const updateMemberRole = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => updateMemberRoleSchema.parse(data))
  .handler(async ({ data, context }) => {
    return MembershipService.changeRole(context.org, data.userId, data.role);
  });

/**
 * Deactivate a user: no sign-in, no sessions, no personal or deploy tokens.
 * Owners and admins; only an owner can deactivate an admin.
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
 * Send a password reset email for an active user in the active organization.
 * Only accessible by organization admins and owners.
 */
export const sendPasswordResetEmail = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => sendPasswordResetEmailSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AdminService.sendPasswordResetEmail(context.org, data.userId);
  });
