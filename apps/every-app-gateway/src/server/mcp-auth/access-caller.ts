/**
 * The caller behind a Cloudflare Access assertion on the gateway's `/mcp`.
 *
 * With Access's Managed OAuth on the gateway's host, Access is the OAuth
 * server AI apps talk to, and every request it lets through to `/mcp`
 * carries a `Cf-Access-Jwt-Assertion` for the person (routes.ts verifies it
 * against the team's keys and the gateway's own application before anything
 * here runs). Access only says who they are; whether they may use this
 * gateway, and as what, is decided here from the gateway's own tables:
 *
 *  1. The account the outer ring linked for this Access identity: the
 *     `accounts` row `{ providerId: "cloudflare-access", accountId: email }`
 *     that plugin.ts (or the OIDC sign-in) made when the person signed in
 *     through Access in their browser. This is the same rule Better Auth's
 *     account linking enforces on the browser path: an account someone
 *     registered with another person's address is never handed to that
 *     person, so a `users` row that merely has the same email is never a
 *     fallback. Nothing is created from `/mcp`: no account, no membership.
 *     The person signs in through Access in the browser once, then AI apps
 *     work.
 *  2. The user isn't deactivated.
 *  3. Their organization: the one they belong to; with several, the one
 *     their most recent live browser session is in ("the organization your
 *     browser is in"); otherwise nothing is guessed.
 *  4. The membership as every other `/mcp` credential re-checks it: the
 *     role, the ban state, the organization's status.
 *
 * The caller then acts like a browser session: every app the member can
 * use, read and write. Nothing is cached and nothing is touched; every
 * request (and every poll of a held stream) reads it all again, so removing
 * or deactivating the person, or suspending the organization, takes effect
 * on the next one. Refusals are logged by reason only, never with the
 * email.
 */
import { and, desc, eq, gt } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { ACCESS_PROVIDER_ID } from "@/auth/cloudflare-access";
import { db } from "@/db";
import { accounts, members, sessions, users } from "@/db/schema";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { isUserBanned } from "@/server/user-ban";
import type { McpCaller } from "./validate";

type Refusal = Extract<McpCaller, { kind: "refused" }>["reason"];

function refused(reason: Refusal): McpCaller {
  logEvent("mcp.access_caller_refused", { reason }, "warn");
  return { kind: "refused", reason };
}

/**
 * The user the Access identity is linked to, with what deactivation reads;
 * null when no account was linked for it (or its user is gone).
 */
async function findLinkedUser(email: string) {
  const [row] = await db
    .select({
      id: users.id,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(
      and(
        eq(accounts.providerId, ACCESS_PROVIDER_ID),
        eq(accounts.accountId, email),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The organization a user's `/mcp` calls act under: their one membership;
 * among several, the active organization of their most recent live browser
 * session when it is one of them. Null when there is nothing to go on.
 */
async function resolveOrganizationId(
  userId: string,
): Promise<{ organizationId: string } | { reason: Refusal }> {
  const memberships = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId));
  if (memberships.length === 0) return { reason: "not_connected" };
  if (memberships.length === 1) {
    return { organizationId: memberships[0]!.organizationId };
  }
  const [recent] = await db
    .select({ organizationId: sessions.activeOrganizationId })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  const chosen = recent?.organizationId;
  if (
    chosen &&
    memberships.some((membership) => membership.organizationId === chosen)
  ) {
    return { organizationId: chosen };
  }
  return { reason: "organization_unresolved" };
}

/**
 * The caller for a verified Access identity (`email` as verifyAccessJwt
 * returns it: lowercased), or why it is refused.
 */
export async function resolveAccessCaller(email: string): Promise<McpCaller> {
  const user = await findLinkedUser(email);
  if (!user) return refused("not_connected");
  if (isUserBanned(user)) return refused("account_deactivated");

  const organization = await resolveOrganizationId(user.id);
  if ("reason" in organization) return refused(organization.reason);
  const { organizationId } = organization;

  const membership = await OrganizationMembersRepository.findMembershipWithUser(
    user.id,
    organizationId,
  );
  if (!membership) return refused("not_connected");
  const role = resolvePrimaryOrganizationRole(membership.role);
  if (!role) return refused("organization_unresolved");
  if (isUserBanned(membership)) return refused("account_deactivated");
  if (membership.organizationStatus !== "active") {
    return refused("organization_suspended");
  }

  return {
    kind: "caller",
    principal: {
      userId: user.id,
      email: membership.email,
      organizationId,
      organizationName: membership.organizationName,
      orgRole: role,
      credential: { kind: "access", id: email },
      access: "write",
    },
    apps: {},
  };
}
