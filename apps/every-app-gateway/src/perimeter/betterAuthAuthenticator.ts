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
 * Three credentials open an app host: the Better Auth session cookie, a
 * personal access token (`epat_`), and, since "Sign in with Every App"
 * (docs/design/native-sign-in.md §7), a token the gateway's own OAuth
 * server issued for exactly this host's origin: validated with that
 * audience, its connection row re-read on every request, and turned into
 * the session a personal token bound to that one app would be.
 *
 * Unlike the dependency-light perimeter package, this adapter is allowed heavy
 * imports (Better Auth, Drizzle) because it is only pulled in by the production
 * worker entry.
 */
import { env } from "cloudflare:workers";
import { auth } from "@/auth";
import { prewarmOuterRingAssertion } from "@/auth/cloudflare-access";
import { SESSION_COOKIE_NAMES } from "@/auth/session-cookie";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, organizations, users } from "@/db/schema";
import { isMcpOauthEnabled, oauthIssuer } from "@/server/oauth-flag";
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
  isGatewayOauthToken,
  logEvent,
  type AuthenticatedSession,
  type RegisteredApp,
  type SessionAuthenticator,
} from "@every-app/perimeter";

type CredentialBoundSession = AuthenticatedSession & {
  /** The one app row a personal token or native grant is bound to. */
  credentialAppRowId?: string | null;
  /**
   * The origin a native token was validated for (its audience): the host
   * the request named. `hasAppAccess` holds it to the served app's own,
   * so the token never acts on a host the row's name doesn't match.
   */
  credentialAudience?: string;
};

/**
 * The host this request is for, as the perimeter routed it (server.ts
 * resolves the app from the same header), lowercased and without a
 * trailing dot. Null for a request naming no host.
 */
function requestHost(request: Request): string | null {
  const header = request.headers.get("host")?.trim().toLowerCase();
  const host = header || new URL(request.url).host.toLowerCase();
  return host ? host.replace(/\.$/, "") : null;
}

/**
 * The session behind a token of the gateway's OAuth server presented on an
 * app host: valid for exactly this host's origin (any other audience, the
 * gateway's own `/mcp` included, is null), a native grant's, and standing
 * for a connection that still holds (`resolveNativeCaller`: revoked,
 * another person's, organization's or app's, a member removed since the
 * grant, deactivated, or a suspended organization: null; the
 * member-removed case revokes the row on the way, as `/mcp` does). Never
 * anonymous: the caller fails closed.
 */
async function resolveNativeSession(
  request: Request,
  token: string,
): Promise<CredentialBoundSession | null> {
  const issuer = isMcpOauthEnabled(env) ? oauthIssuer(env) : null;
  const host = requestHost(request);
  if (!issuer || !host) return null;
  // Loaded on the first native token an isolate sees, not with the
  // perimeter: the OAuth server's module graph (the ToolBus behind it)
  // costs a page request a database round trip when it is imported
  // statically (appHostCost.sqlite.test.ts pins the budget).
  const [
    { validateAppHostToken },
    { resolveNativeCaller },
    { appResourceOrigin },
  ] = await Promise.all([
    import("@/server/mcp-auth/config"),
    import("@/server/mcp-auth/validate"),
    import("@/server/mcp-auth/resources"),
  ]);
  // The audience is the registry hostname under the issuer's scheme, the
  // form the authorization server declares (McpAuth.resourceScheme).
  const audience = appResourceOrigin(
    host,
    new URL(issuer).protocol as "https:" | "http:",
  );

  let validated;
  try {
    validated = await validateAppHostToken(env, audience, token);
  } catch (error) {
    // Storage trouble: the token opens nothing here.
    logEvent(
      "native.token_unvalidated",
      {
        host,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return null;
  }
  if (!validated) return null;
  const caller = await resolveNativeCaller(validated.props);
  if (!caller) return null;

  return {
    sub: caller.userId,
    email: caller.email,
    orgId: caller.organizationId,
    orgRole: caller.orgRole,
    orgName: caller.organizationName,
    credential: {
      kind: "oauth",
      channel: "api",
      // The prefix MCP tool calls carry on the `mcp` channel: one
      // connection id names the grant on either channel.
      actor: `oauth:${caller.connectionId}`,
      // The one scope rule (session.ts): a native grant is full member
      // scope on its one app, whatever the client asked for.
      scopes: ["*"],
    },
    credentialAppRowId: caller.appRowId,
    credentialAudience: audience,
  };
}

/** A live membership: the role, and the organization's name for `org_name`. */
interface LiveMembership {
  role: string;
  orgName: string;
}

/**
 * The membership a token's user holds in the token's org right now (the
 * role and the organization's name), or null when they are no longer a
 * member or have been deactivated (banned): tokens outlive sessions, so
 * both are checked on every request.
 */
export async function resolveLiveMembership(
  userId: string,
  organizationId: string,
): Promise<LiveMembership | null> {
  const [row] = await db
    .select({
      role: members.role,
      banned: users.banned,
      banExpires: users.banExpires,
      orgName: organizations.name,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row || isUserBanned(row)) return null;
  const role = resolvePrimaryOrganizationRole(row.role);
  return role ? { role, orgName: row.orgName } : null;
}

/** The role alone; see {@link resolveLiveMembership}. */
export async function resolveLiveOrgRole(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  return (await resolveLiveMembership(userId, organizationId))?.role ?? null;
}

/**
 * A credential bound to one app (`credentialAppRowId`: an app-bound
 * personal token, or a native grant) is used on another; or a native token
 * validated for one host's origin is served on an app whose registered
 * hostname isn't that host. A browser session is bound to nothing.
 */
async function boundToAnotherApp(
  session: AuthenticatedSession,
  app: RegisteredApp,
): Promise<boolean> {
  if (!session.credential) return false;
  const { credentialAppRowId, credentialAudience } =
    session as CredentialBoundSession;
  if (
    credentialAudience &&
    new URL(credentialAudience).host !== app.hostname.toLowerCase()
  ) {
    return true;
  }
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

        const membership = await resolveLiveMembership(
          pat.userId,
          pat.organizationId,
        );
        if (!membership) return null;
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
          orgRole: membership.role,
          orgName: membership.orgName,
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

      if (bearerCredential && isGatewayOauthToken(bearerCredential)) {
        // A token of the gateway's OAuth server: good here only when it
        // was issued for this very host (a native grant). One for the
        // gateway's own /mcp, or for another host, fails closed, never
        // anonymous, and is never forwarded to an app.
        return resolveNativeSession(request, bearerCredential);
      }
      if (bearerCredential) {
        // No other bearer is the gateway's to accept on an app host. Fail
        // closed. (On public routes the perimeter forwards other bearers,
        // which apps own, but never one shaped like the OAuth server's
        // tokens.)
        return null;
      }

      // Behind the outer ring the session counts only with Access's word
      // for the person on this request (auth/cloudflare-access/plugin.ts
      // checks it after the session is read). Verifying that assertion
      // needs the team's keys, fetched on a fresh isolate: start it now,
      // beside the session's own reads, so neither waits for the other.
      prewarmOuterRingAssertion(request.headers);
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
        orgName: org.orgName,
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
        // A token bound to another app is refused before anything else is
        // read (a browser session is never bound: no read). Then the two
        // reads every request needs, asked together: both must hold and
        // neither depends on the other, so they cost one round trip, not
        // two in a row.
        if (await boundToAnotherApp(session, app)) return false;
        const [active, installed] = await Promise.all([
          isOrganizationActive(app.organizationId),
          AppAccessRepository.hasAccessByUserAndAppSlug(
            session.sub,
            app.appId,
            app.organizationId,
          ),
        ]);
        return active && installed;
      }
      // Another organization's app. A token acts in its own organization
      // only; a browser session, whose active organization is just the one
      // the person last chose, acts in the app's through their membership
      // there, so the JWT never carries claims for a different org.
      if (session.credential) return false;
      const [membership, active, installed] = await Promise.all([
        resolveOrgContext({
          userId: session.sub,
          activeOrganizationId: app.organizationId,
        }),
        isOrganizationActive(app.organizationId),
        AppAccessRepository.hasAccessByUserAndAppSlug(
          session.sub,
          app.appId,
          app.organizationId,
        ),
      ]);
      if (!membership || !active || !installed) return false;
      return {
        ...session,
        orgId: membership.orgId,
        orgRole: membership.role,
        orgName: membership.orgName,
      };
    },
  };
}
