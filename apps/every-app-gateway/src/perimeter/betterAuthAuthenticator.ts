/**
 * Production {@link SessionAuthenticator} — Better Auth + the app-access table.
 *
 * The perimeter terminates the Better Auth session cookie here. `authenticate`
 * resolves the session and the user's organization membership (the JWT's
 * orgId/orgRole claims); `hasAppAccess` enforces perimeter policy: org member + app
 * installed for that user (user_app_access row).
 *
 * Unlike the dependency-light perimeter package, this adapter is allowed heavy
 * imports (Better Auth, Drizzle) because it is only pulled in by the production
 * worker entry.
 */
import { auth } from "@/auth";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, users } from "@/db/schema";
import { resolveOrgContext } from "@/server/organization/orgContext";
import { AppAccessRepository } from "@/server/repositories/AppAccessRepository";
import { AppRepository } from "@/server/repositories/AppRepository";
import { UserPatRepository } from "@/server/repositories/UserPatRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import {
  extractBearerCredential,
  extractEveryAppBearer,
  type AuthenticatedSession,
  type SessionAuthenticator,
} from "@every-app/perimeter";
import { env } from "cloudflare:workers";
import {
  getOauthProvider,
  syntheticExecutionContext,
} from "@/server/oauth-provider";

type CredentialBoundSession = AuthenticatedSession & {
  credentialAppRowId?: string | null;
};

type OauthGrantProps = {
  userId: string;
  organizationId: string;
  appRowId: string;
  appSlug?: string;
  scopes?: string[];
  clientId?: string;
};

async function resolveLiveOrgRole(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const row = await db.query.members.findFirst({
    where: and(
      eq(members.userId, userId),
      eq(members.organizationId, organizationId),
    ),
  });
  if (!row) return null;
  return resolvePrimaryOrganizationRole(row.role);
}

export function createProdAuthenticator(): SessionAuthenticator {
  return {
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
        const oauth = await authenticateOauthBearer(request, bearerCredential);
        return oauth;
      }

      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user?.id) return null;

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

    async hasAppAccess(session, app): Promise<boolean> {
      // The org the session acts under must be the org the app belongs to —
      // otherwise the minted JWT would carry claims for a different org.
      if (session.orgId !== app.organizationId) return false;
      if (
        session.credential?.kind === "pat" ||
        session.credential?.kind === "oauth"
      ) {
        const credentialAppRowId = (session as CredentialBoundSession)
          .credentialAppRowId;
        if (credentialAppRowId) {
          const servedApp = await AppRepository.findByAppSlug(
            app.appId,
            app.organizationId,
          );
          if (!servedApp || servedApp.id !== credentialAppRowId) return false;
        }
      }
      return AppAccessRepository.hasAccessByUserAndAppSlug(
        session.sub,
        app.appId,
        app.organizationId,
      );
    },
  };
}

function isOauthGrantProps(value: unknown): value is OauthGrantProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Record<string, unknown>;
  // appRowId is mandatory: every OAuth grant is consented for exactly one
  // app. A grant without the binding would silently widen to every app the
  // user can access.
  return (
    typeof props.userId === "string" &&
    typeof props.organizationId === "string" &&
    typeof props.appRowId === "string" &&
    props.appRowId.length > 0
  );
}

async function authenticateOauthBearer(
  request: Request,
  bearerCredential: string,
): Promise<AuthenticatedSession | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization || !env.GATEWAY_URL) return null;

  const response = await getOauthProvider().fetch(
    new Request(new URL("/oauth/userinfo", env.GATEWAY_URL), {
      headers: { authorization },
    }),
    env,
    syntheticExecutionContext(),
  );
  if (!response.ok) return null;

  const props = (await response.json()) as unknown;
  if (!isOauthGrantProps(props)) return null;

  const role = await resolveLiveOrgRole(props.userId, props.organizationId);
  if (!role) return null;
  const user = await db.query.users.findFirst({
    where: eq(users.id, props.userId),
  });
  if (!user) return null;

  if (
    Array.isArray(props.scopes) &&
    props.scopes.some((scope) => typeof scope !== "string")
  ) {
    return null;
  }
  const scopes =
    Array.isArray(props.scopes) && props.scopes.length ? props.scopes : ["*"];
  if (scopes.some((scope) => scope.startsWith("provider:"))) return null;

  let actor = props.clientId ? `oauth:${props.clientId}` : "oauth:unknown";
  try {
    const token = await env.OAUTH_PROVIDER?.unwrapToken<{
      clientId?: string;
    }>(bearerCredential);
    if (token?.grantId) {
      actor = `oauth:${token.grantId}`;
    } else if (token?.grant.clientId) {
      actor = `oauth:${token.grant.clientId}`;
    }
  } catch {
    // Userinfo validation already succeeded; grant id is best-effort.
  }

  const session: CredentialBoundSession = {
    sub: props.userId,
    email: user.email,
    orgId: props.organizationId,
    orgRole: role,
    credential: {
      kind: "oauth",
      channel: "api",
      actor,
      scopes,
    },
    credentialAppRowId: props.appRowId,
  };
  return session;
}
