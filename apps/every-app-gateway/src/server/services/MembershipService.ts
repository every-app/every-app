import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { members } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { passwordResetUrl } from "@/server/email/links";
import { requirePasswordSignIn } from "@/server/password-sign-in";
import { requireTenantAdminUserActions } from "@/server/tenant-user-actions";
import { PublicError } from "@/server/errors";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import {
  forgetOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { McpConnectionService } from "./McpConnectionService";
import { UserRepository } from "../repositories/UserRepository";
import { isUserBanned } from "../user-ban";

// Matches Better Auth's own reset links.
const RESET_LINK_TTL_MS = 60 * 60 * 1000;

/** Roles an owner or admin can hand out. Ownership is never transferred here. */
type AssignableRole = "member" | "admin";

/**
 * Owners and admins manage other members' roles and access; nobody manages
 * themselves or an owner, and only an owner manages an admin.
 */
async function requireManageableMember(ctx: OrgContext, targetUserId: string) {
  if (targetUserId === ctx.userId) {
    throw new PublicError(
      "CANNOT_MANAGE_SELF",
      "You cannot change your own role or deactivate yourself",
    );
  }

  const membership = await OrganizationMembersRepository.findMembership(
    targetUserId,
    ctx.orgId,
  );
  if (!membership) {
    throw new PublicError("USER_NOT_FOUND", "User not found");
  }

  const role = resolvePrimaryOrganizationRole(membership.role);
  if (role === "owner") {
    throw new PublicError("CANNOT_MANAGE_OWNER", "Owners cannot be changed");
  }
  if (role === "admin" && ctx.role !== "owner") {
    throw new PublicError(
      "OWNER_REQUIRED",
      "Only an owner can change another admin",
    );
  }
  return { role };
}

async function changeRole(
  ctx: OrgContext,
  targetUserId: string,
  role: AssignableRole,
) {
  await requireManageableMember(ctx, targetUserId);
  await OrganizationMembersRepository.updateRole(targetUserId, ctx.orgId, role);
  forgetOrgContext(targetUserId);
  logEvent("member.role_changed", {
    organizationId: ctx.orgId,
    userId: targetUserId,
    role,
    by: ctx.userId,
  });
  return { role };
}

/**
 * A ban and a password belong to the account, which spans organizations, so
 * an organization can only deactivate, reactivate or reset the password of
 * users who belong to no other one (an admin here must never take over an
 * owner or admin of another organization), and only where the platform
 * policy lets tenant admins act on accounts at all (not on the hosted
 * gateway).
 */
async function requireAccountWideManageable(
  ctx: OrgContext,
  targetUserId: string,
) {
  requireTenantAdminUserActions();
  await requireManageableMember(ctx, targetUserId);
  const otherMembership = await db.query.members.findFirst({
    columns: { id: true },
    where: and(
      eq(members.userId, targetUserId),
      ne(members.organizationId, ctx.orgId),
    ),
  });
  if (otherMembership) {
    throw new PublicError(
      "USER_IN_OTHER_ORGANIZATION",
      "This user also belongs to another organization, so their account can't be managed from here",
    );
  }
}

/**
 * Lock a user out everywhere at once: banned (no new sign-ins), every
 * session ended, their personal access tokens and their AI app connections
 * revoked. The perimeter and /mcp also refuse banned users.
 */
async function deactivate(ctx: OrgContext, targetUserId: string) {
  await requireAccountWideManageable(ctx, targetUserId);
  await UserRepository.deactivate(targetUserId, `Deactivated by ${ctx.userId}`);
  await McpConnectionService.revokeForDeactivatedUser(targetUserId);
  forgetOrgContext(targetUserId);
  logEvent("member.deactivated", {
    organizationId: ctx.orgId,
    userId: targetUserId,
    by: ctx.userId,
  });
  return { success: true };
}

async function reactivate(ctx: OrgContext, targetUserId: string) {
  await requireAccountWideManageable(ctx, targetUserId);
  await UserRepository.reactivate(targetUserId);
  logEvent("member.reactivated", {
    organizationId: ctx.orgId,
    userId: targetUserId,
    by: ctx.userId,
  });
  return { success: true };
}

/**
 * Whoever completes a password reset can set the account's password, and
 * the password works in every organization the user belongs to, so a reset
 * an admin starts (a link to hand over, or a mail) follows the
 * member-management rules (never yourself or an owner; admins only for
 * members), only covers users of this organization alone, and never
 * targets a deactivated account. Both reset variants share this check so
 * neither can be the weaker way in.
 */
async function requirePasswordResettable(
  ctx: OrgContext,
  targetUserId: string,
) {
  await requireAccountWideManageable(ctx, targetUserId);
  await requirePasswordSignIn();
  const user = await UserRepository.findById(targetUserId);
  // Deactivation sets `banned`; `status` is the account's own state, which
  // nothing writes today but which the users table can hold. Either one
  // not being the plain active case refuses, so a future account state is
  // not resettable by default.
  if (!user || user.status !== "active" || isUserBanned(user)) {
    throw new PublicError(
      "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
      "Password reset links are only for active users",
    );
  }
  return user;
}

/**
 * A password-reset link for an admin to hand over directly, for gateways
 * without email. It is Better Auth's own reset token: single use, one
 * hour, consumed by the regular /reset-password page.
 */
async function createPasswordResetLink(ctx: OrgContext, targetUserId: string) {
  const user = await requirePasswordResettable(ctx, targetUserId);

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS);

  const auth = createAuth();
  const context = await auth.$context;
  await context.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: user.id,
    expiresAt,
  });
  logEvent("member.reset_link_created", {
    organizationId: ctx.orgId,
    userId: user.id,
    by: ctx.userId,
  });

  return { email: user.email, url: passwordResetUrl(token), expiresAt };
}

/**
 * Mail a password-reset link to a member, for gateways with email. Better
 * Auth makes and sends the link (sendResetPassword in the auth config), so
 * it is the same single-use, one-hour token the link variant hands out.
 */
async function sendPasswordResetEmail(ctx: OrgContext, targetUserId: string) {
  const user = await requirePasswordResettable(ctx, targetUserId);

  const auth = createAuth();
  await auth.api.requestPasswordReset({
    body: {
      email: user.email,
      redirectTo: `${env.GATEWAY_URL}/reset-password`,
    },
  });
  logEvent("member.reset_email_sent", {
    organizationId: ctx.orgId,
    userId: user.id,
    by: ctx.userId,
  });

  return { success: true };
}

export const MembershipService = {
  changeRole,
  deactivate,
  reactivate,
  createPasswordResetLink,
  sendPasswordResetEmail,
} as const;
