/**
 * Who is calling the gateway's `/mcp`, from either credential it accepts:
 *
 *  - an OAuth access token this gateway issued (`OAuthAuthorizationServer`),
 *    whose props carry only ids: the connection, user and organization;
 *  - a personal access token (`epat_`), recognized by its shape and checked
 *    before the authorization server ever sees it.
 *
 * Nothing is cached. Every request re-reads the connection (or token), the
 * user's live membership and ban state and the organization's status, so
 * revoking a connection, removing or deactivating a member, suspending an
 * organization, or taking an app away takes effect on the next request.
 */
import { waitUntil } from "cloudflare:workers";
import {
  OAuthError,
  type OAuthAuthorizationServer,
  type OAuthResourceTokenValidation,
} from "@cloudflare/workers-oauth-provider";
import { logEvent } from "@every-app/perimeter";
import type { McpAccess, McpPrincipal } from "@every-app/toolbus";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { UserPatRepository } from "@/server/repositories/UserPatRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { isUserBanned } from "@/server/user-ban";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "@every-app/sdk/internal";

/** What an OAuth grant's props hold: ids only. */
export type McpGrantProps = {
  v: 1;
  kind: "oauth";
  connectionId: string;
  userId: string;
  organizationId: string;
};

/**
 * The resolved caller of one `/mcp` request: who they are, how much they may
 * do, and which apps: a connection's chosen apps, a token's one app, or every
 * app the user can use.
 */
export type McpCaller =
  | {
      kind: "caller";
      principal: McpPrincipal;
      apps: { connectionId?: string; appRowId?: string };
    }
  /**
   * A personal token without MCP scopes: valid, but not for this; or a
   * credential of a suspended organization.
   */
  | { kind: "refused"; reason: "token_scope" | "organization_suspended" };

function isGrantProps(value: unknown): value is McpGrantProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Record<string, unknown>;
  return (
    props["v"] === 1 &&
    props["kind"] === "oauth" &&
    typeof props["connectionId"] === "string" &&
    typeof props["userId"] === "string" &&
    typeof props["organizationId"] === "string"
  );
}

function background(task: Promise<unknown>, event: string): void {
  waitUntil(
    task.catch((error: unknown) =>
      logEvent(
        event,
        { message: error instanceof Error ? error.message : String(error) },
        "warn",
      ),
    ),
  );
}

/** A personal token's MCP access: `*` or `mcp:write` writes, `mcp:read` reads. */
function patAccess(scopes: string[]): McpAccess | null {
  if (scopes.some((scope) => scope === "*" || scope === MCP_WRITE_SCOPE)) {
    return "write";
  }
  return scopes.includes(MCP_READ_SCOPE) ? "read" : null;
}

/** The caller behind a personal access token, or null when it isn't valid. */
export async function resolvePatCaller(
  token: string,
): Promise<McpCaller | null> {
  const pat = await UserPatService.verify(token);
  if (!pat) return null;
  const scopes = pat.scopes.length ? pat.scopes : ["*"];
  if (scopes.some((scope) => scope.startsWith("provider:"))) return null;

  const membership = await OrganizationMembersRepository.findMembershipWithUser(
    pat.userId,
    pat.organizationId,
  );
  const role = membership && resolvePrimaryOrganizationRole(membership.role);
  if (!membership || !role || isUserBanned(membership)) return null;
  if (membership.organizationStatus !== "active") {
    return { kind: "refused", reason: "organization_suspended" };
  }

  const access = patAccess(scopes);
  if (!access) return { kind: "refused", reason: "token_scope" };
  background(
    UserPatRepository.touchLastUsed(pat.id, pat.userId),
    "mcp.pat.touch_failed",
  );
  return {
    kind: "caller",
    principal: {
      userId: pat.userId,
      email: membership.email,
      organizationId: pat.organizationId,
      organizationName: membership.organizationName,
      orgRole: role,
      credential: { kind: "pat", id: pat.id },
      access,
    },
    apps: pat.appRowId ? { appRowId: pat.appRowId } : {},
  };
}

/**
 * The caller behind a valid OAuth access token; null when its connection no
 * longer stands: revoked, its member removed (then it is revoked, so the
 * list of connections says so; also when they left and were invited back
 * since, however that happened), or the user deactivated;
 * "insufficient_scope" for a token narrowed below `mcp:read`.
 */
export async function resolveOauthCaller(
  props: unknown,
  scope: string[],
): Promise<McpCaller | "insufficient_scope" | null> {
  if (!isGrantProps(props)) return null;
  const connection = await McpConnectionRepository.findActiveWithMembership(
    props.connectionId,
  );
  if (
    !connection ||
    connection.userId !== props.userId ||
    connection.organizationId !== props.organizationId
  ) {
    return null;
  }
  const role = resolvePrimaryOrganizationRole(connection.role);
  if (
    !role ||
    (connection.memberSince && connection.memberSince > connection.createdAt)
  ) {
    background(
      McpConnectionRepository.revokeById(connection.id, "member_removed"),
      "mcp.connection.revoke_failed",
    );
    return null;
  }
  if (isUserBanned(connection)) return null;
  if (connection.organizationStatus !== "active") {
    return { kind: "refused", reason: "organization_suspended" };
  }

  // The connection's choice, capped by what the token carries.
  const access: McpAccess | null =
    connection.access === "write" && scope.includes(MCP_WRITE_SCOPE)
      ? "write"
      : scope.includes(MCP_READ_SCOPE) || scope.includes(MCP_WRITE_SCOPE)
        ? "read"
        : null;
  if (!access) return "insufficient_scope";

  background(
    McpConnectionRepository.touchLastUsed(connection.id),
    "mcp.connection.touch_failed",
  );
  return {
    kind: "caller",
    principal: {
      userId: connection.userId,
      email: connection.email,
      organizationId: connection.organizationId,
      organizationName: connection.organizationName,
      orgRole: role,
      credential: {
        kind: "oauth",
        id: connection.id,
        clientName: connection.clientName,
      },
      access,
    },
    apps:
      connection.appScope === "selected" ? { connectionId: connection.id } : {},
  };
}

/**
 * The resource server's token validator: personal tokens by shape first (so
 * one is never handed to the authorization server), then this gateway's own
 * access tokens. A valid token whose connection no longer stands answers
 * `invalid_token`, so the client signs in again.
 */
export function mcpBearerValidator(
  authorizationServer: OAuthAuthorizationServer<Cloudflare.Env>,
  env: Cloudflare.Env,
) {
  return async (
    resource: string,
    token: string,
  ): Promise<OAuthResourceTokenValidation<McpCaller> | null> => {
    if (token.startsWith("epat_")) {
      const caller = await resolvePatCaller(token);
      if (!caller) return null;
      return {
        props: caller,
        audience: resource,
        ...(caller.kind === "caller"
          ? {
              scope:
                caller.principal.access === "write"
                  ? [MCP_READ_SCOPE, MCP_WRITE_SCOPE]
                  : [MCP_READ_SCOPE],
              userId: caller.principal.userId,
              clientId: `pat:${caller.principal.credential.id}`,
            }
          : {}),
      };
    }

    const validated = await authorizationServer.validateToken(
      resource,
      token,
      env,
    );
    if (!validated) return null;
    const caller = await resolveOauthCaller(validated.props, validated.scope);
    if (caller === "insufficient_scope") {
      throw new OAuthError("insufficient_scope", {
        description: "This token carries no MCP access.",
        requiredScopes: [MCP_READ_SCOPE],
      });
    }
    if (!caller) {
      throw new OAuthError("invalid_token", {
        description:
          "This connection was revoked or lost its access. Connect again.",
      });
    }
    return {
      props: caller,
      audience: validated.audience,
      expiresAt: validated.expiresAt,
      scope: validated.scope,
      userId: validated.userId,
      clientId: validated.clientId,
    };
  };
}
