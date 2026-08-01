import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { createAuth } from "@/auth";
import {
  organizationAdminMiddleware,
  organizationOwnerMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AdminService } from "@/server/services/AdminService";

// ============================================================================
// Owner Setup
// ============================================================================

/**
 * Check if an owner exists in the system.
 * This is used to determine if the system needs initial setup.
 * No authentication required since this is needed for the sign-up flow.
 */
export const hasOwner = createServerFn()
  .middleware([publicErrorMiddleware])
  .handler(async () => {
    return AdminService.hasOwner();
  });

const initializeOwnerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/**
 * Initialize the first user as the owner.
 * This can only be called when no owner exists.
 * No authentication required since this is the initial setup.
 *
 * Note: No rate limiting needed here - the endpoint can only succeed once
 * (service checks for existing owner), and better-auth handles signup protections.
 */
export const initializeOwner = createServerFn()
  .middleware([publicErrorMiddleware])
  .inputValidator((data: unknown) => initializeOwnerSchema.parse(data))
  .handler(async ({ data }) => {
    return AdminService.initializeOwner(data.email, data.password);
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
export const deleteUser = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) => deleteUserSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AdminService.deleteUser(context.org, data.userId);
  });

// ============================================================================
// Invitation Functions
// ============================================================================

const inviteMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
});

/**
 * Create and send an invitation for a new organization member.
 * Only accessible by organization admins and owners.
 */
export const inviteMember = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .inputValidator((data: unknown) => inviteMemberSchema.parse(data))
  .handler(async ({ data, context }) => {
    const auth = createAuth();
    const request = getRequest();

    return auth.api.createInvitation({
      headers: request.headers,
      body: {
        email: data.email,
        role: "member",
        organizationId: context.org.orgId,
      },
    });
  });

const cancelInvitationSchema = z.object({
  invitationId: z.string().min(1, "Invitation ID is required"),
});

/**
 * Cancel a pending invitation in the active organization.
 * Only accessible by organization admins and owners.
 */
export const cancelInvitation = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .inputValidator((data: unknown) => cancelInvitationSchema.parse(data))
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
export const sendPasswordResetEmail = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .inputValidator((data: unknown) => sendPasswordResetEmailSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AdminService.sendPasswordResetEmail(context.org, data.userId);
  });
