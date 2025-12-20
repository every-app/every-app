import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { ownerMiddleware } from "@/middleware/auth";
import { AdminService } from "@/server/services/AdminService";

// ============================================================================
// Owner Setup
// ============================================================================

/**
 * Check if an owner exists in the system.
 * This is used to determine if the system needs initial setup.
 * No authentication required since this is needed for the sign-up flow.
 */
export const hasOwner = createServerFn().handler(async () => {
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
  .inputValidator((data: unknown) => initializeOwnerSchema.parse(data))
  .handler(async ({ data }) => {
    return AdminService.initializeOwner(data.email, data.password);
  });

// ============================================================================
// User Management Functions
// ============================================================================

/**
 * List all users in the system.
 * Only accessible by owners.
 */
export const listUsers = createServerFn()
  .middleware([ownerMiddleware])
  .handler(async () => {
    return AdminService.listUsers();
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
  .middleware([ownerMiddleware])
  .inputValidator((data: unknown) => deleteUserSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AdminService.deleteUser(data.userId, context.user.id);
  });

// ============================================================================
// Invitation Functions
// ============================================================================

const createInviteLinkSchema = z.object({
  email: z.string().email("Invalid email address"),
});

/**
 * Create an invitation link for a new user.
 * Creates the user with a random password and pending status,
 * then generates a password reset token for them to set their own password.
 * Only accessible by owners.
 */
export const createInviteLink = createServerFn()
  .middleware([ownerMiddleware])
  .inputValidator((data: unknown) => createInviteLinkSchema.parse(data))
  .handler(async ({ data }) => {
    return AdminService.createInviteLink(data.email);
  });

const regenerateInviteLinkSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

/**
 * Regenerate an invitation link for a pending user.
 * Only accessible by owners.
 */
export const regenerateInviteLink = createServerFn()
  .middleware([ownerMiddleware])
  .inputValidator((data: unknown) => regenerateInviteLinkSchema.parse(data))
  .handler(async ({ data }) => {
    return AdminService.regenerateInviteLink(data.userId);
  });

const createPasswordResetLinkSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

/**
 * Generate a password reset link for an active user.
 * Only accessible by owners.
 */
export const createPasswordResetLink = createServerFn()
  .middleware([ownerMiddleware])
  .inputValidator((data: unknown) => createPasswordResetLinkSchema.parse(data))
  .handler(async ({ data }) => {
    return AdminService.createPasswordResetLink(data.userId);
  });

// ============================================================================
// Invitation Acceptance
// ============================================================================

const acceptInvitationSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/**
 * Accept an invitation by validating the token, setting the password, and activating the user.
 * This handles the complete invitation flow in one server call.
 * Rate limited per token to prevent brute-force attacks on invitation tokens.
 */
export const acceptInvitation = createServerFn()
  .inputValidator((data: unknown) => acceptInvitationSchema.parse(data))
  .handler(async ({ data }) => {
    const { success } = await env.RATE_LIMIT_AUTH_TOKEN.limit({
      key: data.token,
    });
    if (!success) {
      throw new Error("Too many attempts. Please try again later.");
    }

    return AdminService.acceptInvitation(data.token, data.password);
  });

// ============================================================================
// Password Reset (for active users)
// ============================================================================

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

/**
 * Reset password for an active user using our custom token system.
 * Similar to acceptInvitation but for existing active users.
 * Rate limited per token to prevent brute-force attacks on reset tokens.
 */
export const resetPassword = createServerFn()
  .inputValidator((data: unknown) => resetPasswordSchema.parse(data))
  .handler(async ({ data }) => {
    const { success } = await env.RATE_LIMIT_AUTH_TOKEN.limit({
      key: data.token,
    });
    if (!success) {
      throw new Error("Too many attempts. Please try again later.");
    }

    return AdminService.resetPassword(data.token, data.password);
  });
