import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { members } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import { passwordResetUrl } from "@/server/email/links";
import { isEmailConfigured, sendEmail } from "@/server/email/sendEmail";
import { passwordResetEmail } from "@/server/email/templates";
import { requirePasswordSignIn } from "@/server/password-sign-in";
import { requireTenantAdminUserActions } from "@/server/tenant-user-actions";
import { PublicError, type PublicErrorCode } from "@/server/errors";
import {
  resolvePrimaryOrganizationRole,
  type OrganizationRole,
} from "@/server/org-roles";
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

/**
 * Roles an owner or admin can hand out. Owners are peers: an owner makes
 * another member or admin an owner, and changes another owner's role; an
 * invitation still carries member or admin only (serverFunctions/admin.ts).
 */
type AssignableRole = OrganizationRole;

/**
 * The member-management rule, as a pure function of the roles: who may
 * change the role of, deactivate, reset or delete whom. An organization
 * always keeps at least one owner.
 *
 * - Nobody manages themselves (the caller checks the ids first).
 * - An admin manages members only; an admin or an owner is managed by an
 *   owner.
 * - An owner is never managed while they are the organization's only
 *   owner (`ownerCount` is every owner membership, deactivated ones
 *   included).
 *
 * Returns the code to refuse with, or null when the action may go ahead.
 * This is the early check; the writes carry the rule themselves
 * (OrganizationMembersRepository.wouldLeaveNoLiveOwner), so two owners acting on
 * each other at once can't leave the organization without one who can act:
 * the write that comes second changes nothing, and the service refuses
 * with LAST_OWNER all the same.
 */
function manageableMemberRefusal({
  actorRole,
  targetRole,
  ownerCount,
}: {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  ownerCount: number;
}): Extract<PublicErrorCode, "OWNER_REQUIRED" | "LAST_OWNER"> | null {
  if (targetRole === "member") return null;
  if (actorRole !== "owner") return "OWNER_REQUIRED";
  if (targetRole === "owner" && ownerCount <= 1) return "LAST_OWNER";
  return null;
}

const REFUSALS: Record<
  NonNullable<ReturnType<typeof manageableMemberRefusal>>,
  string
> = {
  OWNER_REQUIRED: "Only an owner can change an admin or an owner",
  LAST_OWNER:
    "The last owner can't be changed or removed; make someone else an owner first.",
};

/** What a write that changed nothing means here: it refused the last owner. */
function lastOwnerRefusal(): PublicError {
  return new PublicError("LAST_OWNER", REFUSALS.LAST_OWNER);
}

/**
 * Owners and admins manage other members' roles and access by
 * manageableMemberRefusal: nobody manages themselves, an admin manages
 * members only, and an owner manages everyone but the last owner.
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

  const role = resolvePrimaryOrganizationRole(membership.role) ?? "member";
  const ownerCount =
    role === "owner"
      ? await OrganizationMembersRepository.countOwners(ctx.orgId)
      : 0;
  const refusal = manageableMemberRefusal({
    actorRole: ctx.role,
    targetRole: role,
    ownerCount,
  });
  if (refusal) {
    throw new PublicError(refusal, REFUSALS[refusal]);
  }
  return { role };
}

async function changeRole(
  ctx: OrgContext,
  targetUserId: string,
  role: AssignableRole,
) {
  if (role === "owner" && ctx.role !== "owner") {
    throw new PublicError(
      "OWNER_REQUIRED",
      "Only an owner can make someone an owner",
    );
  }
  await requireManageableMember(ctx, targetUserId);
  const changed = await OrganizationMembersRepository.updateRole(
    targetUserId,
    ctx.orgId,
    role,
  );
  if (!changed) throw lastOwnerRefusal();
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
  const { role } = await requireManageableMember(ctx, targetUserId);
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
  return { role };
}

/**
 * Lock a user out everywhere at once: banned (no new sign-ins), every
 * session ended, their personal access tokens and their AI app connections
 * revoked. The perimeter and /mcp also refuse banned users.
 */
async function deactivate(ctx: OrgContext, targetUserId: string) {
  await requireAccountWideManageable(ctx, targetUserId);
  const deactivated = await UserRepository.deactivate(
    targetUserId,
    `Deactivated by ${ctx.userId}`,
    { unlessLastOwnerOf: ctx.orgId },
  );
  if (!deactivated) throw lastOwnerRefusal();
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
 * member-management rules (never yourself; admins only for members), only
 * covers users of this organization alone, and never targets a deactivated
 * account. An owner is never reset from here, even by another owner: a
 * reset link hands the account to whoever holds it, and an owner's account
 * is the organization. Both reset variants share this check so neither can
 * be the weaker way in.
 */
async function requirePasswordResettable(
  ctx: OrgContext,
  targetUserId: string,
) {
  const { role } = await requireAccountWideManageable(ctx, targetUserId);
  if (role === "owner") {
    throw new PublicError(
      "CANNOT_MANAGE_OWNER",
      "An owner's password can't be reset from here",
    );
  }
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
 * Better Auth's own reset token for a user: single use, one hour, stored as
 * `reset-password:<token>` the way requestPasswordReset stores it, so the
 * regular /reset-password page consumes it.
 */
async function mintPasswordResetLink(userId: string) {
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
    value: userId,
    expiresAt,
  });
  return { url: passwordResetUrl(token), expiresAt };
}

/**
 * A password-reset link for an admin to hand over directly, for gateways
 * without email.
 */
async function createPasswordResetLink(ctx: OrgContext, targetUserId: string) {
  const user = await requirePasswordResettable(ctx, targetUserId);
  const { url, expiresAt } = await mintPasswordResetLink(user.id);
  logEvent("member.reset_link_created", {
    organizationId: ctx.orgId,
    userId: user.id,
    by: ctx.userId,
  });

  return { email: user.email, url, expiresAt };
}

/**
 * Mail a password-reset link to a member, for gateways with email: the same
 * single-use, one-hour token the link variant hands out, sent with the
 * gateway's own sender and awaited, so a success means the mail went.
 * After the member rules, and before any token is minted, refused where
 * the gateway sends no email (the UI hides the action then; an agent is
 * told what to do instead); refused too when delivery fails (Better Auth's
 * requestPasswordReset would swallow that and leave the caller believing
 * a mail is on its way).
 */
async function sendPasswordResetEmail(ctx: OrgContext, targetUserId: string) {
  const user = await requirePasswordResettable(ctx, targetUserId);
  if (!isEmailConfigured()) {
    throw new PublicError(
      "EMAIL_NOT_CONFIGURED",
      "This Gateway sends no email. Copy a password-reset link from Admin → Users, or run everyapp workspace reset-link",
    );
  }
  const { url } = await mintPasswordResetLink(user.id);
  try {
    await sendEmail({
      kind: "reset",
      to: user.email,
      ...passwordResetEmail(url),
    });
  } catch {
    // sendEmail logs the failure; the unused token expires in an hour.
    throw new PublicError(
      "EMAIL_DELIVERY_FAILED",
      "The email could not be sent. Copy a password-reset link from Admin → Users, or run everyapp workspace reset-link",
    );
  }
  logEvent("member.reset_email_sent", {
    organizationId: ctx.orgId,
    userId: user.id,
    by: ctx.userId,
  });

  return { success: true };
}

export const MembershipService = {
  requireManageableMember,
  lastOwnerRefusal,
  changeRole,
  deactivate,
  reactivate,
  createPasswordResetLink,
  sendPasswordResetEmail,
} as const;
