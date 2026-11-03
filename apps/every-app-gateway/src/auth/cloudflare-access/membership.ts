/**
 * Who may sign in with a Cloudflare Access identity, and how someone new
 * becomes a member. One policy for both ways in (OIDC sign-in and the outer
 * ring), applied by Better Auth database hooks, so it holds whichever flow
 * creates the user or the session.
 *
 * Access only says who someone is (a verified email). Membership stays the
 * gateway's: an Access identity gets a session only for
 *
 *  - an existing member who isn't deactivated;
 *  - someone with a pending invitation for that email, which this accepts
 *    (the email is verified, which is what the invite link stands in for).
 *
 * Nobody signs in with Access, and no account is created, until the gateway
 * has been claimed with its setup link. Behind the outer ring Access asks
 * the gateway the same question first (access-evaluation.ts), so the
 * invitation list is the one membership list for both.
 */
import { APIError } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accounts, members, users } from "@/db/schema";
import { forgetOrgContext } from "@/server/organization/orgContext";
import { isUserBanned } from "@/server/user-ban";
import {
  acceptPendingInvitations,
  findOwnerOrganizationId,
  pendingInvitationsFor,
} from "../identity-membership";
import { ACCESS_PROVIDER_ID, type AccessConfig } from "./config";

type AccessSignInMode = "oidc" | "outer-ring";

/** Error codes a refused Access sign-in redirects or answers with. */
const ACCESS_SIGN_IN_ERRORS = {
  NOT_SET_UP: "This gateway hasn't been set up yet: its owner signs in first.",
  NOT_INVITED:
    "You don't have an account on this gateway. Ask an admin to invite you.",
  ACCOUNT_DEACTIVATED: "This account has been deactivated.",
} as const;

type AccessSignInError = keyof typeof ACCESS_SIGN_IN_ERRORS;

function refuse(code: AccessSignInError): never {
  throw new APIError("FORBIDDEN", {
    code: `ACCESS_${code}`,
    message: ACCESS_SIGN_IN_ERRORS[code],
  });
}

/**
 * Whether a Better Auth call is signing someone in with Access, and how: the
 * OIDC callback, or the outer ring's session check (the only time
 * `/get-session` creates anything is when plugin.ts signs someone in).
 */
export function accessSignInMode(
  ctx:
    | {
        path?: string | undefined;
        params?: Record<string, unknown> | undefined;
      }
    | null
    | undefined,
): AccessSignInMode | null {
  if (!ctx?.path) return null;
  if (ctx.path === "/get-session") return "outer-ring";
  if (
    ctx.path.startsWith("/callback/") &&
    ctx.params?.id === ACCESS_PROVIDER_ID
  ) {
    return "oidc";
  }
  return null;
}

/**
 * Before Better Auth creates an account for an Access identity: refuse unless
 * the person may join (see the file comment), so a refused sign-in leaves
 * nothing behind.
 */
export async function assertAccessUserMayBeCreated(
  email: string,
): Promise<void> {
  if (!(await findOwnerOrganizationId())) refuse("NOT_SET_UP");
  const normalized = email.trim().toLowerCase();
  if ((await pendingInvitationsFor(normalized)).length > 0) return;
  refuse("NOT_INVITED");
}

/**
 * Before Better Auth creates a session for an Access identity: let members
 * in, make an invited person a member first, and refuse everyone else, and
 * anyone deactivated.
 */
export async function ensureAccessMembership(userId: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) refuse("NOT_INVITED");
  if (isUserBanned(user)) refuse("ACCOUNT_DEACTIVATED");
  const ownerOrganizationId = await findOwnerOrganizationId();
  if (!ownerOrganizationId) refuse("NOT_SET_UP");

  const membership = await db.query.members.findFirst({
    columns: { id: true },
    where: eq(members.userId, user.id),
  });
  if (membership) return;

  // Only an identity Access verified joins anything.
  if (!user.emailVerified) refuse("NOT_INVITED");
  const email = user.email.trim().toLowerCase();

  if (
    (await acceptPendingInvitations(
      { id: user.id, email, name: user.name || null },
      { log: "cloudflare_access", event: "access" },
    )) > 0
  ) {
    forgetOrgContext(user.id);
    return;
  }

  refuse("NOT_INVITED");
}

/**
 * Whether some owner can sign in without a password: an Access identity
 * linked (where Access sign-in is configured), or an identity from a
 * sign-in provider that is on. Until one can, EMAIL_PASSWORD_SIGN_IN=false
 * doesn't take effect: an owner always has a way in.
 */
async function ownerHasOtherSignIn(
  config: AccessConfig,
  signInProviderIds: ReadonlySet<string>,
): Promise<boolean> {
  const providerIds = [
    ...(config.oidc || config.outerRing ? [ACCESS_PROVIDER_ID] : []),
    ...signInProviderIds,
  ];
  if (providerIds.length === 0) return false;
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(members, eq(members.userId, accounts.userId))
    .where(
      and(inArray(accounts.providerId, providerIds), eq(members.role, "owner")),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Whether password sign-in is on right now. EMAIL_PASSWORD_SIGN_IN=false
 * (with Access sign-in or a sign-in provider configured) turns it off only
 * once an owner has connected such an identity, so it can't lock the owner
 * out.
 */
export async function isPasswordSignInOn(
  config: AccessConfig,
  signInProviderIds: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  return (
    config.passwordSignIn ||
    !(await ownerHasOtherSignIn(config, signInProviderIds))
  );
}
