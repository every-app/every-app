/**
 * Production {@link SessionAuthenticator} — Better Auth + the app-access table.
 *
 * The perimeter terminates the Better Auth session cookie here. `authenticate`
 * resolves the session and the user's organization membership (the JWT's
 * orgId/orgRole claims); `hasAppAccess` enforces perimeter policy, always
 * in an active (not suspended) organization:
 *
 *  - an organization's own app: a member of it with the app installed for
 *    them (a user_app_access row). A browser session acting under another
 *    of the person's organizations is let in as their membership in the
 *    app's (the JWT carries that organization); a personal access token
 *    only ever acts in its own;
 *  - a shared app (first-party, on the hosted gateway): any live member of
 *    any organization, acting under the session's own, with no
 *    user_app_access row.
 *
 * Unlike the dependency-light perimeter package, this adapter is allowed heavy
 * imports (Better Auth, Drizzle) because it is only pulled in by the production
 * worker entry.
 */
import { auth } from "@/auth";
import { SESSION_COOKIE_NAMES } from "@/auth/session-cookie";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, users } from "@/db/schema";
import {
  isOrganizationActive,
  resolveOrgContext,
} from "@/server/organization/orgContext";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { AppRepository } from "@/server/repositories/AppRepository";
import { UserPatRepository } from "@/server/repositories/UserPatRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { isUserBanned } from "@/server/user-ban";
import { DEPLOY_SCOPE } from "@/server/user-pat-scopes";
import {
  extractBearerCredential,
  extractEveryAppBearer,
  type AuthenticatedSession,
  type RegisteredApp,
  type SessionAuthenticator,
} from "@every-app/perimeter";

type CredentialBoundSession = AuthenticatedSession & {
  credentialAppRowId?: string | null;
};

/**
 * The role a token's user holds in the token's org right now, or null when
 * they are no longer a member or have been deactivated (banned): tokens
 * outlive sessions, so both are checked on every request.
 */
export async function resolveLiveOrgRole(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      role: members.role,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row || isUserBanned(row)) return null;
  return resolvePrimaryOrganizationRole(row.role);
}

/** A token bound to one app (`credentialAppRowId`) is used on another. */
async function boundToAnotherApp(
  session: AuthenticatedSession,
  app: RegisteredApp,
): Promise<boolean> {
  if (session.credential?.kind !== "pat") return false;
  const credentialAppRowId = (session as CredentialBoundSession)
    .credentialAppRowId;
  if (!credentialAppRowId) return false;
  const servedApp = await AppRepository.findByAppSlug(
    app.appId,
    app.organizationId,
  );
  return !servedApp || servedApp.id !== credentialAppRowId;
}

/**
 * `sharedApps`: the platform policy's (server/platform-policy.ts). Without
 * it a shared row opens for nobody.
 */
export function createProdAuthenticator(
  policy: { sharedApps: boolean } = { sharedApps: false },
): SessionAuthenticator {
  return {
    sessionCookieNames: SESSION_COOKIE_NAMES,
    async authenticate(request: Request): Promise<AuthenticatedSession | null> {
      const bearerCredential = extractBearerCredential(request.headers);
      // Same reserved-credential definition the gateway uses for its CSRF
      // exemption and header stripping — the two must never diverge.
      const bearerToken = extractEveryAppBearer(request.headers);
      if (bearerToken) {
        const pat = await UserPatService.verify(bearerToken);
        // Reserved epat_ credentials fail closed and never fall through to
        // ambient cookie auth.
        if (!pat) return null;

        const role = await resolveLiveOrgRole(pat.userId, pat.organizationId);
        if (!role) return null;
        const scopes = pat.scopes.length ? pat.scopes : ["*"];
        if (scopes.some((scope) => scope.startsWith("provider:"))) {
          return null;
        }
        // A deploy key (server/deploy/) is CI's credential for the deploy
        // API only: it opens no app.
        if (scopes.includes(DEPLOY_SCOPE)) return null;

        void UserPatRepository.touchLastUsed(pat.id, pat.userId).catch(
          (error) => {
            console.error(
              "failed to update PAT last-used timestamp:",
              error instanceof Error ? (error.stack ?? error.message) : error,
            );
          },
        );

        const session: CredentialBoundSession = {
          sub: pat.userId,
          email: pat.userEmail,
          orgId: pat.organizationId,
          orgRole: role,
          credential: {
            kind: "pat",
            channel: "api",
            actor: `pat:${pat.id}`,
            scopes,
          },
          credentialAppRowId: pat.appRowId,
        };
        return session;
      }

      if (bearerCredential) {
        // No other bearer is the gateway's to accept on an app host: OAuth
        // access tokens are for the gateway's own /mcp only. Fail closed.
        // (On public routes the perimeter forwards other bearers, which
        // apps own, but never one shaped like the OAuth server's tokens.)
        return null;
      }

      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user?.id || isUserBanned(session.user)) return null;

      const org = await resolveOrgContext({
        userId: session.user.id,
        activeOrganizationId: session.session.activeOrganizationId ?? null,
      });
      if (!org) return null;

      return {
        sub: org.userId,
        email: session.user.email,
        orgId: org.orgId,
        orgRole: org.role,
      };
    },

    async hasAppAccess(session, app): Promise<boolean | AuthenticatedSession> {
      if (app.scope === "shared") {
        // The member's own organization is the one the app serves: the JWT
        // carries it, and the app scopes its data by it.
        if (!policy.sharedApps) return false;
        if (await boundToAnotherApp(session, app)) return false;
        return isOrganizationActive(session.orgId);
      }
      if (session.orgId === app.organizationId) {
        if (await boundToAnotherApp(session, app)) return false;
        if (!(await isOrganizationActive(app.organizationId))) return false;
        return AppAccessRepository.hasAccessByUserAndAppSlug(
          session.sub,
          app.appId,
          app.organizationId,
        );
      }
      // Another organization's app. A token acts in its own organization
      // only; a browser session, whose active organization is just the one
      // the person last chose, acts in the app's through their membership
      // there, so the JWT never carries claims for a different org.
      if (session.credential) return false;
      const membership = await resolveOrgContext({
        userId: session.sub,
        activeOrganizationId: app.organizationId,
      });
      if (!membership) return false;
      if (!(await isOrganizationActive(app.organizationId))) return false;
      const installed = await AppAccessRepository.hasAccessByUserAndAppSlug(
        session.sub,
        app.appId,
        app.organizationId,
      );
      if (!installed) return false;
      return {
        ...session,
        orgId: membership.orgId,
        orgRole: membership.role,
      };
    },
  };
}
