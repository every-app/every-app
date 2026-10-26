/**
 * What the consent page shows, and what its form may choose.
 *
 * The page (routes/oauth/consent.tsx) is rendered from the authorization
 * request the client sent, parsed again by the library, never from the
 * server-function URL: the client's name, its verified domain when its id is
 * a Client ID Metadata Document, where the tokens will be sent, and what the
 * user can grant: one of their organizations, all of its apps they can use
 * (including future ones) or a chosen few, and read & write or read only.
 *
 * Each app is shown with whether it has tools, read from its snapshot in
 * D1. An app with no snapshot yet (nothing has used its tools; the first
 * client can't, before it is allowed) is fetched while the page loads, for
 * a few seconds; one that doesn't answer in time stays selectable, and its
 * tools load on first use.
 */
import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { ConsentDecision } from "@/schemas/consent-decision";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { platformPolicy } from "@/server/platform-policy";
import { providerCatalogVersion } from "@/server/provider-apps";
import {
  AppToolRepository,
  type UnsyncedApp,
} from "@/server/repositories/AppToolRepository";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import {
  INLINE_SYNCS_MAX,
  RETRY_FAILED_MCP_SYNC_MS,
  RETRY_FAILED_SYNC_MS,
  syncUnsyncedCatalogs,
} from "@/server/toolbus/catalog-sync";
import { OFFLINE_ACCESS_SCOPE, type McpAuth } from "./config";
import { ON_PLATFORM_DOMAIN, onPlatformDomain } from "./own-domain";

/**
 * Whether an app has tools to serve: it does, its snapshot says it has
 * none, or there is no snapshot that says (none yet, or the last try
 * failed).
 */
type ToolState = "ready" | "none" | "unknown";

type ConsentOrganization = {
  id: string;
  name: string;
  role: string;
  apps: { rowId: string; slug: string; name: string; tools: ToolState }[];
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
      /**
       * Whether the client asked for `mcp:write` (or named no scope, which
       * leaves the choice to the server): only then is read & write offered.
       */
      writeRequested: boolean;
    }
  | { ok: false; message: string };

const START_AGAIN =
  "This authorization link is missing or no longer valid. Start connecting again from your AI app.";

const MAX_CLIENT_NAME_LENGTH = 80;

function toolState(catalogStatus: string | null): ToolState {
  switch (catalogStatus) {
    case "ok":
      return "ready";
    case "empty":
    case "unsupported":
      return "none";
    default:
      return "unknown";
  }
}

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

/**
 * The user's organizations (active ones: a suspended organization connects
 * nothing), and the apps they can use in each: its own they have access
 * to, and on the hosted gateway the shared apps, in every organization.
 */
export async function consentChoices(
  userId: string,
): Promise<ConsentOrganization[]> {
  const { memberships, accessibleApps, sharedApps } =
    await McpConnectionRepository.listChoicesForUser(userId);
  const shared = platformPolicy(env).sharedApps ? sharedApps : [];
  return memberships.flatMap((membership) => {
    const role = resolvePrimaryOrganizationRole(membership.role);
    if (!role || membership.organizationStatus !== "active") return [];
    const own = accessibleApps.filter(
      (app) => app.organizationId === membership.organizationId,
    );
    const ownIds = new Set(own.map((app) => app.appRowId));
    return [
      {
        id: membership.organizationId,
        name: membership.organizationName,
        role,
        apps: [
          ...own,
          ...shared.filter((app) => !ownIds.has(app.appRowId)),
        ].map((app) => ({
          rowId: app.appRowId,
          slug: app.appSlug,
          name: app.name,
          tools: toolState(app.catalogStatus),
        })),
      },
    ];
  });
}

/**
 * The organizations' apps again, with the tool state of every app whose
 * tools weren't snapshotted fetched now, within the page's budget: never
 * synced, synced from another version than the app runs, or failed over
 * five minutes ago, the same apps /mcp syncs on use, with the same budget
 * (and, as there, one whose last sync failed is retried after the page).
 * Up to {@link INLINE_SYNCS_MAX} across the organizations (a shared app
 * shows in every one, and is fetched once). An app that didn't answer in
 * time keeps what its row says. Never fails the page: without the
 * snapshots, it shows what it knows.
 */
async function syncUnknownCatalogs(
  userId: string,
  organizations: ConsentOrganization[],
): Promise<ConsentOrganization[]> {
  const unsynced = new Map<string, UnsyncedApp>();
  try {
    for (const organization of organizations) {
      if (unsynced.size >= INLINE_SYNCS_MAX) break;
      const apps = await AppToolRepository.findVisibleUnsyncedApps(
        {
          organizationId: organization.id,
          userId,
          sharedApps: platformPolicy(env).sharedApps,
        },
        {
          failedBefore: new Date(Date.now() - RETRY_FAILED_SYNC_MS),
          mcpFailedBefore: new Date(Date.now() - RETRY_FAILED_MCP_SYNC_MS),
          limit: INLINE_SYNCS_MAX,
          providerCatalogVersion: await providerCatalogVersion(),
        },
      );
      for (const app of apps) {
        if (unsynced.size >= INLINE_SYNCS_MAX) break;
        unsynced.set(app.rowId, app);
      }
    }
  } catch (error) {
    logEvent(
      "mcp.catalog.unavailable",
      {
        surface: "consent",
        user_id: userId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return organizations;
  }
  if (unsynced.size === 0) return organizations;
  const synced = await syncUnsyncedCatalogs([...unsynced.values()], "consent");
  if (synced.size === 0) return organizations;
  return organizations.map((organization) => ({
    ...organization,
    apps: organization.apps.map((app) => {
      const status = synced.get(app.rowId);
      return status ? { ...app, tools: toolState(status) } : app;
    }),
  }));
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
      onPlatformDomain(params.get(name) ?? "", auth.issuer, env),
    )
  ) {
    return { ok: false, message: ON_PLATFORM_DOMAIN };
  }

  const oauth = auth.authorizationServer.getOAuthApi(env);
  let details;
  let requestedScopes: string[];
  try {
    const request = await oauth.parseAuthRequest(
      new Request(`${auth.issuer}/oauth/authorize?${params}`),
    );
    requestedScopes = request.scope;
    details = await oauth.describeConsent(request);
  } catch (error) {
    const message = describeAuthorizationFailure(error);
    if (message) return { ok: false, message };
    throw error;
  }

  const organizations = await syncUnknownCatalogs(
    user.id,
    await consentChoices(user.id),
  );
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
    writeRequested: writeRequested(requestedScopes),
  };
}

/**
 * Whether a client's requested scopes allow read & write: it named
 * `mcp:write`, or named no scope at all (the server then chooses, and the
 * consent page offers both). A client that asked for `mcp:read` alone has
 * set its own ceiling, and no choice on the page raises it.
 */
function writeRequested(requested: string[]): boolean {
  return requested.length === 0 || requested.includes(MCP_WRITE_SCOPE);
}

/**
 * The access a connection gets: the person's choice, capped by what the
 * client asked for (`writeRequested`).
 */
export function grantedAccess(
  access: ConsentDecision["access"],
  requested: string[],
): ConsentDecision["access"] {
  return access === "write" && writeRequested(requested) ? "write" : "read";
}

/**
 * The scopes a connection is granted: requested ∩ supported ∩ approved.
 * `mcp:read` always (every connection reads; a client asking for
 * `mcp:write` alone reads too); `mcp:write` only when the client asked for
 * it (or named no scope) and the person chose read & write;
 * `offline_access` only when the client asked for it. Whatever else the
 * client requested grants nothing.
 */
export function grantedScopes(
  access: ConsentDecision["access"],
  requested: string[],
): string[] {
  return [
    MCP_READ_SCOPE,
    ...(grantedAccess(access, requested) === "write" ? [MCP_WRITE_SCOPE] : []),
    ...(requested.includes(OFFLINE_ACCESS_SCOPE) ? [OFFLINE_ACCESS_SCOPE] : []),
  ];
}
