/**
 * An app's call to an OAuth provider's API with the token the Gateway
 * holds for a person (docs/design/2026-11-oauth-one-connection.md):
 *
 *   ANY /api/integrations/<id>/<api host>/<path>     [x-everyapp-user: <user id>]
 *
 * Checked in order, each a refusal with its code:
 *
 *  1. the app's manifest lists the provider;
 *  2. the provider is set up: a live client, or Composio on for the
 *     organization and serving what the app lists
 *     (docs/design/2026-11-composio.md);
 *  3. whose connection: the member `x-everyapp-user` names (an
 *     organization's own app only, the member still active and opening the
 *     app), else the person behind the call;
 *  4. that person's connection to the provider exists, they allowed this
 *     app to use it, it isn't expired, and it was made the way the
 *     provider is served now;
 *  5. it holds what the app's entry declares, and the person allowed the
 *     app for every scope of it;
 *  6. the host is one of the provider's (the route already parsed it);
 *  7. by how the connection was made. With the client: the token
 *     (refreshed first when due) goes on as the bearer, the app's own
 *     credentials and cookies stripped, no redirect followed, and the
 *     provider's answer comes back without its cookies. Through Composio:
 *     one request to Composio, which adds the token
 *     (capabilities/composioCall.ts).
 *
 * The token, the refresh token and the client never reach the app
 * (`oauth.held-token-never-to-app`).
 */
import {
  ConnectionVia,
  GATEWAY_ERROR_HEADER,
  USER_HEADER,
  capabilitySettings,
  composioServes,
  composioServicesNeeded,
  missingScopes,
  type CapabilityLookup,
  type CapabilitySettings,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type { ComposioCallPort } from "@/server/composio/calls";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import { connectionLacks } from "@/server/oauth/holding";
import type { OAuthClientResolver } from "@/server/oauth/client";
import type { HeldTokenPort } from "@/server/oauth/heldTokens";
import { sendThroughComposio } from "./composioCall";
import { STRIPPED_QUERY, forwardableHeaders } from "./forward";
import { setupInfo } from "@/server/setup-info";
import { capabilityRefusal, notConfiguredRefusal } from "./refusal";

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
  /** Composio, for a provider with no client; absent, such a provider is not set up. */
  composio?: ComposioCallPort;
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
  composio,
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
  // The call is admitted once, by whichever step first needs to know whom
  // it is for.
  let admission: IntegrationCallAdmission | null = null;
  const admitted = async () => (admission ??= await admit());
  const declared = entryScopes(entry);
  // 2. A live client, or Composio: on for the organization, with a
  // service for every scope the app lists.
  const client = await resolveClient({
    id,
    capability,
    env: env as never,
    lookup,
  });
  let served: ConnectionVia | null = client ? ConnectionVia.OAuth : null;
  if (
    !client &&
    composio &&
    composioServicesNeeded(id, capability.flow, declared) !== null &&
    (await composio.on((await admitted()).caller.organizationId))
  ) {
    served = ConnectionVia.Composio;
  }
  if (served === null) {
    return notConfiguredRefusal(
      setupInfo({
        label: capability.label,
        settings: capabilitySettings(capability),
        command: setupCommand ?? null,
        alternative: composioServes(id)
          ? "an owner or admin adds a client, or turns Composio on, under Manage workspace → Providers"
          : "an owner or admin adds a client under Manage workspace → Providers",
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
  const { caller, user } = await admitted();
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
      `This ${capability.label} connection can't be used any more; connect it again at ${connectPath}.`,
      { reconnect: true },
    );
  }
  // A provider is served one way: a connection made the other way (through
  // Composio before an admin added a client, or with a client that is
  // gone) is reconnected.
  if (connection.via !== served) {
    return notConnected(
      `This ${capability.label} connection was made ${connection.via === ConnectionVia.Composio ? "through Composio, and this Gateway has its own OAuth app for the provider now" : "with an OAuth app this Gateway no longer has"}; connect it again at ${connectPath}.`,
      { reconnect: true },
    );
  }
  // 5. The provider has been asked for every scope the app declares (a
  // connection through Composio: has an account for each one's service),
  // and the person allowed the app for each: an app that lists more than
  // it did then asks again. A scope the person declined at the provider
  // (asked, not held) refuses nothing here: the call goes, and the
  // provider refuses the ones that need it.
  const missing = connectionLacks(
    { id, flow: capability.flow },
    connection,
    declared,
  );
  if (missing.length > 0) {
    return notConnected(
      `This ${capability.label} connection was made before this app listed ${missing.join(", ")}; connect it again at ${connectPath}.`,
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
  const method = request.method.toUpperCase();
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
  /** The call went through: counted, logged, and the connection marked used. */
  const answered = async (status: number, extra: Record<string, unknown>) => {
    onCall?.({ capability: id, status });
    logEvent("integration.proxy.call", { ...logged, ...extra, status });
    await connections
      .used({
        connection,
        providerId: id,
        capability,
        organizationId: caller.organizationId,
        appId: app.appId,
        appRowId: app.rowId!,
      })
      .catch(() => undefined);
  };
  // 7. Through Composio, for a connection made there.
  if (!client || served !== ConnectionVia.OAuth) {
    // Served through Composio only with its port, and with the client
    // only with one: anything else has no way to the provider.
    if (!composio || served !== ConnectionVia.Composio) {
      return capabilityRefusal(
        502,
        "integration_upstream_failed",
        `${capability.label} could not be reached.`,
      );
    }
    const outcome = await sendThroughComposio({
      request,
      id,
      capability,
      upstream,
      composio,
      connection,
      organizationId: caller.organizationId,
      connectPath,
    });
    const via = { via: ConnectionVia.Composio };
    switch (outcome.kind) {
      case "answer":
        await answered(outcome.response.status, {
          ...via,
          service: outcome.service,
        });
        return outcome.response;
      case "reconnect":
        if (outcome.expired) {
          await connections.expired({
            connection,
            providerId: id,
            capability,
            organizationId: caller.organizationId,
            appRowId: app.rowId,
          });
        }
        return notConnected(outcome.message, { reconnect: true });
      case "refusal":
        if (outcome.response.status === 502) {
          logEvent(
            "integration.proxy.upstream_failed",
            { ...logged, ...via, service: outcome.service },
            "error",
          );
        }
        return outcome.response;
    }
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
    if (token.reason === "retry") {
      return capabilityRefusal(
        502,
        "integration_upstream_failed",
        `${capability.label} could not refresh the connection's token; try again.`,
      );
    }
    if (token.first) {
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
  // The provider no longer takes this token though it isn't due by the
  // clock (it gave no lifetime, or ended it early): refresh it and send
  // the request once more. Only a request without a body, which can be
  // sent twice.
  if (response.status === 401 && !body) {
    const again = await connections.accessToken({
      connection,
      providerId: id,
      capability,
      client,
      organizationId: caller.organizationId,
      rejected: token.version,
    });
    if (again.ok && again.version !== token.version) {
      const retryHeaders = new Headers(headers);
      retryHeaders.set("authorization", `Bearer ${again.accessToken}`);
      try {
        const retried = await fetchUpstream(
          new Request(upstream, {
            method,
            headers: retryHeaders,
            signal: request.signal,
            redirect: "manual",
          }),
        );
        await response.body?.cancel().catch(() => undefined);
        response = retried;
      } catch {
        // The first answer stands.
      }
    } else if (!again.ok && again.reason === "reconnect" && again.first) {
      await connections.expired({
        connection,
        providerId: id,
        capability,
        organizationId: caller.organizationId,
        appRowId: app.rowId,
      });
    }
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  await answered(response.status, {});
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
