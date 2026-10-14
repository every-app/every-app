/**
 * What the consent page shows, and what its form may choose.
 *
 * The page (routes/oauth/consent.tsx) is rendered from the authorization
 * request the client sent, parsed again by the library, never from the
 * server-function URL: the client's name, its verified domain when its id is
 * a Client ID Metadata Document, where the tokens will be sent, and what the
 * user can grant: one of their organizations, all of its apps they can use
 * (including future ones) or a chosen few, and read & write or read only.
 */
import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { ConsentDecision } from "@/schemas/consent-decision";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import { OFFLINE_ACCESS_SCOPE, type McpAuth } from "./config";
import { ON_GATEWAY_DOMAIN, onGatewayDomain } from "./own-domain";

type ConsentOrganization = {
  id: string;
  name: string;
  role: string;
  apps: { rowId: string; slug: string; name: string; hasTools: boolean }[];
};

export type ConsentContext =
  | {
      ok: true;
      handle: string;
      client: {
        id: string;
        name: string;
        /** A CIMD client's domain, which it controls; absent for DCR. */
        domain: string | null;
        redirectUri: string;
        redirectHost: string;
      };
      email: string;
      organizations: ConsentOrganization[];
      defaultOrganizationId: string | null;
    }
  | { ok: false; message: string };

const START_AGAIN =
  "This authorization link is missing or no longer valid. Start connecting again from your AI app.";

const MAX_CLIENT_NAME_LENGTH = 80;

/**
 * A client's self-chosen name as Every App shows it: without control,
 * formatting or bidirectional-override characters (which could make it
 * read as something else), and at most 80 characters.
 */
export function clientDisplayName(name: string): string {
  const characters = [
    ...name
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  ];
  if (!characters.length) return "Unnamed app";
  return characters.length > MAX_CLIENT_NAME_LENGTH
    ? `${characters.slice(0, MAX_CLIENT_NAME_LENGTH - 1).join("")}…`
    : characters.join("");
}

/** The user's organizations, and the apps they can use in each. */
export async function consentChoices(
  userId: string,
): Promise<ConsentOrganization[]> {
  const { memberships, accessibleApps } =
    await McpConnectionRepository.listChoicesForUser(userId);
  return memberships.flatMap((membership) => {
    const role = resolvePrimaryOrganizationRole(membership.role);
    if (!role) return [];
    return [
      {
        id: membership.organizationId,
        name: membership.organizationName,
        role,
        apps: accessibleApps
          .filter((app) => app.organizationId === membership.organizationId)
          .map((app) => ({
            rowId: app.appRowId,
            slug: app.appSlug,
            name: app.name,
            hasTools: app.catalogStatus === "ok",
          })),
      },
    ];
  });
}

/** Why a client can't be shown, as the page can say it. */
export function describeAuthorizationFailure(error: unknown): string | null {
  if (error instanceof AuthorizationError) return error.description;
  if (error instanceof CimdFetchError) {
    logEvent(
      "mcp.oauth.cimd_failed",
      { reason: error.reason, url: error.metadataUrl, detail: error.detail },
      "warn",
    );
    return "This app couldn't be verified: its client metadata document could not be fetched. Try again later.";
  }
  return null;
}

/**
 * The consent page's context, rebuilt from the page's own query: the
 * authorization request's parameters, which `/oauth/authorize` forwarded,
 * plus the consent handle.
 */
export async function buildConsentContext(
  auth: McpAuth,
  env: Cloudflare.Env,
  query: string,
  user: { id: string; email: string; activeOrganizationId: string | null },
): Promise<ConsentContext> {
  const params = new URLSearchParams(query);
  const handle = params.get("handle");
  params.delete("handle");
  if (!handle) return { ok: false, message: START_AGAIN };
  // As /oauth/authorize refuses them, before the library fetches anything.
  if (
    ["client_id", "redirect_uri"].some((name) =>
      onGatewayDomain(params.get(name) ?? "", auth.issuer),
    )
  ) {
    return { ok: false, message: ON_GATEWAY_DOMAIN };
  }

  const oauth = auth.authorizationServer.getOAuthApi(env);
  let details;
  try {
    const request = await oauth.parseAuthRequest(
      new Request(`${auth.issuer}/oauth/authorize?${params}`),
    );
    details = await oauth.describeConsent(request);
  } catch (error) {
    const message = describeAuthorizationFailure(error);
    if (message) return { ok: false, message };
    throw error;
  }

  const organizations = await consentChoices(user.id);
  const defaultOrganizationId =
    organizations.find((org) => org.id === user.activeOrganizationId)?.id ??
    organizations[0]?.id ??
    null;
  return {
    ok: true,
    handle,
    client: {
      id: details.clientId,
      name: clientDisplayName(details.clientName),
      domain: details.clientDomain ?? null,
      redirectUri: details.redirectUri,
      redirectHost: details.redirectHost,
    },
    email: user.email,
    organizations,
    defaultOrganizationId,
  };
}

/**
 * The scopes a connection is granted: `mcp:read`, `mcp:write` for read &
 * write, and `offline_access` when the client asked for it. What the client
 * requested beyond that grants nothing: access is the user's choice.
 */
export function grantedScopes(
  access: ConsentDecision["access"],
  requested: string[],
): string[] {
  return [
    MCP_READ_SCOPE,
    ...(access === "write" ? [MCP_WRITE_SCOPE] : []),
    ...(requested.includes(OFFLINE_ACCESS_SCOPE) ? [OFFLINE_ACCESS_SCOPE] : []),
  ];
}
