import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { env } from "cloudflare:workers";
import { sharedAuthOptions } from "./shared";
import { sendEmail } from "@/server/email/sendEmail";
import { passwordResetUrl } from "@/server/email/links";
import { findPendingInvitationByToken } from "@/server/invitation-token";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { AppAccessService } from "@/server/services/AppAccessService";
import { resolveOrgContext } from "@/server/organization/orgContext";

// Invitation links work once, for this long (Better Auth's default is 48h).
const INVITATION_TTL_SECONDS = 72 * 60 * 60;

function isSignUpEmailPath(path: string): boolean {
  return path === "/sign-up/email";
}

function isCreateOrganizationPath(path: string): boolean {
  return path === "/organization/create";
}

function getInvitationTokenFromRequest(request: Request): string | null {
  return new URL(request.url).searchParams.get("invitationToken");
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function assertInvitationEmailMatches(
  invitation: { email: string },
  requestedEmail: unknown,
): void {
  const normalizedRequestedEmail = normalizeEmail(requestedEmail);
  const normalizedInvitationEmail = normalizeEmail(invitation.email);

  if (
    !normalizedRequestedEmail ||
    normalizedRequestedEmail !== normalizedInvitationEmail
  ) {
    throw new APIError("FORBIDDEN", {
      message:
        "This invitation can only be used with the invited email address.",
    });
  }
}

/**
 * Sign-up over HTTP always needs a live invite link for the same email,
 * before and after the gateway has an owner: the first owner is created
 * server-side from the deployer's setup link (SetupService), never by
 * signing up. The link's token is the credential, never the invitation id,
 * which is not a secret.
 */
async function enforceInviteOnlySignUp(ctx: {
  request: Request;
  body?: { email?: unknown };
}): Promise<void> {
  const token = getInvitationTokenFromRequest(ctx.request);
  if (!token) {
    throw new APIError("FORBIDDEN", {
      message: "Sign up is invite-only. Please use the invitation link.",
    });
  }

  const invitation = await findPendingInvitationByToken(token);
  if (!invitation) {
    throw new APIError("FORBIDDEN", {
      message: "This invitation link is invalid, expired or already used.",
    });
  }

  assertInvitationEmailMatches(invitation, ctx.body?.email);
}

/**
 * Where a reset email links to: the gateway's /reset-password page with the
 * token in the query string, never in a path segment (log redaction only
 * covers query strings). Better Auth's own url points at its
 * /reset-password/<token> endpoint and carries the page to come back to as
 * callbackURL; when that is the gateway's reset page (forgot-password adds
 * redirect and return_to to it), the link keeps it.
 */
function resetPasswordLink(betterAuthUrl: string, token: string): string {
  try {
    const callbackURL = new URL(betterAuthUrl).searchParams.get("callbackURL");
    if (callbackURL && env.GATEWAY_URL) {
      const target = new URL(callbackURL, env.GATEWAY_URL);
      if (
        target.origin === new URL(env.GATEWAY_URL).origin &&
        target.pathname === "/reset-password"
      ) {
        target.searchParams.set("token", token);
        target.hash = "";
        return target.toString();
      }
    }
  } catch {
    // An unparseable url: the plain reset page below.
  }
  return passwordResetUrl(token);
}

async function grantDefaultAppsForMembership(
  userId: string,
  organizationId: string,
): Promise<void> {
  await AppAccessService.grantDefaultAppsToUser(userId, organizationId);
}

/**
 * Better Auth organization endpoints the gateway never calls over HTTP.
 * Organizations are created only by the setup claim, and membership changes
 * (invites, accepting them, roles, removal) go through gateway server
 * functions, which apply the gateway's own policy and call auth.api
 * server-side (disabledPaths only closes the HTTP routes). add-member is
 * server-only in Better Auth 1.7.7; it is listed so a version that exposes it
 * stays closed.
 *
 * Accepting over HTTP needs only the invitation id, and list-invitations and
 * get-full-organization hand every pending invitation id to any member, so
 * all three are closed: invite links carry their own secret (see
 * server/invitation-token.ts), and the UI reads the active organization from
 * a gateway server function that returns no invitations.
 */
const DISABLED_AUTH_PATHS = [
  "/organization/create",
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/accept-invitation",
  "/organization/list-invitations",
  "/organization/get-full-organization",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/add-member",
  // Leaving drops the membership without the gateway's cleanup, so the
  // member's PATs, deploy tokens and app access would survive and work again
  // on a later re-invite. Members leave by an admin removing them.
  "/organization/leave",
];

/**
 * Runtime auth configuration - requires Cloudflare bindings.
 */
/**
 * Apps live at subdomains of the gateway host (`todo.example.com` under a
 * gateway at `example.com`), and the perimeter authenticates them with the
 * same Better Auth session — so the session cookie must be scoped to the
 * gateway's own hostname (Domain=<host> covers its subdomains).
 *
 * Dev builds use EVERYAPP_DEV_COOKIE_DOMAIN instead (`everyapp dev --mode
 * mirror` serves the gateway at e.g. everyapp.localhost); bare-localhost dev
 * keeps host-only cookies since Domain=localhost is unreliable across
 * browsers.
 */
function resolveCookieDomain(): string | null {
  if (import.meta.env.DEV) {
    return env.EVERYAPP_DEV_COOKIE_DOMAIN ?? null;
  }
  if (!env.GATEWAY_URL) {
    return null;
  }
  try {
    const hostname = new URL(env.GATEWAY_URL).hostname;
    return hostname && hostname !== "localhost" ? hostname : null;
  } catch {
    return null;
  }
}

export function createAuth() {
  // Keep trusted origins intentionally minimal:
  // - gateway URL for normal web traffic
  // - everyapp:// for the native mobile shell (no exp:// dev origins; the
  //   shell needs a dev-client build, and those use the everyapp:// scheme)
  const trustedOrigins = [
    ...(env.GATEWAY_URL ? [env.GATEWAY_URL] : []),
    "everyapp://",
  ];

  const cookieDomain = resolveCookieDomain();

  // Better Auth decides it is in production from NODE_ENV at runtime, which
  // the deployed Worker never sets, so the defaults that follow it (rate
  // limiting, __Secure- cookies) are pinned to the build mode instead: on in
  // production builds, off under `vite dev`.
  const isProductionBuild = !import.meta.env.DEV;

  return betterAuth({
    ...sharedAuthOptions,
    // Pin the auth origin to the gateway: perimeter calls arrive on app hosts,
    // and without it Better Auth derives the origin per request.
    ...(env.GATEWAY_URL ? { baseURL: env.GATEWAY_URL } : {}),
    // Default rules, per client IP: sign-in and sign-up 3 per 10 s, password
    // reset requests 3 per minute, everything else 100 per 10 s.
    rateLimit: { enabled: isProductionBuild },
    advanced: {
      useSecureCookies: isProductionBuild,
      // Better Auth only trusts a single-hop X-Forwarded-For, and when it
      // cannot resolve a client IP it rate-limits everyone in one shared
      // bucket. Cloudflare sets CF-Connecting-IP.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      ...(cookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: cookieDomain,
            },
          }
        : {}),
    },
    emailAndPassword: {
      ...sharedAuthOptions.emailAndPassword,
      // The link goes to the gateway's reset page with the token in the query
      // string, not to Better Auth's /reset-password/<token> path, so it never
      // sits in a URL path where log redaction can't reach it.
      sendResetPassword: async ({ user, url: betterAuthUrl, token }) => {
        const url = resetPasswordLink(betterAuthUrl, token);
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
    disabledPaths: DISABLED_AUTH_PATHS,
    plugins: [
      ...sharedAuthOptions.plugins,
      admin(),
      organization({
        // Only the setup claim creates an organization (a server-side system
        // action, which this does not block). Anyone else who could create
        // one would own it: mint deploy tokens, register apps and invite
        // outsiders past invite-only sign-up.
        allowUserToCreateOrganization: false,
        // Invitations are emailed (or handed to the admin as a link when
        // email isn't set up) by InvitationService, not by Better Auth.
        invitationExpiresIn: INVITATION_TTL_SECONDS,
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
      // Must stay last so it sees the Set-Cookie headers of every plugin's
      // after-hooks when auth runs inside TanStack server functions.
      tanstackStartCookies(),
    ],
    hooks: {
      // These hooks also run for server-side auth.api.* calls, which carry
      // no request: those come from gateway code (the setup claim), not from
      // a client, and are allowed.
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) {
          return;
        }

        if (isSignUpEmailPath(ctx.path)) {
          await enforceInviteOnlySignUp({
            request: ctx.request,
            body: { email: ctx.body?.email },
          });
          return;
        }

        // Fail closed until the gateway is claimed: an organization created
        // before then would make its creator an owner of the gateway.
        if (
          isCreateOrganizationPath(ctx.path) &&
          !(await hasAnyOwnerMembership())
        ) {
          throw new APIError("FORBIDDEN", {
            message: "This gateway has not been set up yet.",
          });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const org = await resolveOrgContext({
              userId: session.userId,
              activeOrganizationId: null,
            });
            return org
              ? { data: { ...session, activeOrganizationId: org.orgId } }
              : undefined;
          },
        },
      },
    },
    database: drizzleAdapter(drizzle(env.DB, { schema, logger: false }), {
      provider: "sqlite",
      usePlural: true,
    }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
