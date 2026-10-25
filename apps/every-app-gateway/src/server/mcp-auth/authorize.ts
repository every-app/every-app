/**
 * The two worker-level halves of the authorization endpoint, around the
 * TanStack consent page (/oauth/consent) that only displays:
 *
 *  - GET /oauth/authorize validates the request with the library, and
 *    requires PKCE of every client and a client and redirect URI off the
 *    platform's domains (own-domain.ts). Its errors are shown here, never redirected to
 *    the client: anyone can register a client with any https redirect URI,
 *    so redirecting them would make the gateway an open redirector (RFC 9700
 *    §4.11.2). It then sends a signed-out user to sign in and back, starts
 *    a consent transaction (a one-time handle, bound to this browser by a
 *    `__Host-` cookie, for ten minutes) and redirects to the page;
 *  - POST /oauth/consent/decision is the page's native form. It must come
 *    from the gateway's own origin (the control-plane CSRF guard checks the
 *    same) from a signed-in user, and it consumes the handle once: approving
 *    records an `mcp_connections` row (whose id derives from the handle, so
 *    a consent approved twice at once records one) and completes the
 *    authorization with ids-only props; denying redirects with
 *    `access_denied`.
 *
 * Responses here carry the control-plane headers (no framing, no-store, no
 * Referer) from the worker entry.
 */
import { env } from "cloudflare:workers";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { logEvent } from "@every-app/perimeter";
import { auth as betterAuth } from "@/auth";
import { parseDecisionForm } from "@/schemas/consent-decision";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { McpConnectionService } from "@/server/services/McpConnectionService";
import { isUserBanned } from "@/server/user-ban";
import { readBodyWithLimit } from "./body";
import type { McpAuth } from "./config";
import {
  clientDisplayName,
  consentChoices,
  describeAuthorizationFailure,
  grantedScopes,
} from "./consent";
import { ON_PLATFORM_DOMAIN, onPlatformDomain } from "./own-domain";
import type { McpGrantProps } from "./validate";

/** The largest consent form accepted (a few hundred app ids at most). */
const MAX_DECISION_BODY_BYTES = 64 * 1024;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A plain page for what can't go back to the client. */
export function errorPage(
  status: number,
  title: string,
  message: string,
): Response {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1f2937}h1{font-size:1.25rem}p{color:#4b5563;line-height:1.5}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function redirect(location: string, headers = new Headers()): Response {
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

async function signedInUser(request: Request) {
  const session = await betterAuth.api.getSession({ headers: request.headers });
  if (!session?.user?.id || isUserBanned(session.user)) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    activeOrganizationId: session.session.activeOrganizationId ?? null,
  };
}

const CANT_CONNECT = "Can't connect this app";

export async function handleAuthorize(
  request: Request,
  mcpAuth: McpAuth,
): Promise<Response> {
  // Before the library fetches a metadata document from it.
  const clientId = new URL(request.url).searchParams.get("client_id");
  if (clientId && onPlatformDomain(clientId, mcpAuth.issuer, env)) {
    return errorPage(400, CANT_CONNECT, ON_PLATFORM_DOMAIN);
  }
  const oauth = mcpAuth.authorizationServer.getOAuthApi(env);
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    const message = describeAuthorizationFailure(error);
    if (message) return errorPage(400, CANT_CONNECT, message);
    throw error;
  }
  // The library requires PKCE of public clients only; OAuth 2.1 and MCP
  // require it of every client.
  if (!authRequest.codeChallenge) {
    return errorPage(
      400,
      CANT_CONNECT,
      "This app didn't use PKCE (S256), which Every App requires.",
    );
  }
  if (onPlatformDomain(authRequest.redirectUri, mcpAuth.issuer, env)) {
    return errorPage(400, CANT_CONNECT, ON_PLATFORM_DOMAIN);
  }

  // Re-serialized, so the sign-in page's same-site redirect check sees no
  // literal "://" from a redirect_uri the client left unencoded.
  const params = new URLSearchParams(new URL(request.url).search);
  if (!(await signedInUser(request))) {
    params.delete("handle");
    const back = `/oauth/authorize?${params}`;
    return redirect(`/sign-in?redirect=${encodeURIComponent(back)}`);
  }

  const consent = await oauth.beginConsent(authRequest);
  params.set("handle", consent.handle);
  return redirect(`/oauth/consent?${params}`, consent.headers);
}

/**
 * A connection's id, derived from its consent's handle, so the row is also
 * the claim on that consent. The library spends a handle with a KV get and
 * then a delete, which two requests can both pass (a double-clicked Allow,
 * a resent form): only one of them can insert this row, and only it goes on
 * to create a grant.
 */
async function connectionIdFor(handle: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`every-app-gateway:mcp-connection:${handle}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `mcpc_${hex.slice(0, 32)}`;
}

/**
 * A native form POST from the consent page itself. The browser's
 * Sec-Fetch-Site decides: the page sends no Referer, so its form POSTs carry
 * `Origin: null`. Only a browser too old to send Sec-Fetch-Site is judged by
 * its Origin, which must then be the gateway's.
 */
function fromConsentPage(request: Request, issuer: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin")?.toLowerCase() === issuer;
}

export async function handleConsentDecision(
  request: Request,
  mcpAuth: McpAuth,
): Promise<Response> {
  if (!fromConsentPage(request, mcpAuth.issuer)) {
    return errorPage(
      403,
      "Can't connect this app",
      "This request didn't come from the connection page.",
    );
  }
  const user = await signedInUser(request);
  if (!user) {
    return errorPage(
      401,
      "You're signed out",
      "Sign in, then start connecting again from your AI app.",
    );
  }
  const body = await readBodyWithLimit(request, MAX_DECISION_BODY_BYTES);
  if (!body) {
    return errorPage(413, "Can't connect this app", "The form is too large.");
  }
  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    form = new FormData();
  }
  const decision = parseDecisionForm(form);
  if (!decision) {
    return errorPage(400, "Can't connect this app", "The form was incomplete.");
  }

  const oauth = mcpAuth.authorizationServer.getOAuthApi(env);
  if (decision.decision === "deny") {
    try {
      const denied = await oauth.denyConsent(request, decision.handle);
      return new Response(null, { status: 302, headers: denied.headers });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return errorPage(400, "Can't finish", error.description);
      }
      throw error;
    }
  }

  // Everything the user chose is checked before the handle is spent, so a
  // refused choice can be corrected on the same page.
  const organizationId = decision.organization_id ?? "";
  const membership = await OrganizationMembersRepository.findMembershipWithUser(
    user.id,
    organizationId,
  );
  if (!membership || !resolvePrimaryOrganizationRole(membership.role)) {
    return errorPage(
      403,
      "Can't connect this app",
      "You're not a member of that organization.",
    );
  }
  if (membership.organizationStatus !== "active") {
    return errorPage(
      403,
      "Can't connect this app",
      "That organization is suspended.",
    );
  }
  const selectedApps = [...new Set(decision.app_ids)];
  if (decision.app_mode === "selected") {
    const usable = new Set(
      (await consentChoices(user.id))
        .find((org) => org.id === organizationId)
        ?.apps.map((app) => app.rowId) ?? [],
    );
    if (!selectedApps.length || selectedApps.some((id) => !usable.has(id))) {
      return errorPage(
        400,
        "Can't connect this app",
        "Choose at least one app you can use in that organization.",
      );
    }
  }

  let approved;
  try {
    approved = await oauth.approveConsent(request, decision.handle);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorPage(400, "Can't finish", error.description);
    }
    throw error;
  }
  if (
    approved.request.clientId !== decision.client_id ||
    approved.request.redirectUri !== decision.redirect_uri
  ) {
    return errorPage(
      400,
      "Can't finish",
      "This page was for a different app. Start connecting again from your AI app.",
    );
  }

  let details;
  try {
    details = await oauth.describeConsent(approved.request);
  } catch (error) {
    const message = describeAuthorizationFailure(error);
    if (message) return errorPage(400, "Can't connect this app", message);
    throw error;
  }

  const connectionId = await connectionIdFor(decision.handle);
  const createdAt = new Date();
  const created = await McpConnectionRepository.create({
    id: connectionId,
    userId: user.id,
    organizationId,
    clientId: approved.request.clientId,
    clientName: clientDisplayName(details.clientName),
    clientDomain: details.clientDomain ?? null,
    redirectUri: approved.request.redirectUri,
    redirectHost: details.redirectHost,
    appScope: decision.app_mode,
    appRowIds: decision.app_mode === "selected" ? selectedApps : [],
    access: decision.access,
    createdAt,
  });
  if (!created) {
    return errorPage(
      409,
      "Already answered",
      "This connection request was already answered. If your AI app isn't connected, start connecting again from it.",
    );
  }
  await McpConnectionService.announceCreated({
    id: connectionId,
    userId: user.id,
    organizationId,
    clientName: clientDisplayName(details.clientName),
    clientDomain: details.clientDomain ?? null,
    access: decision.access,
    appScope: decision.app_mode,
  });

  const props: McpGrantProps = {
    v: 1,
    kind: "oauth",
    connectionId,
    userId: user.id,
    organizationId,
  };
  let redirectTo: string;
  try {
    ({ redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user.id,
      scope: grantedScopes(decision.access, approved.request.scope),
      props,
      metadata: {
        connectionId,
        organizationId,
        connectionCreatedAt: createdAt.getTime(),
      },
      // Replaced below, by installation rather than exact redirect URI.
      revokeExistingGrants: false,
    }));
  } catch (error) {
    await McpConnectionService.revokeConnection(connectionId, "failed");
    const message = describeAuthorizationFailure(error);
    if (message) return errorPage(400, "Can't connect this app", message);
    throw error;
  }
  // Only now that it is complete, so a failed completion keeps the earlier
  // connection working. Best effort: the code goes out regardless.
  await McpConnectionService.supersedeEarlier({
    id: connectionId,
    userId: user.id,
    organizationId,
    clientId: approved.request.clientId,
    clientDomain: details.clientDomain ?? null,
    redirectUri: approved.request.redirectUri,
    createdAt,
  });

  logEvent("mcp.connection.created", {
    connection: connectionId,
    org: organizationId,
    user_id: user.id,
    client: approved.request.clientId,
    verified_domain: details.clientDomain ?? null,
    apps: decision.app_mode,
    access: decision.access,
  });
  return redirect(redirectTo, approved.headers);
}
