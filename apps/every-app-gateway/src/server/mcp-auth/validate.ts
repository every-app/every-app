/**
 * Who is calling the gateway's `/mcp`, from the credentials it accepts:
 *
 *  - an OAuth access token this gateway issued (`OAuthAuthorizationServer`),
 *    whose props carry only ids: the connection, user and organization;
 *    (a native grant's token, whose audience is an app host, never
 *    validates here: wrong audience, and its props are refused besides);
 *  - a personal access token (`epat_`), recognized by its shape and checked
 *    before the authorization server ever sees it;
 *  - a Cloudflare Access assertion for the gateway's own Access application,
 *    where Access's Managed OAuth stands in front of `/mcp` (routes.ts, then
 *    access-caller.ts).
 *
 * Nothing is cached. Every request re-reads the connection (or token, or
 * linked account), the user's live membership and ban state and the
 * organization's status, so revoking a connection, removing or deactivating
 * a member, suspending an organization, or taking an app away takes effect
 * on the next request.
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
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { devResource } from "./resources";
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
 * What a native grant's props hold (docs/design/native-sign-in.md §5): ids
 * only, and the one app the grant opens. The grant's audience is that
 * app's origin; the perimeter validates the token for the host it arrives
 * on and then re-reads the connection with `resolveNativeCaller`.
 */
export type NativeGrantProps = {
  v: 1;
  kind: "native";
  /** mcp_connections.id */
  connectionId: string;
  userId: string;
  organizationId: string;
  /** apps.id, the one app */
  appRowId: string;
};

/**
 * What a linked dev grant's props hold (docs/design/linked-dev.md §4.1):
 * the same ids as a native grant's, under its own kind. The grant's
 * audience is `${issuer}/linked-dev/<app id>`; the endpoint validates the
 * token for that resource and then re-reads the connection with
 * `resolveDevCaller`.
 */
export type DevGrantProps = {
  v: 1;
  kind: "dev";
  connectionId: string;
  userId: string;
  organizationId: string;
  appRowId: string;
};

/**
 * The member behind a valid native token (`resolveNativeCaller`'s answer),
 * as the perimeter's authenticator builds a session from it: the session a personal token bound to this app
 * would get, with `credential.kind: "oauth"`, `channel: "api"`,
 * `actor: "oauth:<connectionId>"` and `scopes: ["*"]`.
 */
type NativeCaller = {
  connectionId: string;
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  orgRole: string;
  /** The one app the grant opens; the perimeter's `boundToAnotherApp`. */
  appRowId: string;
  /** The client's own name, verified only when `clientDomain` is set. */
  clientName: string;
  clientDomain: string | null;
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
   * A personal token without MCP scopes: valid, but not for this; a
   * credential of a suspended organization; or an Access identity with no
   * account linked here, a deactivated one, or one in several organizations
   * with no sign of which (access-caller.ts).
   */
  | {
      kind: "refused";
      reason:
        | "token_scope"
        | "organization_suspended"
        | "not_connected"
        | "account_deactivated"
        | "organization_unresolved";
    };

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

function isAppBoundGrantProps(
  value: unknown,
  kind: "native" | "dev",
): value is NativeGrantProps | DevGrantProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Record<string, unknown>;
  return (
    props["v"] === 1 &&
    props["kind"] === kind &&
    typeof props["connectionId"] === "string" &&
    typeof props["userId"] === "string" &&
    typeof props["organizationId"] === "string" &&
    typeof props["appRowId"] === "string"
  );
}

function isDevGrantProps(value: unknown): value is DevGrantProps {
  return isAppBoundGrantProps(value, "dev");
}

function isNativeGrantProps(value: unknown): value is NativeGrantProps {
  if (!value || typeof value !== "object") return false;
  const props = value as Record<string, unknown>;
  return (
    props["v"] === 1 &&
    props["kind"] === "native" &&
    typeof props["connectionId"] === "string" &&
    typeof props["userId"] === "string" &&
    typeof props["organizationId"] === "string" &&
    typeof props["appRowId"] === "string"
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

/**
 * A held subscriptions/listen stream rechecks its caller every poll; that
 * doesn't count as use of the token or connection.
 */
interface ResolveCallerOptions {
  touch?: boolean;
}

/** The caller behind a personal access token, or null when it isn't valid. */
export async function resolvePatCaller(
  token: string,
  { touch = true }: ResolveCallerOptions = {},
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
  if (touch) {
    background(
      UserPatRepository.touchLastUsed(pat.id, pat.userId),
      "mcp.pat.touch_failed",
    );
  }
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
  { touch = true }: ResolveCallerOptions = {},
): Promise<McpCaller | "insufficient_scope" | null> {
  if (!isGrantProps(props)) return null;
  const connection = await McpConnectionRepository.findActiveWithMembership(
    props.connectionId,
  );
  if (
    !connection ||
    connection.kind !== "mcp" ||
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
      McpConnectionService.revokeConnection(connection.id, "member_removed"),
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

  if (touch) {
    background(
      McpConnectionRepository.touchLastUsed(connection.id),
      "mcp.connection.touch_failed",
    );
  }
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
 * The member behind a native grant, or null when it no longer stands
 * (`native.per-request-recheck`): props of another shape, the connection
 * revoked or not native, for another user, organization or app than the
 * props say, its member removed (then it is revoked, as an MCP connection
 * is) or joined again since the consent, the user banned or deactivated,
 * or the organization not active. Null fails closed: the request is
 * refused, never anonymous. Exported for the perimeter's authenticator
 * (lane b), which validates the token for its host first.
 */
export async function resolveNativeCaller(
  props: unknown,
  { touch = true }: ResolveCallerOptions = {},
): Promise<NativeCaller | null> {
  if (!isNativeGrantProps(props)) return null;
  const caller = await resolveAppBoundCaller(props, "native", touch);
  if (!caller) return null;
  const { lastUsedAt: _lastUsedAt, ...native } = caller;
  return native;
}

/**
 * The owner or admin behind a linked dev grant (docs/design/linked-dev.md
 * §4.3), or null when it no longer stands: everything
 * {@link resolveNativeCaller} checks, and besides that the member's live
 * role is owner or admin (`dev.owner-admin-only`: a member demoted since
 * the consent is refused on the next call) and the organization still has
 * linked dev on (`dev.off-by-default`). App access is the endpoint's to
 * check with the app row. Null fails closed.
 */
export async function resolveDevCaller(
  props: unknown,
  { touch = true }: ResolveCallerOptions = {},
): Promise<(NativeCaller & { lastUsedAt: Date | null }) | null> {
  if (!isDevGrantProps(props)) return null;
  const caller = await resolveAppBoundCaller(props, "dev", touch);
  if (!caller) return null;
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") return null;
  if (!(await OrgSettingsRepository.isLinkedDevOn(caller.organizationId))) {
    return null;
  }
  return caller;
}

async function resolveAppBoundCaller(
  props: NativeGrantProps | DevGrantProps,
  kind: "native" | "dev",
  touch: boolean,
): Promise<(NativeCaller & { lastUsedAt: Date | null }) | null> {
  const connection =
    await McpConnectionRepository.findActiveNativeWithMembership(
      props.connectionId,
      kind,
    );
  if (
    !connection ||
    connection.userId !== props.userId ||
    connection.organizationId !== props.organizationId ||
    connection.appRowId !== props.appRowId
  ) {
    return null;
  }
  const role = resolvePrimaryOrganizationRole(connection.role);
  if (
    !role ||
    (connection.memberSince && connection.memberSince > connection.createdAt)
  ) {
    background(
      McpConnectionService.revokeConnection(connection.id, "member_removed"),
      "mcp.connection.revoke_failed",
    );
    return null;
  }
  if (isUserBanned(connection)) return null;
  if (connection.organizationStatus !== "active") return null;
  if (touch) {
    background(
      McpConnectionRepository.touchLastUsed(connection.id),
      "mcp.connection.touch_failed",
    );
  }
  return {
    connectionId: connection.id,
    userId: connection.userId,
    email: connection.email,
    organizationId: connection.organizationId,
    organizationName: connection.organizationName,
    orgRole: role,
    appRowId: connection.appRowId,
    clientName: connection.clientName,
    clientDomain: connection.clientDomain,
    lastUsedAt: connection.lastUsedAt,
  };
}

/**
 * Whether a grant still stands at a refresh (config.ts
 * tokenExchangeCallback): by its props' kind, the MCP connection with its
 * scope, the dev connection (its owner or admin, the switch, the app still
 * active and the audience's), or the native connection, which must also still be the audience's
 * app (the resource list dropped a deleted app's origin, so a refresh
 * naming it is `invalid_target` before this; a grant for an app whose row
 * changed hands is refused here). Throws when D1 can't say.
 */
export async function grantStands(
  props: unknown,
  scope: string[],
  audience: string,
): Promise<boolean> {
  // A refresh is a use: it keeps the connection from expiring as idle.
  if (isDevGrantProps(props)) {
    const caller = await resolveDevCaller(props);
    if (!caller) return false;
    const app = await McpConnectionRepository.findActiveAppRow(caller.appRowId);
    return (
      app !== null &&
      app.organizationId === caller.organizationId &&
      devResource(new URL(audience).origin, app.appSlug) === audience
    );
  }
  if (isNativeGrantProps(props)) {
    const caller = await resolveNativeCaller(props);
    if (!caller) return false;
    const app = await McpConnectionRepository.findAppResource(
      caller.appRowId,
      new URL(audience).protocol as "https:" | "http:",
    );
    return app !== null && app === audience;
  }
  const caller = await resolveOauthCaller(props, scope);
  return caller !== null && caller !== "insufficient_scope";
}

/**
 * The resource server's token validator: personal tokens by shape first (so
 * one is never handed to the authorization server), then this gateway's own
 * access tokens. A valid token whose connection no longer stands answers
 * `invalid_token`, so the client signs in again. A native grant's token is
 * refused by audience in the library; its props never resolve here anyway.
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
