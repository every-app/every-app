/**
 * Who may sign in with a sign-in provider (Google, Microsoft, GitHub,
 * Apple, SSO), applied by Better Auth database hooks so it holds whichever
 * provider creates the user or the session.
 *
 * A provider only says who someone is (an email it verified). Membership
 * stays the gateway's, and the invitation flow's rules hold: an identity
 * gets a session only for
 *
 *  - an existing member who isn't deactivated (an account the identity is
 *    linked to, or one with the same verified email: Better Auth's own
 *    linking rules, see plugin.ts);
 *  - someone with a pending invitation for that exact email, which this
 *    accepts (the verified email is what the invite link stands in for);
 *  - on a gateway whose platform policy has open sign-up (the hosted one),
 *    anyone with a verified email, who gets an account and a personal
 *    organization as the sign-up form would give them.
 *
 * Nobody else: no account is made for a stranger, and nothing before the
 * gateway has been claimed with its setup link. An email the provider
 * doesn't vouch for signs nobody in and creates nothing. There is no
 * auto-join by email domain for sign-in providers (Ben's call, TODO.md
 * "Sign-in providers (2026-10-25)"): Cloudflare Access keeps its own.
 */
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import { members, users } from "@/db/schema";
import { forgetOrgContext } from "@/server/organization/orgContext";
import { isUserBanned } from "@/server/user-ban";
import {
  acceptPendingInvitations,
  findOwnerOrganizationId,
  pendingInvitationsFor,
} from "../identity-membership";

/** Error codes a refused sign-in redirects back to the sign-in page with. */
const SIGN_IN_ERRORS = {
  NOT_SET_UP: "This gateway hasn't been set up yet: its owner signs in first.",
  NOT_INVITED:
    "You don't have an account on this gateway. Ask an admin to invite you.",
  EMAIL_NOT_VERIFIED:
    "The sign-in provider hasn't verified this email address, so it can't be used here.",
  ACCOUNT_DEACTIVATED: "This account has been deactivated.",
} as const;

type SignInError = keyof typeof SIGN_IN_ERRORS;

/** The `?error=` codes the sign-in page explains. */
const SIGN_IN_ERROR_CODES = Object.fromEntries(
  Object.keys(SIGN_IN_ERRORS).map((key) => [key, `SIGNIN_${key}`]),
) as Readonly<Record<SignInError, `SIGNIN_${SignInError}`>>;

function refuse(provider: string, code: SignInError): never {
  logEvent("signin.sign_in_refused", {
    provider,
    reason: code.toLowerCase(),
  });
  throw new APIError("FORBIDDEN", {
    code: SIGN_IN_ERROR_CODES[code],
    message: SIGN_IN_ERRORS[code],
  });
}

/** What the membership policy needs of the platform policy. */
interface SignInMembershipPolicy {
  /** Anyone with a verified email may make an account (the hosted gateway). */
  readonly openSignUp: boolean;
}

/**
 * Which sign-in provider a Better Auth call is signing someone in with: the
 * provider's callback. Null for anything else (a password sign-in, Access,
 * a link made while signed in, which creates no user or session).
 */
export function signInProviderOf(
  ctx:
    | {
        path?: string | undefined;
        params?: Record<string, unknown> | undefined;
      }
    | null
    | undefined,
  configured: ReadonlySet<string>,
): string | null {
  if (!ctx?.path?.startsWith("/callback/")) return null;
  const id = ctx.params?.id;
  return typeof id === "string" && configured.has(id) ? id : null;
}

/**
 * Before Better Auth creates an account for a provider identity: refuse
 * unless the person may join (see the file comment), so a refused sign-in
 * leaves nothing behind.
 */
export async function assertSignInUserMayBeCreated(
  user: { email: string; emailVerified?: boolean | null },
  provider: string,
  policy: SignInMembershipPolicy,
): Promise<void> {
  if (!(await findOwnerOrganizationId())) refuse(provider, "NOT_SET_UP");
  if (user.emailVerified !== true) refuse(provider, "EMAIL_NOT_VERIFIED");
  const email = user.email.trim().toLowerCase();
  if ((await pendingInvitationsFor(email)).length > 0) return;
  if (policy.openSignUp) return;
  refuse(provider, "NOT_INVITED");
}

/**
 * Before Better Auth creates a session for a provider identity: let members
 * in, make an invited person a member first, and refuse everyone else, and
 * anyone deactivated.
 */
export async function ensureSignInMembership(
  userId: string,
  provider: string,
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) refuse(provider, "NOT_INVITED");
  if (isUserBanned(user)) refuse(provider, "ACCOUNT_DEACTIVATED");
  if (!(await findOwnerOrganizationId())) refuse(provider, "NOT_SET_UP");

  const membership = await db.query.members.findFirst({
    columns: { id: true },
    where: eq(members.userId, user.id),
  });
  if (membership) {
    logEvent("signin.signed_in", { provider, userId: user.id });
    return;
  }

  // Only an identity the provider verified joins anything.
  if (!user.emailVerified) refuse(provider, "EMAIL_NOT_VERIFIED");
  const email = user.email.trim().toLowerCase();
  const accepted = await acceptPendingInvitations(
    { id: user.id, email, name: user.name || null },
    { log: `sign_in:${provider}`, event: "sign_in" },
  );
  if (accepted === 0) refuse(provider, "NOT_INVITED");
  forgetOrgContext(user.id);
  logEvent("signin.signed_in", { provider, userId: user.id, joined: true });
}
