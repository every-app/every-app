import { env } from "cloudflare:workers";
import { and, count, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { INVITATION_LIMIT, INVITATION_TTL_SECONDS } from "@/auth/config";
import { db } from "@/db";
import { invitations, organizations } from "@/db/schema";
import { PublicError } from "@/server/errors";
import { invitationUrl } from "@/server/email/links";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor } from "@/server/events/subjects";
import { isEmailConfigured, sendEmail } from "@/server/email/sendEmail";
import { invitationEmail } from "@/server/email/templates";
import {
  findPendingInvitationByToken,
  generateInvitationToken,
  hashInvitationToken,
} from "@/server/invitation-token";
import {
  forgetOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";
import { InvitationLinkRepository } from "../repositories/InvitationLinkRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
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
      kind: "invitation",
      to: invitation.email,
      ...invitationEmail({
        organizationName: orgName,
        inviterEmail,
        url,
      }),
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
 * Where accounts verify their email (hosted), only a verified one invites:
 * an invitation is mail the gateway sends in its sender's name.
 */
async function requireVerifiedInviter(ctx: OrgContext): Promise<void> {
  if (!platformPolicy(env).requireEmailVerification) return;
  const inviter = await UserRepository.findById(ctx.userId);
  if (!inviter?.emailVerified) {
    throw new PublicError(
      "EMAIL_NOT_VERIFIED",
      "Verify your email address before inviting anyone.",
    );
  }
}

/**
 * What follows a new invitation row, however it was made: its link token
 * (stored as a hash), the mail when the gateway can send one, the log line
 * and the member.invited event.
 */
async function deliver(
  ctx: OrgContext,
  invitation: Invitation,
  role: InviteInput["role"],
): Promise<{ url: string; emailSent: boolean }> {
  const url = await mintInvitationLink(invitation.id);
  const emailSent = await emailInvitation(ctx, invitation, url);
  logEvent("invitation.created", {
    organizationId: ctx.orgId,
    role,
    emailSent,
  });
  // The event names the invitation and whether mail went; never the link.
  await emit(async () => ({
    organizationId: ctx.orgId,
    actor: await userActor(ctx.userId),
    ...catalogue.memberInvited({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role,
        expiresAt: invitation.expiresAt,
      },
      emailSent,
    }),
  }));
  return { url, emailSent };
}

/**
 * Invite someone to the organization. The invitation always exists once this
 * returns; email delivery is best effort. When email is not configured or
 * fails, the admin shares the returned link (single use, 72 hours, and only
 * for an account with the invited email).
 */
async function invite(ctx: OrgContext, headers: Headers, input: InviteInput) {
  await requireVerifiedInviter(ctx);
  const auth = createAuth();
  const invitation = await auth.api.createInvitation({
    headers,
    body: {
      email: input.email,
      role: input.role,
      organizationId: ctx.orgId,
    },
  });

  const { url, emailSent } = await deliver(
    ctx,
    { ...invitation, expiresAt: new Date(invitation.expiresAt) },
    input.role,
  );

  return {
    invitationId: invitation.id,
    email: invitation.email,
    expiresAt: new Date(invitation.expiresAt),
    inviteUrl: url,
    emailConfigured: isEmailConfigured(),
    emailSent,
  };
}

/** The address rule the UI's server function and Better Auth apply. */
const emailAddress = z.string().email();

/**
 * How many pending, unexpired invitations the organization holds: what
 * Better Auth's createInvitation counts against `invitationLimit`.
 */
async function countPending(ctx: OrgContext): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, ctx.orgId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    );
  return row?.value ?? 0;
}

/**
 * Invite someone without a browser session (the gateway's own /mcp acts
 * for a resolved caller, not a session): the same invitation row Better
 * Auth's createInvitation writes (pending, expiring in
 * INVITATION_TTL_SECONDS, the caller as inviter), refused like it for an
 * address that isn't one, that is a member already or holds a pending
 * invitation, and once the organization holds INVITATION_LIMIT pending
 * ones; then the same link token and mail as `invite`. The link is never
 * returned: an agent gets no credential
 * (docs/design/2026-10-agent-parity.md, decision 2); an admin copies it
 * from Admin → Users when it wasn't mailed.
 */
async function inviteWithoutSession(ctx: OrgContext, input: InviteInput) {
  await requireVerifiedInviter(ctx);
  const email = input.email.trim().toLowerCase();
  if (!emailAddress.safeParse(email).success) {
    throw new PublicError("INVALID_INPUT", "email must be an email address");
  }
  const members =
    await OrganizationMembersRepository.listMembersForOrganization(ctx.orgId);
  if (members.some((member) => member.email.trim().toLowerCase() === email)) {
    throw new PublicError(
      "ALREADY_MEMBER",
      `${email} is already a member of this organization`,
    );
  }
  const pending = await findPending(ctx, email);
  if (pending) {
    throw new PublicError(
      "ALREADY_INVITED",
      `${email} already has a pending invitation (${pending.id})`,
    );
  }
  if ((await countPending(ctx)) >= INVITATION_LIMIT) {
    throw new PublicError(
      "INVITATION_LIMIT_REACHED",
      `This organization already has ${INVITATION_LIMIT} pending invitations; cancel some first`,
    );
  }
  const invitation: Invitation = {
    id: crypto.randomUUID(),
    email,
    expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
  };
  await db.insert(invitations).values({
    id: invitation.id,
    organizationId: ctx.orgId,
    email,
    role: input.role,
    status: "pending",
    expiresAt: invitation.expiresAt,
    inviterId: ctx.userId,
  });
  const { emailSent } = await deliver(ctx, invitation, input.role);
  return {
    invitationId: invitation.id,
    email,
    role: input.role,
    expiresAt: invitation.expiresAt,
    emailConfigured: isEmailConfigured(),
    emailSent,
  };
}

/**
 * A pending invitation of the organization, by its id or the invited email
 * (letter case aside); null when there is none. Unexpired ones only, as
 * Better Auth reads "pending" when inviting, unless `includeExpired`: an
 * expired one is still listed and counted (AdminService.listMembers) and
 * the UI cancels it, so a cancel must find it.
 */
async function findPending(
  ctx: OrgContext,
  idOrEmail: string,
  options: { includeExpired?: boolean } = {},
) {
  const ref = idOrEmail.trim();
  const invitation = await db.query.invitations.findFirst({
    columns: { id: true, email: true, role: true, expiresAt: true },
    where: and(
      eq(invitations.organizationId, ctx.orgId),
      eq(invitations.status, "pending"),
      options.includeExpired
        ? undefined
        : gt(invitations.expiresAt, new Date()),
      or(
        eq(invitations.id, ref),
        eq(sql`lower(${invitations.email})`, ref.toLowerCase()),
      ),
    ),
  });
  return invitation ?? null;
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
    // Signing in with Cloudflare Access accepts a pending invitation for the
    // verified email by itself; its link then only confirms it.
    const used = await InvitationLinkRepository.findInvitationByTokenHash(
      await hashInvitationToken(token),
    );
    if (
      used?.status === "accepted" &&
      used.email.trim().toLowerCase() === user.email.trim().toLowerCase() &&
      (await OrganizationMembersRepository.findMembership(
        user.id,
        used.organizationId,
      ))
    ) {
      return { organizationId: used.organizationId };
    }
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
  inviteWithoutSession,
  findPending,
  getInvitationLink,
  accept,
} as const;
