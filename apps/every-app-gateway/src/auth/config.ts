import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { env } from "cloudflare:workers";
import { sharedAuthOptions } from "./shared";
import { gatewaySchema, organizationSchema } from "./schema";
import { signInMethods } from "./sign-in-methods";
import {
  ACCESS_PROVIDER_ID,
  accessConfigFromEnv,
  cloudflareAccess,
  isAccessSignInConfigured,
  isPasswordSignInOn,
} from "./cloudflare-access";
import { sendEmail } from "@/server/email/sendEmail";
import { passwordResetUrl } from "@/server/email/links";
import { findPendingInvitationByToken } from "@/server/invitation-token";
import { appBaseDomain } from "@/server/app-hosts";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { AppAccessService } from "@/server/services/AppAccessService";
import { resolveOrgContext } from "@/server/organization/orgContext";
import { describePolicy, platformPolicy } from "@/server/platform-policy";

// Invitation links work once, for this long (Better Auth's default is 48h).
const INVITATION_TTL_SECONDS = 72 * 60 * 60;

function isSignUpEmailPath(path: string): boolean {
  return path === "/sign-up/email";
}

function isCreateOrganizationPath(path: string): boolean {
  return path === "/organization/create";
}

/**
 * Better Auth endpoints that sign in with, set or reset a password. With
 * password sign-in off (EMAIL_PASSWORD_SIGN_IN=false, Access sign-in
 * configured, and an owner able to sign in with Access) they refuse HTTP
 * requests; server-side calls such as the setup claim's are unaffected.
 */
function isPasswordPath(path: string): boolean {
  return (
    path === "/sign-in/email" ||
    path === "/sign-up/email" ||
    path === "/request-password-reset" ||
    path === "/forget-password" ||
    path === "/reset-password" ||
    path.startsWith("/reset-password/")
  );
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
 * Better Auth endpoints the gateway never serves over HTTP: most
 * organization endpoints, the admin plugin's, and Expo's authorization
 * proxy (below).
 *
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
  // member's PATs and app access would survive and work again
  // on a later re-invite. Members leave by an admin removing them.
  "/organization/leave",
  // The admin plugin is here for its user fields (ban, role) and the ban
  // check on sign-in. Its endpoints act on any account, whatever
  // organizations it belongs to, and the gateway's own admin pages never
  // call them over HTTP: member management goes through gateway server
  // functions (MembershipService, AdminService), which write the same
  // fields themselves under the gateway's rules and the platform policy.
  "/admin/ban-user",
  "/admin/create-user",
  "/admin/get-user",
  "/admin/has-permission",
  "/admin/impersonate-user",
  "/admin/list-user-sessions",
  "/admin/list-users",
  "/admin/remove-user",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/stop-impersonating",
  "/admin/unban-user",
  "/admin/update-user",
  // Better Auth Expo's bridge into the system browser: it sets the OAuth
  // state cookie to whatever state the link carries and redirects to any
  // https URL, so any site could plant its own sign-in's state in a
  // visitor's browser and finish it there (a login CSRF), and use it as an
  // open redirect. The mobile app signs in with the gateway's own handoff
  // instead (cloudflare-access/mobile-sign-in.ts).
  "/expo-authorization-proxy",
];

/**
 * Runtime auth configuration - requires Cloudflare bindings.
 */
/**
 * Apps live one label below APP_BASE_DOMAIN (`todo.apps.example.com` under
 * a gateway at `apps.example.com`), and the perimeter authenticates them
 * with the same Better Auth session — so the session cookie is scoped to
 * APP_BASE_DOMAIN (Domain=<base> covers the apps, and nothing else in the
 * company's zone). Without it the cookie is scoped to the gateway's own
 * hostname, the same domain, since APP_BASE_DOMAIN is the gateway host
 * (server/app-hosts.ts).
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
  const base = appBaseDomain(env);
  if (base) {
    return base;
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

  const policy = platformPolicy(env);
  // Cloudflare Access sign-in (OIDC and the outer ring), from secrets; none
  // where the policy has no Access sign-in.
  const access = accessConfigFromEnv();

  return betterAuth({
    ...sharedAuthOptions,
    // An Access identity may be linked to an existing account with the same
    // email: Access verified that email (the provider is trusted), and
    // Better Auth also requires the account's own email to be verified
    // (requireLocalEmailVerified, on by default), so an account registered
    // with someone else's address is never handed to them. Accounts whose
    // email isn't verified link while signed in (see cloudflare-access/).
    ...(isAccessSignInConfigured(access)
      ? {
          account: {
            accountLinking: {
              enabled: true,
              trustedProviders: [ACCESS_PROVIDER_ID],
            },
          },
        }
      : {}),
    // Pin the auth origin to the gateway: perimeter calls arrive on app hosts,
    // and without it Better Auth derives the origin per request.
    ...(env.GATEWAY_URL ? { baseURL: env.GATEWAY_URL } : {}),
    // Default rules, per client IP: sign-in and sign-up 3 per 10 s, password
    // reset requests 3 per minute, everything else 100 per 10 s. The sign-in
    // pages' read of the methods on offer would match the sign-in rule by
    // its prefix, and an office behind one address would lose the SSO
    // button, so it has none.
    rateLimit: {
      enabled: isProductionBuild,
      customRules: { "/sign-in-methods": false },
    },
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
        // one would own it: see its apps, mint personal access tokens and
        // invite outsiders past invite-only sign-up.
        allowUserToCreateOrganization: false,
        // Invitations are emailed (or handed to the admin as a link when
        // email isn't set up) by InvitationService, not by Better Auth.
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        schema: organizationSchema,
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
      gatewaySchema(),
      signInMethods({
        access,
        gatewayUrl: env.GATEWAY_URL,
        policy: describePolicy(policy),
      }),
      // Only where the policy has Access sign-in (self-hosted): a hosted
      // gateway has no Access in front of it, nor OIDC through it.
      // Before the user-level database hooks: it makes an invited or
      // auto-joining Access user a member before the session hook below
      // picks the session's organization.
      ...(policy.accessSignIn
        ? ([
            cloudflareAccess({ config: access, gatewayUrl: env.GATEWAY_URL }),
          ] as const)
        : ([] as const)),
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

        if (isPasswordPath(ctx.path) && !(await isPasswordSignInOn(access))) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_SIGN_IN_DISABLED",
            message: `Password sign-in is turned off on this gateway. Sign in with ${access.oidc?.label ?? "Cloudflare Access"}.`,
          });
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
