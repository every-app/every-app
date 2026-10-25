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
import { logEvent } from "@every-app/perimeter";
import { EMAIL_TRANSPORTS_TEXT } from "@/server/email/providers";
import { isEmailConfigured, sendEmail } from "@/server/email/sendEmail";
import { passwordResetUrl } from "@/server/email/links";
import {
  passwordResetEmail,
  verificationEmail,
} from "@/server/email/templates";
import { findPendingInvitationByToken } from "@/server/invitation-token";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { announcePasswordReset } from "@/server/events/password-reset";
import { actorOf } from "@/server/events/subjects";
import { appBaseDomain } from "@/server/app-hosts";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { UserRepository } from "@/server/repositories/UserRepository";
import { hasAnyOwnerMembership } from "@/server/organization/owner-membership";
import { AppAccessService } from "@/server/services/AppAccessService";
import { chooseSessionOrganization } from "@/server/organization/orgContext";
import { createPersonalOrganization } from "@/server/organization/personal-organization";
import { describePolicy, platformPolicy } from "@/server/platform-policy";

// Invitation links work once, for this long (Better Auth's default is 48h).
// The session-less invitation path (InvitationService.inviteWithoutSession)
// writes the same expiry.
export const INVITATION_TTL_SECONDS = 72 * 60 * 60;

// How many pending, unexpired invitations an organization may hold at once
// (Better Auth's default). The organization plugin refuses past it with
// INVITATION_LIMIT_REACHED on the UI path; the session-less path reads the
// same number.
export const INVITATION_LIMIT = 100;

// Email verification links work this long; the verify page resends one.
const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

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
 * Who may sign up over HTTP. An invite link, when the request carries one,
 * must be live and for the same email, in every mode: its token is the
 * credential, never the invitation id, which is not a secret. Without one,
 * only where the platform policy has open sign-up (the hosted gateway);
 * otherwise sign-up is invite-only, before and after the gateway has an
 * owner: the first owner is created server-side from the deployer's setup
 * link (SetupService), never by signing up.
 *
 * Where accounts must verify their email, a gateway that can't send email
 * refuses every sign-up, invited or not, before anything is made: the
 * account could never sign in.
 */
async function enforceSignUpPolicy(ctx: {
  request: Request;
  body?: { email?: unknown };
  policy: { openSignUp: boolean; requireEmailVerification: boolean };
}): Promise<void> {
  if (ctx.policy.requireEmailVerification && !isEmailConfigured()) {
    logEvent(
      "auth.sign_up_refused",
      { reason: "email_not_configured" },
      "error",
    );
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "EMAIL_NOT_CONFIGURED",
      message:
        // TODO(integration): wording changed by the email-providers lane
        // (outside its ownership list; its brief names this message).
        `Sign-up is unavailable: this gateway can't send the email that verifies new accounts. Its operator must set EMAIL_FROM and EMAIL_FROM_NAME and ${EMAIL_TRANSPORTS_TEXT}.`,
    });
  }

  const token = getInvitationTokenFromRequest(ctx.request);
  if (!token) {
    if (ctx.policy.openSignUp) {
      // Open, but only once the gateway has its owner: a stranger's
      // personal organization would make them an owner first, and the
      // setup claim would then find the gateway taken.
      if (!(await hasAnyOwnerMembership())) {
        throw new APIError("FORBIDDEN", {
          message: "This gateway has not been set up yet.",
        });
      }
      return;
    }
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

/**
 * A new account's personal organization, where the policy gives one: for an
 * account made over HTTP without an invite link (an invitee joins only the
 * organization that invited them, and a server-side sign-up is the setup
 * claim, which makes its own). Better Auth runs this once the sign-up has
 * written the account; when it fails, the account is removed again and the
 * sign-up fails, so nobody is left with an account and no organization.
 */
async function givePersonalOrganization(
  user: { id: string; name?: string | null; email: string },
  request: Request | undefined,
): Promise<void> {
  if (!request || getInvitationTokenFromRequest(request)) return;
  try {
    await createPersonalOrganization(user);
  } catch (error) {
    logEvent(
      "organization.personal_failed",
      {
        userId: user.id,
        message: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    await UserRepository.deleteById(user.id);
    throw new APIError("INTERNAL_SERVER_ERROR", {
      code: "ACCOUNT_CREATION_FAILED",
      message: "Your account couldn't be created. Please try again.",
    });
  }
}

async function grantDefaultAppsForMembership(
  userId: string,
  organizationId: string,
): Promise<void> {
  await AppAccessService.grantDefaultAppsToUser(userId, organizationId);
}

/**
 * Better Auth endpoints the gateway never serves over HTTP: most
 * organization endpoints and the admin plugin's.
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
  // The only trusted origin is the gateway's own URL: Better Auth matches
  // non-HTTP origins by prefix, so a custom scheme here would trust every
  // authority under it.
  const trustedOrigins = env.GATEWAY_URL ? [env.GATEWAY_URL] : [];

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
      // Anyone may ask for another verification email for any address: a
      // few a minute per client here, and a few a day per address in
      // sendEmail's budgets.
      customRules: {
        "/sign-in-methods": false,
        "/send-verification-email": { window: 60, max: 3 },
      },
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
      // Where the policy asks for it (hosted), an account signs in only once
      // its email is verified; self-hosted accounts never need to.
      requireEmailVerification: policy.requireEmailVerification,
      // Resetting the password is what a person does about a stolen session:
      // every session the account had ends with it, not only the password.
      revokeSessionsOnPasswordReset: true,
      // The link goes to the gateway's reset page with the token in the query
      // string, not to Better Auth's /reset-password/<token> path, so it never
      // sits in a URL path where log redaction can't reach it.
      sendResetPassword: async ({ user, url: betterAuthUrl, token }) => {
        const url = resetPasswordLink(betterAuthUrl, token);
        await sendEmail({
          kind: "reset",
          to: user.email,
          ...passwordResetEmail(url),
        });
      },
      // Once the new password is set: the event bus hears it, with who
      // started the reset (server/events/password-reset.ts).
      onPasswordReset: async ({ user }) => {
        await announcePasswordReset({
          id: user.id,
          email: user.email,
          name: user.name || null,
        });
      },
    },
    // Verification mail exists only where the policy needs it: without
    // this, Better Auth sends none and its resend endpoint refuses.
    ...(policy.requireEmailVerification
      ? {
          emailVerification: {
            sendOnSignUp: true,
            // A refused sign-in sends nothing: the verify page resends.
            sendOnSignIn: false,
            // The link proves the address, so it signs the account in, once
            // (Better Auth only does it while the email is unverified).
            autoSignInAfterVerification: true,
            expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
            // The token is in the link's query string (Better Auth's
            // /verify-email?token=), where log redaction reaches it. A
            // server-side sign-up (the setup claim, which verifies its owner
            // itself) has no request and gets no mail. A mail that can't go
            // (a spent budget, a provider error, logged by sendEmail) fails
            // nothing: the sign-up stands and the verify page resends, and
            // the resend answers the same either way, so it doesn't tell
            // whether an address has an account.
            sendVerificationEmail: async (
              { user, url }: { user: { email: string }; url: string },
              request?: Request,
            ) => {
              if (!request) return;
              try {
                await sendEmail({
                  kind: "verification",
                  to: user.email,
                  ...verificationEmail(url),
                });
              } catch {
                // Logged by sendEmail.
              }
            },
          },
        }
      : {}),
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,
    disabledPaths: DISABLED_AUTH_PATHS,
    plugins: [
      admin(),
      organization({
        // Only the gateway creates organizations: the setup claim (a
        // server-side system action, which this does not block) and, on the
        // hosted gateway, sign-up's one personal organization per account
        // (server/organization/personal-organization.ts). Anyone else who
        // could create one would own it: see its apps, mint personal access
        // tokens and invite outsiders past invite-only sign-up; and on the
        // hosted gateway, spread its provider calls over organizations of
        // their own making, the unit those calls are attributed to (and
        // metered by, once metering exists).
        allowUserToCreateOrganization: false,
        // Invitations are emailed (or handed to the admin as a link when
        // email isn't set up) by InvitationService, not by Better Auth.
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        invitationLimit: INVITATION_LIMIT,
        schema: organizationSchema,
        organizationHooks: {
          afterAcceptInvitation: async ({ user, member, organization }) => {
            await grantDefaultAppsForMembership(user.id, organization.id);
            const joined = {
              id: user.id,
              email: user.email,
              name: user.name || null,
            };
            await emit({
              organizationId: organization.id,
              actor: actorOf(joined),
              ...catalogue.memberJoined({
                user: joined,
                role: member.role,
                via: "invitation",
              }),
            });
          },
          afterAddMember: async ({ user, member, organization }) => {
            // Keep both hooks: members can join via invitation acceptance or
            // direct add-member paths, and each path should receive defaults.
            await grantDefaultAppsForMembership(user.id, organization.id);
            // An owner's membership is the organization being created (the
            // setup claim announces its owner itself; a personal
            // organization's is not news); anyone else was added.
            if (member.role === "owner") return;
            const joined = {
              id: user.id,
              email: user.email,
              name: user.name || null,
            };
            await emit({
              organizationId: organization.id,
              actor: { kind: "gateway" },
              ...catalogue.memberJoined({
                user: joined,
                role: member.role,
                via: "member_add",
              }),
            });
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
          await enforceSignUpPolicy({
            request: ctx.request,
            body: { email: ctx.body?.email },
            policy,
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
      ...(policy.personalOrgs
        ? {
            user: {
              create: {
                after: async (user, ctx) => {
                  await givePersonalOrganization(user, ctx?.request);
                },
              },
            },
          }
        : {}),
      session: {
        create: {
          // Every session starts in an organization when the user has one
          // (their personal one, else the last they were active in, else
          // the first they joined), so nobody lands without one.
          before: async (session) => {
            const organizationId = await chooseSessionOrganization(
              session.userId,
            );
            return organizationId
              ? { data: { ...session, activeOrganizationId: organizationId } }
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
