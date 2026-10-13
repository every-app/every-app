import { and, eq, gt } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { db } from "@/db";
import { invitations, organizations } from "@/db/schema";
import { PublicError } from "@/server/errors";
import { invitationUrl } from "@/server/email/links";
import { isEmailConfigured, sendEmail } from "@/server/email/sendEmail";
import {
  findPendingInvitationByToken,
  generateInvitationToken,
  hashInvitationToken,
} from "@/server/invitation-token";
import {
  forgetOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { InvitationLinkRepository } from "../repositories/InvitationLinkRepository";
import { UserRepository } from "../repositories/UserRepository";

type InviteInput = { email: string; role: "member" | "admin" };

type Invitation = { id: string; email: string; expiresAt: Date };

async function emailInvitation(
  ctx: OrgContext,
  invitation: Invitation,
  url: string,
): Promise<boolean> {
  if (!isEmailConfigured()) return false;

  const [organization, inviter] = await Promise.all([
    db.query.organizations.findFirst({
      columns: { name: true },
      where: eq(organizations.id, ctx.orgId),
    }),
    UserRepository.findById(ctx.userId),
  ]);
  const orgName = organization?.name ?? "your organization";
  const inviterEmail = inviter?.email ?? "An admin";

  try {
    await sendEmail({
      to: invitation.email,
      subject: `You have been invited to ${orgName}`,
      text: `${inviterEmail} invited you to join ${orgName}. Accept the invitation: ${url}`,
      html: `<p>${inviterEmail} invited you to join ${orgName}.</p><p><a href="${url}">Accept invitation</a></p>`,
    });
    return true;
  } catch {
    // sendEmail logs the failure; the admin gets the link to share instead.
    return false;
  }
}

/**
 * A new link for an invitation: a fresh token, stored only as its hash. The
 * token is the link's only secret (never the invitation id, which admins see
 * and Better Auth has handed to members).
 */
async function mintInvitationLink(invitationId: string): Promise<string> {
  const token = generateInvitationToken();
  await InvitationLinkRepository.create(
    invitationId,
    await hashInvitationToken(token),
  );
  return invitationUrl(token);
}

/**
 * Invite someone to the organization. The invitation always exists once this
 * returns; email delivery is best effort. When email is not configured or
 * fails, the admin shares the returned link (single use, 72 hours, and only
 * for an account with the invited email).
 */
async function invite(ctx: OrgContext, headers: Headers, input: InviteInput) {
  const auth = createAuth();
  const invitation = await auth.api.createInvitation({
    headers,
    body: {
      email: input.email,
      role: input.role,
      organizationId: ctx.orgId,
    },
  });

  const url = await mintInvitationLink(invitation.id);
  const emailSent = await emailInvitation(ctx, invitation, url);
  logEvent("invitation.created", {
    organizationId: ctx.orgId,
    role: input.role,
    emailSent,
  });

  return {
    invitationId: invitation.id,
    email: invitation.email,
    expiresAt: new Date(invitation.expiresAt),
    inviteUrl: url,
    emailConfigured: isEmailConfigured(),
    emailSent,
  };
}

/**
 * A new link for a pending, unexpired invitation in the admin's org. Links
 * handed out earlier (the emailed one included) keep working until the
 * invitation is used, canceled or expires.
 */
async function getInvitationLink(ctx: OrgContext, invitationId: string) {
  const invitation = await db.query.invitations.findFirst({
    columns: { id: true, email: true, expiresAt: true },
    where: and(
      eq(invitations.id, invitationId),
      eq(invitations.organizationId, ctx.orgId),
      eq(invitations.status, "pending"),
      gt(invitations.expiresAt, new Date()),
    ),
  });
  if (!invitation) {
    throw new PublicError(
      "INVITATION_TOKEN_INVALID",
      "Pending invitation not found",
    );
  }

  return {
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    inviteUrl: await mintInvitationLink(invitation.id),
  };
}

/**
 * Join the organization an invite link was made for. The link's token is the
 * credential, and the signed-in account must have the invited email (Better
 * Auth checks that again). Better Auth's own accept endpoint, which needs only
 * the invitation id, is closed over HTTP; this calls it server-side.
 */
async function accept(
  user: { id: string; email: string },
  headers: Headers,
  token: string,
) {
  const invitation = await findPendingInvitationByToken(token);
  if (!invitation) {
    throw new PublicError(
      "INVITATION_TOKEN_INVALID",
      "This invitation link is invalid, expired or already used. Ask the person who invited you for a new one.",
    );
  }
  if (
    invitation.email.trim().toLowerCase() !== user.email.trim().toLowerCase()
  ) {
    throw new PublicError(
      "INVITATION_EMAIL_MISMATCH",
      "This invitation is for a different email address. Sign in with the invited email to accept it.",
    );
  }

  const auth = createAuth();
  await auth.api.acceptInvitation({
    headers,
    body: { invitationId: invitation.id },
  });
  await InvitationLinkRepository.deleteForInvitation(invitation.id);
  forgetOrgContext(user.id);
  logEvent("invitation.accepted", {
    organizationId: invitation.organizationId,
    userId: user.id,
  });

  return { organizationId: invitation.organizationId };
}

export const InvitationService = {
  invite,
  getInvitationLink,
  accept,
} as const;
