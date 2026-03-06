import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "../db";
import { env } from "cloudflare:workers";
import { sharedAuthOptions } from "./shared";
import {
  getExpoDevTrustedOrigins,
  isExpoDevModeEnabled,
} from "./expo-origin-normalizer";
import { sendEmail } from "@/server/email/sendEmail";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { AppAccessService } from "@/server/services/AppAccessService";
import { db } from "@/db";
import { invitations } from "@/db/schema";

type PendingInvitation = {
  email: string;
  status: string;
  expiresAt: Date | number | string;
};

function isSignUpEmailPath(path: string): boolean {
  return path === "/sign-up/email";
}

function getInvitationIdFromRequest(request?: Request): string | null {
  if (!request?.url) {
    return null;
  }

  return new URL(request.url).searchParams.get("invitationId");
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function getInvitationExpiryMs(invitation: PendingInvitation): number {
  return invitation.expiresAt instanceof Date
    ? invitation.expiresAt.getTime()
    : Number(invitation.expiresAt);
}

function assertInvitationNotExpired(invitation: PendingInvitation): void {
  const expiresAtMs = getInvitationExpiryMs(invitation);

  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
    throw new APIError("BAD_REQUEST", {
      message: "Invitation has expired.",
    });
  }
}

function assertInvitationEmailMatches(
  invitation: PendingInvitation,
  requestedEmail: unknown,
): void {
  const normalizedRequestedEmail = normalizeEmail(requestedEmail);
  const normalizedInvitationEmail = normalizeEmail(invitation.email);

  if (
    !normalizedRequestedEmail ||
    normalizedRequestedEmail !== normalizedInvitationEmail
  ) {
    throw new APIError("BAD_REQUEST", {
      message:
        "This invitation can only be used with the invited email address.",
    });
  }
}

async function findPendingInvitation(
  invitationId: string,
): Promise<PendingInvitation | null> {
  const invitation = await db.query.invitations.findFirst({
    columns: {
      email: true,
      status: true,
      expiresAt: true,
    },
    where: eq(invitations.id, invitationId),
  });

  if (!invitation || invitation.status !== "pending") {
    return null;
  }

  return invitation;
}

async function enforceInviteOnlySignUp(ctx: {
  request?: Request;
  body?: { email?: unknown };
}): Promise<void> {
  // Intentionally global: once any owner exists for this gateway deployment,
  // direct sign-up is disabled and invitation flow is required.
  const hasOwner = await hasAnyOwnerMembership();
  if (!hasOwner) {
    return;
  }

  const invitationId = getInvitationIdFromRequest(ctx.request);
  if (!invitationId) {
    throw new APIError("BAD_REQUEST", {
      message: "Sign up is invite-only. Please use the invitation email link.",
    });
  }

  const invitation = await findPendingInvitation(invitationId);
  if (!invitation) {
    throw new APIError("BAD_REQUEST", {
      message: "Invitation is invalid or no longer active.",
    });
  }

  assertInvitationNotExpired(invitation);
  assertInvitationEmailMatches(invitation, ctx.body?.email);
}

async function grantDefaultAppsForMembership(
  userId: string,
  organizationId: string,
): Promise<void> {
  await AppAccessService.grantDefaultAppsToUser(userId, organizationId);
}

/**
 * Runtime auth configuration - requires Cloudflare bindings.
 */
export function createAuth() {
  const isDevMode = isExpoDevModeEnabled({
    gatewayUrl: env.GATEWAY_URL,
    viteDev: import.meta.env.DEV,
  });

  // Keep trusted origins intentionally minimal:
  // - gateway URL for normal web traffic
  // - everyapp:// for native app flows
  // - exp://** only during local gateway development
  const trustedOrigins = [
    ...(env.GATEWAY_URL ? [env.GATEWAY_URL] : []),
    "everyapp://",
    ...getExpoDevTrustedOrigins(isDevMode),
  ];

  return betterAuth({
    ...sharedAuthOptions,
    emailAndPassword: {
      ...sharedAuthOptions.emailAndPassword,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Reset your Every App password",
          text: `Use this link to reset your password: ${url}`,
          html: `<p>Use this link to reset your password:</p><p><a href="${url}">${url}</a></p>`,
        });
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,
    plugins: [
      ...sharedAuthOptions.plugins,
      admin(),
      organization({
        async sendInvitationEmail(data) {
          const invitationUrl = `${env.GATEWAY_URL}/accept-invitation?invitationId=${encodeURIComponent(data.id)}`;

          await sendEmail({
            to: data.email,
            subject: `You have been invited to ${data.organization.name}`,
            text: `${data.inviter.user.email} invited you to join ${data.organization.name}. Accept the invitation: ${invitationUrl}`,
            html: `<p>${data.inviter.user.email} invited you to join ${data.organization.name}.</p><p><a href="${invitationUrl}">Accept invitation</a></p>`,
          });
        },
        organizationHooks: {
          afterAcceptInvitation: async ({ user, organization }) => {
            await grantDefaultAppsForMembership(user.id, organization.id);
          },
          afterAddMember: async ({ user, organization }) => {
            // Keep both hooks: members can join via invitation acceptance or
            // direct add-member paths, and each path should receive defaults.
            await grantDefaultAppsForMembership(user.id, organization.id);
          },
          afterRemoveMember: async ({ user, organization }) => {
            await AppAccessRepository.deleteByOrganizationAndUser(
              organization.id,
              user.id,
            );
          },
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!isSignUpEmailPath(ctx.path)) {
          return;
        }

        await enforceInviteOnlySignUp({
          request: ctx.request,
          body: { email: ctx.body?.email },
        });
      }),
    },
    database: drizzleAdapter(drizzle(env.DB, { schema, logger: false }), {
      provider: "sqlite",
      usePlural: true,
    }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
