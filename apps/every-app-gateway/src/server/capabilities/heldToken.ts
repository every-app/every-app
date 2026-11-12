/**
 * An app's call to an OAuth provider's API with the token the Gateway
 * holds for a person (docs/design/2026-11-oauth-one-connection.md):
 *
 *   ANY /api/integrations/<id>/<api host>/<path>     [x-everyapp-user: <user id>]
 *
 * Checked in order, each a refusal with its code:
 *
 *  1. the app's manifest lists the provider;
 *  2. the provider has a live client;
 *  3. whose connection: the member `x-everyapp-user` names (an
 *     organization's own app only, the member still active and opening the
 *     app), else the person behind the call;
 *  4. that person's connection to the provider exists, they allowed this
 *     app to use it, and it isn't expired;
 *  5. it holds every scope the app's entry declares, and the person
 *     allowed the app for every one of them;
 *  6. the host is one of the provider's (the route already parsed it);
 *  7. the token (refreshed first when due) goes on as the bearer, the
 *     app's own credentials and cookies stripped, no redirect followed,
 *     and the provider's answer comes back without its cookies.
 *
 * The token, the refresh token and the client never reach the app
 * (`oauth.held-token-never-to-app`).
 */
import {
  GATEWAY_ERROR_HEADER,
  USER_HEADER,
  capabilitySettings,
  missingScopes,
  type CapabilityLookup,
  type CapabilitySettings,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import type { OAuthClientResolver } from "@/server/oauth/client";
import type { HeldTokenPort } from "@/server/oauth/heldTokens";
import { forwardableHeaders } from "./forward";
import { setupInfo } from "@/server/setup-info";
import { capabilityRefusal, notConfiguredRefusal } from "./refusal";

/** The query keys an app's call never carries to the provider: a token of its own. */
const STRIPPED_QUERY = ["access_token", "token"];
/** What `x-everyapp-user` may hold: a user id. */
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The app making the call, as the registry knows it. */
export interface CallingApp {
  /** apps.id; absent for an app the registry has no row id for. */
  rowId?: string;
  /** The app's id (its slug). */
  appId: string;
  /** "org" for an organization's own app, "shared" for the platform's. */
  scope: string;
  tier?: string;
  organizationId: string;
  /**
   * Linked dev (`everyapp dev --gateway`): the caller is a developer's
   * computer, which never names another member's connection.
   */
  linkedDev?: boolean;
}

/**
 * What the proxy asks about members when background work names one
 * (`x-everyapp-user`): whether they may still use a connection in the app,
 * and taking the app's access to theirs away when they may not.
 */
export interface MemberAccessPort {
  /** Active in the organization, not deactivated, and opens the app. */
  mayUse(input: {
    organizationId: string;
    userId: string;
    appRowId: string;
  }): Promise<boolean>;
  /** They may not: the app's access to their connections goes. */
  revoke(input: {
    organizationId: string;
    userId: string;
    appRowId: string;
  }): Promise<void>;
}

interface HeldTokenCallOptions {
  /** `pnpm everyapp configure <app>`, or null (server/setup-info.ts). */
  setupCommand?: string | null;
  request: Request;
  id: string;
  capability: OAuthClientCapability;
  /**
   * The provider host and path the app named, parsed from the route; null
   * when the host isn't one of the provider's or the path could leave it.
   */
  upstream: URL | null;
  entry: CapabilityRequest | undefined;
  env: CapabilitySettings;
  lookup: CapabilityLookup;
  admit: () => Promise<IntegrationCallAdmission>;
  fetchUpstream: (request: Request) => Promise<Response>;
  resolveClient: OAuthClientResolver;
  connections: HeldTokenPort;
  /** The calling app; absent, no connection can be found (409). */
  app?: CallingApp;
  /** For background work naming a member; absent, `x-everyapp-user` is refused. */
  members?: MemberAccessPort;
  onCall?: (report: { capability: string; status: number }) => void;
}

/** The scopes an app's entry declares, as it wrote them. */
export function entryScopes(entry: CapabilityRequest | undefined): string[] {
  const raw = (entry as { scopes?: unknown } | undefined)?.scopes;
  return Array.isArray(raw)
    ? raw.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/** Where a person connects the provider for this app. */
export function connectPathFor(providerId: string, appId: string): string {
  return `/connect/${encodeURIComponent(providerId)}?app=${encodeURIComponent(appId)}`;
}

/** Whether background work from `app` may name a member of `organizationId`. */
function namesMembers(app: CallingApp, organizationId: string): boolean {
  return (
    !app.linkedDev &&
    Boolean(app.rowId) &&
    app.scope === "org" &&
    (app.tier === undefined || app.tier === "service_binding") &&
    organizationId === app.organizationId
  );
}

export async function handleHeldTokenCall({
  request,
  id,
  capability,
  upstream,
  entry,
  env,
  lookup,
  admit,
  fetchUpstream,
  resolveClient,
  connections,
  app,
  members,
  onCall,
  setupCommand,
}: HeldTokenCallOptions): Promise<Response> {
  const connectPath = app
    ? connectPathFor(id, app.appId)
    : `/connect/${encodeURIComponent(id)}`;
  const notConnected = (
    message: string,
    extra: { reconnect: boolean; missingScopes?: string[] },
  ) =>
    Response.json(
      {
        error: "Conflict",
        code: "integration_not_connected",
        message,
        connectPath,
        ...extra,
      },
      {
        status: 409,
        headers: { [GATEWAY_ERROR_HEADER]: "integration_not_connected" },
      },
    );

  // 1. The deployed manifest listing the provider is the grant.
  if (!entry) {
    return capabilityRefusal(
      403,
      "capability_not_requested",
      `This app doesn't list ${capability.label} in its capabilities. Add it to everyapp.config.ts (capabilities.${id}) and deploy again.`,
    );
  }
  // 2. A live client.
  const client = await resolveClient({
    id,
    capability,
    env: env as never,
    lookup,
  });
  if (!client) {
    return notConfiguredRefusal(
      setupInfo({
        label: capability.label,
        settings: capabilitySettings(capability),
        command: setupCommand ?? null,
        alternative:
          "an owner or admin adds a client under Manage workspace → Providers",
      }),
    );
  }
  // 3. Whose connection: the member background work names (this wins even
  // when a person is behind the call: an app may use any member's
  // connection to it), else the person's.
  const named = request.headers.get(USER_HEADER)?.trim() || null;
  if (named !== null && !USER_ID.test(named)) {
    return capabilityRefusal(
      400,
      "integration_body_invalid",
      `${USER_HEADER} must be a user id.`,
    );
  }
  const { caller, user } = await admit();
  if (named !== null) {
    if (!app || !members || !namesMembers(app, caller.organizationId)) {
      return capabilityRefusal(
        403,
        "integration_user_not_allowed",
        `Only an organization's own app can use a member's ${capability.label} connection by naming them (${USER_HEADER}); a shared app or linked dev uses the connection of the person behind the call.`,
      );
    }
    const may = await members.mayUse({
      organizationId: caller.organizationId,
      userId: named,
      appRowId: app.rowId!,
    });
    if (!may) {
      // They left, were deactivated or lost the app: the app's access to
      // their connection goes now, and the answer is the same as for no
      // connection.
      await members
        .revoke({
          organizationId: caller.organizationId,
          userId: named,
          appRowId: app.rowId!,
        })
        .catch(() => undefined);
      logEvent(
        "integration.proxy.member_refused",
        { capability: id, ...caller, onBehalfOf: named },
        "warn",
      );
      return notConnected(
        `${capability.label} isn't connected for this member in this app.`,
        { reconnect: false },
      );
    }
  }
  const userId = named ?? user?.id ?? null;
  if (!userId || !app?.rowId) {
    return notConnected(
      `No person is behind this call, so there is no ${capability.label} connection to use; name the member whose connection to use (for: { background: true, userId }).`,
      { reconnect: false },
    );
  }
  // 4. The connection: this person's, which they allowed this app to use.
  const owner = {
    organizationId: caller.organizationId,
    providerId: id,
    userId,
  };
  const connection = await connections.find(owner);
  if (!connection) {
    return notConnected(
      `${capability.label} isn't connected for this person yet. Send them to ${connectPath}.`,
      { reconnect: false },
    );
  }
  const allowed = await connections.allowedScopes({
    ...owner,
    appRowId: app.rowId,
  });
  if (allowed === null) {
    return notConnected(
      `This person hasn't allowed this app to use their ${capability.label} connection yet. Send them to ${connectPath}.`,
      { reconnect: false },
    );
  }
  if (connection.status === "expired") {
    return notConnected(
      `${capability.label} refused to refresh this connection; connect it again at ${connectPath}.`,
      { reconnect: true },
    );
  }
  // 5. It holds every scope the app declares, and the person allowed the
  // app for each: an app that lists more than it did then asks again.
  const declared = entryScopes(entry);
  const missing = missingScopes(capability.flow, connection.scopes, declared);
  if (missing.length > 0) {
    return notConnected(
      `This ${capability.label} connection lacks ${missing.join(", ")}, which this app needs; connect it again at ${connectPath}.`,
      { reconnect: true, missingScopes: missing },
    );
  }
  const unallowed = missingScopes(capability.flow, allowed, declared);
  if (unallowed.length > 0) {
    return notConnected(
      `This app now lists ${unallowed.join(", ")}, which this person hasn't allowed it to use on their ${capability.label} connection; send them to ${connectPath}.`,
      { reconnect: true, missingScopes: unallowed },
    );
  }
  // 6. The host is one of the provider's.
  if (
    !upstream ||
    upstream.protocol !== "https:" ||
    !(capability.api as readonly string[]).includes(upstream.host)
  ) {
    return capabilityRefusal(
      400,
      "invalid_integration_route",
      `${capability.label} calls go to ${capability.api.join(", ")}.`,
    );
  }
  // 7. The token, refreshed first when due.
  const token = await connections.accessToken({
    connection,
    providerId: id,
    capability,
    client,
    organizationId: caller.organizationId,
  });
  if (!token.ok) {
    if (token.reason === "unavailable") {
      return capabilityRefusal(
        502,
        "integration_upstream_failed",
        `${capability.label} could not refresh the connection's token; try again.`,
      );
    }
    if (token.reason === "expired") {
      await connections.expired({
        connection,
        providerId: id,
        capability,
        organizationId: caller.organizationId,
        appRowId: app.rowId,
      });
    }
    return notConnected(
      `${capability.label}'s token for this connection can't be used any more; connect it again at ${connectPath}.`,
      { reconnect: true },
    );
  }

  const method = request.method.toUpperCase();
  const headers = forwardableHeaders(request.headers);
  headers.delete("x-http-method-override");
  headers.set("authorization", `Bearer ${token.accessToken}`);
  for (const name of STRIPPED_QUERY) upstream.searchParams.delete(name);
  const body = method === "GET" || method === "HEAD" ? null : request.body;
  const upstreamRequest = new Request(upstream, {
    method,
    headers,
    body,
    signal: request.signal,
    // The token must never follow a redirect to another host.
    redirect: "manual",
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
  const logged = {
    capability: id,
    ...caller,
    host: upstream.host,
    path: upstream.pathname,
    method,
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
    ...(named !== null ? { onBehalfOf: named } : {}),
  };
  let response: Response;
  try {
    response = await fetchUpstream(upstreamRequest);
  } catch (error) {
    logEvent(
      "integration.proxy.upstream_failed",
      { ...logged, error: error instanceof Error ? error.name : "unknown" },
      "error",
    );
    return capabilityRefusal(
      502,
      "integration_upstream_failed",
      `${capability.label} could not be reached.`,
    );
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  onCall?.({ capability: id, status: response.status });
  logEvent("integration.proxy.call", { ...logged, status: response.status });
  await connections
    .used({
      connection,
      providerId: id,
      capability,
      organizationId: caller.organizationId,
      appId: app.appId,
      appRowId: app.rowId,
    })
    .catch(() => undefined);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
