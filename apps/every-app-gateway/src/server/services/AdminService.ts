import { UserRepository } from "../repositories/UserRepository";
import { TokenVerificationRepository } from "../repositories/TokenVerificationRepository";
import { AccountRepository } from "../repositories/AccountRepository";
import { SessionRepository } from "../repositories/SessionRepository";
import { AppAccessService } from "./AppAccessService";
import { createAuth } from "@/auth";
import type { UserRole, UserStatus } from "@/auth/shared";
import { env } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import { APIError } from "better-auth/api";
import { PublicError } from "@/server/errors";

// Token expiration time: 7 days for invitations
const INVITE_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// Token expiration time: 1 hour for password resets
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Generate a secure random token (256 bits of entropy).
 */
function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("hex");
}

/**
 * Validate a verification token exists and is not expired.
 * Cleans up expired tokens automatically.
 *
 * @param token - The verification token to validate
 * @param tokenType - The type of token for error messaging
 * @returns The verification record if valid
 * @throws Error if token is invalid or expired
 */
async function validateToken(token: string, tokenType: "invitation" | "reset") {
  const verification = await TokenVerificationRepository.findByToken(token);

  if (!verification) {
    throw new PublicError(
      tokenType === "invitation"
        ? "INVITATION_TOKEN_INVALID"
        : "RESET_TOKEN_INVALID",
      `Invalid or expired ${tokenType} token`,
    );
  }

  if (new Date() > verification.expiresAt) {
    await TokenVerificationRepository.delete(verification.id);
    throw new PublicError(
      tokenType === "invitation"
        ? "INVITATION_TOKEN_EXPIRED"
        : "RESET_TOKEN_EXPIRED",
      `${tokenType === "invitation" ? "Invitation" : "Reset"} link has expired. Please request a new one.`,
    );
  }

  return verification;
}

/**
 * Create a verification token and return the full URL.
 */
async function createVerificationUrl(
  email: string,
  redirectPath: string,
  expiryMs: number,
): Promise<string> {
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + expiryMs);

  await TokenVerificationRepository.create({
    id: crypto.randomUUID(),
    identifier: email,
    value: token,
    expiresAt,
  });

  return `${env.GATEWAY_URL}${redirectPath}?token=${token}`;
}

// ============================================================================
// Owner Setup
// ============================================================================

/**
 * Check if an owner exists in the system.
 */
async function hasOwner() {
  const owner = await UserRepository.findOwner();
  return { hasOwner: !!owner };
}

/**
 * Initialize the first user as the owner.
 */
async function initializeOwner(email: string, password: string) {
  const existingOwner = await UserRepository.findOwner();
  if (existingOwner) {
    throw new PublicError(
      "OWNER_ALREADY_EXISTS",
      "Owner already exists. Registration is invite-only.",
    );
  }

  const auth = createAuth();

  const result = await auth.api.signUpEmail({
    body: {
      name: "",
      email,
      password,
    },
  });

  if (!result.user) {
    throw new PublicError(
      "ACCOUNT_CREATION_FAILED",
      "Failed to create owner account",
    );
  }

  await UserRepository.update(result.user.id, {
    role: "owner",
    status: "active",
  });

  // Grant default apps to the new owner
  await AppAccessService.grantDefaultAppsToUser(result.user.id);

  return { userId: result.user.id };
}

// ============================================================================
// User Management
// ============================================================================

/**
 * List all users in the system.
 */
async function listUsers() {
  const allUsers = await UserRepository.findAllForList();
  return { users: allUsers };
}

/**
 * Delete a user from the system.
 * Verifies the user exists and is not an owner.
 */
async function deleteUser(userId: string, currentUserId: string) {
  if (userId === currentUserId) {
    throw new PublicError(
      "CANNOT_DELETE_SELF",
      "Cannot delete your own account",
    );
  }

  const userToDelete = await UserRepository.findById(userId);

  if (!userToDelete) {
    throw new PublicError("USER_NOT_FOUND", "User not found");
  }

  if (userToDelete.role === "owner") {
    throw new PublicError(
      "CANNOT_DELETE_OWNER",
      "Cannot delete owner accounts",
    );
  }

  await UserRepository.delete(userId);
}

// ============================================================================
// Invitation Management
// ============================================================================

/**
 * Create an invitation link for a new user.
 * Creates the user with a random password and pending status.
 */
async function createInviteLink(email: string) {
  const auth = createAuth();

  const existingUser = await UserRepository.findByEmail(email);

  if (existingUser) {
    throw new PublicError(
      "USER_ALREADY_EXISTS",
      "A user with this email already exists",
    );
  }

  // Random password that will be immediately replaced when user accepts invitation
  const randomPassword = generateSecureToken();

  try {
    const result = await auth.api.signUpEmail({
      body: {
        name: email.split("@")[0],
        email,
        password: randomPassword,
      },
    });

    if (!result.user) {
      throw new PublicError("ACCOUNT_CREATION_FAILED", "Failed to create user");
    }

    await UserRepository.update(result.user.id, {
      status: "pending" satisfies UserStatus,
      role: "member" satisfies UserRole,
    });

    const inviteUrl = await createVerificationUrl(
      email,
      "/accept-invitation",
      INVITE_TOKEN_EXPIRY_MS,
    );

    return {
      userId: result.user.id,
      inviteUrl,
    };
  } catch (error) {
    if (error instanceof APIError && error.status === 409) {
      throw new PublicError(
        "USER_ALREADY_EXISTS",
        "A user with this email already exists",
      );
    }
    if (
      error instanceof Error &&
      /already exists|already registered/i.test(error.message)
    ) {
      throw new PublicError(
        "USER_ALREADY_EXISTS",
        "A user with this email already exists",
      );
    }
    throw error;
  }
}

/**
 * Regenerate an invitation link for a pending user.
 */
async function regenerateInviteLink(userId: string) {
  const user = await UserRepository.findById(userId);

  if (!user) {
    throw new PublicError("USER_NOT_FOUND", "User not found");
  }

  if (user.status !== "pending") {
    throw new PublicError(
      "INVITATION_REQUIRES_PENDING_USER",
      "Can only regenerate invite links for pending users",
    );
  }

  // Delete any existing verification tokens for this user
  await TokenVerificationRepository.deleteByIdentifier(user.email);

  const inviteUrl = await createVerificationUrl(
    user.email,
    "/accept-invitation",
    INVITE_TOKEN_EXPIRY_MS,
  );

  return { inviteUrl };
}

/**
 * Accept an invitation by validating the token, setting the password, and activating the user.
 */
async function acceptInvitation(token: string, password: string) {
  const verification = await validateToken(token, "invitation");
  const user = await UserRepository.findByEmail(verification.identifier);

  if (!user) {
    throw new PublicError("USER_NOT_FOUND", "User not found");
  }

  const hashedPassword = await hashPassword(password);

  await AccountRepository.updatePassword(user.id, hashedPassword);

  await UserRepository.update(user.id, {
    status: "active" satisfies UserStatus,
  });

  // Grant default apps to the newly activated user
  await AppAccessService.grantDefaultAppsToUser(user.id);

  await TokenVerificationRepository.delete(verification.id);

  return { email: user.email };
}

// ============================================================================
// Password Reset
// ============================================================================

/**
 * Generate a password reset link for an active user.
 */
async function createPasswordResetLink(userId: string) {
  const user = await UserRepository.findById(userId);

  if (!user) {
    throw new PublicError("USER_NOT_FOUND", "User not found");
  }

  if (user.status !== "active") {
    throw new PublicError(
      "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
      "Can only generate password reset links for active users",
    );
  }

  const resetUrl = await createVerificationUrl(
    user.email,
    "/reset-password",
    RESET_TOKEN_EXPIRY_MS,
  );

  return { resetUrl };
}

/**
 * Reset password for an active user using our custom token system.
 */
async function resetPassword(token: string, password: string) {
  const verification = await validateToken(token, "reset");
  const user = await UserRepository.findByEmail(verification.identifier);

  if (!user) {
    throw new PublicError("USER_NOT_FOUND", "User not found");
  }

  if (user.status !== "active") {
    throw new PublicError(
      "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
      "Password reset is only available for active users. Please use the invitation link instead.",
    );
  }

  const hashedPassword = await hashPassword(password);

  await AccountRepository.updatePassword(user.id, hashedPassword);

  // Revoke all existing sessions for security
  await SessionRepository.deleteByUserId(user.id);

  await TokenVerificationRepository.delete(verification.id);
}

export const AdminService = {
  hasOwner,
  initializeOwner,
  listUsers,
  deleteUser,
  createInviteLink,
  regenerateInviteLink,
  acceptInvitation,
  createPasswordResetLink,
  resetPassword,
} as const;
