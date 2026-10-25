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
 *    (the email is verified, which is what the invite link stands in for);
 *  - someone whose email domain the operator listed in
 *    CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS, who joins the owner's organization
 *    as a member with the apps marked "Available to everyone", as if they
 *    had accepted an invitation;
 *  - through the outer ring only, when the operator set
 *    CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN=everyone: anyone the Access
 *    policy lets in joins the same way (the Access policy becomes the
 *    membership list).
 *
 * Nobody signs in with Access, and no account is created, until the gateway
 * has been claimed with its setup link. Linking an Access identity to an
 * existing account follows Better Auth's own rules, not these (see plugin.ts).
 */
import { APIError } from "better-auth/api";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import { accounts, invitations, members, users } from "@/db/schema";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { actorOf } from "@/server/events/subjects";
import { forgetOrgContext } from "@/server/organization/orgContext";
import { AppAccessService } from "@/server/services/AppAccessService";
import { isUserBanned } from "@/server/user-ban";
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

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** The organization of the gateway's first owner, or null before the claim. */
async function findOwnerOrganizationId(): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.role, "owner"))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return row?.organizationId ?? null;
}

function pendingInvitationsFor(email: string) {
  return db
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      role: invitations.role,
    })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email}`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    );
}

/** How someone who isn't a member yet may join without an invitation. */
function autoJoinRoute(
  email: string,
  mode: AccessSignInMode,
  config: AccessConfig,
): "domain" | "everyone" | null {
  if (config.autoJoinDomains.includes(emailDomain(email))) return "domain";
  if (mode === "outer-ring" && config.outerRing?.autoJoinEveryone) {
    return "everyone";
  }
  return null;
}

/**
 * Whether Access would let someone with this email join again by signing in,
 * without an invitation: an auto-join domain, or (with the outer ring)
 * everyone it admits. Deleting such a person's account doesn't keep them
 * out; deactivating does.
 */
export function joinsWithoutInvitation(
  email: string,
  config: AccessConfig,
): boolean {
  return (
    autoJoinRoute(email.trim().toLowerCase(), "outer-ring", config) !== null
  );
}

/**
 * Before Better Auth creates an account for an Access identity: refuse unless
 * the person may join (see the file comment), so a refused sign-in leaves
 * nothing behind.
 */
export async function assertAccessUserMayBeCreated(
  email: string,
  mode: AccessSignInMode,
  config: AccessConfig,
): Promise<void> {
  if (!(await findOwnerOrganizationId())) refuse("NOT_SET_UP");
  const normalized = email.trim().toLowerCase();
  if ((await pendingInvitationsFor(normalized)).length > 0) return;
  if (autoJoinRoute(normalized, mode, config)) return;
  refuse("NOT_INVITED");
}

/**
 * Accept every pending invitation for this verified email, as the accept
 * page would: the invited role, and the organization's default apps. Each
 * invitation is claimed by flipping its status first, so two sign-ins at
 * once can't both use it. Returns how many were accepted.
 */
async function acceptPendingInvitations(
  userId: string,
  email: string,
  name: string | null,
): Promise<number> {
  const joined = { id: userId, email, name };
  let accepted = 0;
  for (const invitation of await pendingInvitationsFor(email)) {
    const claimed = await db
      .update(invitations)
      .set({ status: "accepted" })
      .where(
        and(
          eq(invitations.id, invitation.id),
          eq(invitations.status, "pending"),
        ),
      )
      .returning({ id: invitations.id });
    if (claimed.length === 0) continue;

    await db.insert(members).values({
      id: crypto.randomUUID(),
      organizationId: invitation.organizationId,
      userId,
      role: invitation.role ?? "member",
      createdAt: new Date(),
    });
    await AppAccessService.grantDefaultAppsToUser(
      userId,
      invitation.organizationId,
    );
    logEvent("invitation.accepted", {
      organizationId: invitation.organizationId,
      userId,
      via: "cloudflare_access",
    });
    await emit({
      organizationId: invitation.organizationId,
      actor: actorOf(joined),
      ...catalogue.memberJoined({
        user: joined,
        role: invitation.role ?? "member",
        via: "access",
      }),
    });
    accepted += 1;
  }
  return accepted;
}

/**
 * Before Better Auth creates a session for an Access identity: let members
 * in, make an invited or auto-joining person a member first, and refuse
 * everyone else, and anyone deactivated.
 */
export async function ensureAccessMembership(
  userId: string,
  mode: AccessSignInMode,
  config: AccessConfig,
): Promise<void> {
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

  if ((await acceptPendingInvitations(user.id, email, user.name || null)) > 0) {
    forgetOrgContext(user.id);
    return;
  }

  const route = autoJoinRoute(email, mode, config);
  if (!route) refuse("NOT_INVITED");
  // A plain member with the organization's default apps, like someone who
  // accepted an invitation; other apps stay private until an admin grants
  // them.
  await db.insert(members).values({
    id: crypto.randomUUID(),
    organizationId: ownerOrganizationId,
    userId: user.id,
    role: "member",
    createdAt: new Date(),
  });
  await AppAccessService.grantDefaultAppsToUser(user.id, ownerOrganizationId);
  forgetOrgContext(user.id);
  logEvent("access.member_joined", {
    organizationId: ownerOrganizationId,
    userId: user.id,
    via: route === "domain" ? "auto_join_domain" : "outer_ring_everyone",
    mode,
  });
  const joined = { id: user.id, email, name: user.name || null };
  await emit({
    organizationId: ownerOrganizationId,
    actor: actorOf(joined),
    ...catalogue.memberJoined({ user: joined, role: "member", via: "access" }),
  });
}

/**
 * Whether some owner can sign in with Access (has an Access identity linked).
 * Until one can, EMAIL_PASSWORD_SIGN_IN=false doesn't take effect: an owner
 * always has a way in.
 */
async function ownerHasAccessSignIn(): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(members, eq(members.userId, accounts.userId))
    .where(
      and(
        eq(accounts.providerId, ACCESS_PROVIDER_ID),
        eq(members.role, "owner"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Whether password sign-in is on right now. EMAIL_PASSWORD_SIGN_IN=false
 * (with Access sign-in configured) turns it off only once an owner has
 * connected an Access identity, so it can't lock the owner out.
 */
export async function isPasswordSignInOn(
  config: AccessConfig,
): Promise<boolean> {
  return config.passwordSignIn || !(await ownerHasAccessSignIn());
}
