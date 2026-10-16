/**
 * The {@link SessionAuthenticator} of a third-party app host: its own
 * `__Host-everyapp_s` cookie (@every-app/perimeter's hostSession.ts), or a
 * personal access token checked exactly as on first-party hosts; never the
 * gateway's Better Auth cookie, and no other bearer.
 *
 * The cookie is a MAC token bound to a gateway session and one app row on
 * one host. Each request verifies it, then re-reads, live, what it stands
 * for: the gateway session still exists and hasn't expired (signing out of
 * the gateway, or an admin revoking the session, ends every host session
 * made from it), the user isn't deactivated and is still a member of the
 * app's organization (the identity carries that organization and their role
 * in it), and the organization is active with the app installed for them.
 */
import { and, eq } from "drizzle-orm";
import {
  extractBearerCredential,
  extractEveryAppBearer,
  HOST_SESSION_COOKIE,
  readCookie,
  verifyHostToken,
  type AuthenticatedSession,
  type HostSessionKey,
  type RegisteredApp,
  type SessionAuthenticator,
} from "@every-app/perimeter";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { isOrganizationActive } from "@/server/organization/orgContext";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { isUserBanned } from "@/server/user-ban";
import { resolveLiveOrgRole } from "./betterAuthAuthenticator";

/** A third-party app of an active organization, installed for this user. */
async function installedThirdPartyApp(
  userId: string,
  app: RegisteredApp,
): Promise<boolean> {
  if (app.tier !== "dispatch" || app.scope !== "org") return false;
  if (!(await isOrganizationActive(app.organizationId))) return false;
  return AppAccessRepository.hasAccessByUserAndAppSlug(
    userId,
    app.appId,
    app.organizationId,
  );
}

/**
 * Whether this person may open the app on its third-party host, and as
 * which role: a member (not deactivated) of the app's active organization,
 * with the app installed for them. The control plane asks before issuing a
 * handoff code; every request on the host asks again.
 */
export async function thirdPartyAppRole(
  userId: string,
  app: RegisteredApp,
): Promise<string | null> {
  const role = await resolveLiveOrgRole(userId, app.organizationId);
  if (!role) return null;
  return (await installedThirdPartyApp(userId, app)) ? role : null;
}

/** The live gateway session's user, or null when it ended. */
async function liveGatewaySessionUser(
  sessionId: string,
  userId: string,
): Promise<{ email: string } | null> {
  const [row] = await db
    .select({
      email: users.email,
      expiresAt: sessions.expiresAt,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);
  if (!row || row.expiresAt.getTime() <= Date.now() || isUserBanned(row)) {
    return null;
  }
  return { email: row.email };
}

export function createHostSessionAuthenticator(options: {
  /** The app this host serves (its registry row). */
  app: RegisteredApp;
  host: string;
  key: HostSessionKey;
  /**
   * The first-party hosts' authenticator, for personal access tokens: with
   * one presented it reads nothing else (no cookie fallback).
   */
  tokens: SessionAuthenticator;
}): SessionAuthenticator {
  const { app, host, key, tokens } = options;
  return {
    sessionCookieNames: [HOST_SESSION_COOKIE],
    async authenticate(request): Promise<AuthenticatedSession | null> {
      if (extractEveryAppBearer(request.headers)) {
        return tokens.authenticate(request);
      }
      // Any other bearer (an OAuth token is for the gateway's own /mcp)
      // authenticates nobody, and never falls back to the cookie.
      if (extractBearerCredential(request.headers)) return null;
      const claims = await verifyHostToken(
        key,
        readCookie(request.headers, HOST_SESSION_COOKIE),
        "session",
      );
      if (!claims || claims.host !== host || claims.app !== app.rowId) {
        return null;
      }
      const user = await liveGatewaySessionUser(claims.sid, claims.sub);
      if (!user) return null;
      const role = await resolveLiveOrgRole(claims.sub, app.organizationId);
      if (!role) return null;
      return {
        sub: claims.sub,
        email: user.email,
        orgId: app.organizationId,
        orgRole: role,
      };
    },
    async hasAppAccess(session, served) {
      // A token acts in its own organization only, bound app included.
      if (session.credential) return tokens.hasAppAccess(session, served);
      if (served.rowId !== app.rowId) return false;
      if (session.orgId !== served.organizationId) return false;
      // authenticate() resolved the membership; this is the rest.
      return installedThirdPartyApp(session.sub, served);
    },
  };
}
