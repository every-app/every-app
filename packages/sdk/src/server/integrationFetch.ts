import {
  APP_ID_ENV,
  CATALOG,
  ConfigurationError,
  GATEWAY_ERROR_HEADER,
  INTEGRATION_PROXY_PREFIX,
  apiKeyHosts,
  authorizationFor,
  capabilitySettings,
  devProviderFile,
  integrationProxyPath,
  providerSettingPrefix,
  resolveDevProvider,
  type ApiKeyCapability,
  type ApiKeyCapabilityId,
  type CapabilityId,
  type EmailCapabilityStatus,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
  EMAIL_SENDERS_ENV,
  chooseEmailProvider,
  parseEmailList,
  parseEmailSender,
} from "../internal/index.js";
import {
  applyAttribution,
  attributionFor,
  type GatewayCallFor,
} from "./attribution.js";
import { connectPath } from "./connectUrl.js";
import type { SetupInfo } from "./refusal.js";
import {
  BINDING_ORIGIN,
  gatewayBinding,
  streamingRequest,
} from "./gatewayFetch.js";

export interface IntegrationFetchOptions {
  /**
   * The Worker env: the EVERY_APP_GATEWAY binding when deployed, or in local
   * dev EVERYAPP_DEV and the provider's key (e.g. DATAFORSEO_API_KEY in
   * `.dev.vars`), or for an OAuth provider a token you obtained yourself
   * (`GOOGLE_WORKSPACE_ACCESS_TOKEN`, {@link devAccessTokenName}).
   */
  env: object;
  /**
   * A provider the app lists in its manifest's `capabilities`: one whose
   * key the gateway holds, or an OAuth provider whose connections it
   * holds. The built-in catalog's ids complete; a provider registered on
   * the gateway (`everyapp provider add`) is any other id, reached
   * through the binding, which checks it. The `email` capability is sent
   * with `sendEmail()` instead.
   */
  provider: ApiKeyCapabilityId | OAuthClientCapabilityId | (string & {});
  /**
   * Whom the call is for. Left out, the request `everyApp()` is serving
   * (its person, while the identity is good) or the organization
   * an event delivery runs under; outside both, `RequestContextError`.
   * Explicitly: the inbound request, or `{ background: true,
   * organizationId }` for work no person started (crons, Workflows,
   * queues). A shared app's Worker must end up with one or the other
   * ({@link AttributionError}).
   *
   * For an OAuth provider the call uses the connection the person behind
   * it made in this app. `{ background: true, userId }` names another
   * member's connection to this app instead, at any time, even while
   * serving a different person: the call then carries that member and
   * not the person being served. Only an organization's own app may.
   */
  for?: GatewayCallFor;
  /**
   * `true`: answer null instead of throwing `ConfigurationError` when the
   * provider is unavailable (no binding, and in local dev not its
   * settings in `.dev.vars`), so a feature that can do without it checks
   * for null. A wrong provider id, a binding that isn't one, and an
   * attribution mistake still throw. An OAuth provider is never
   * unavailable this way: without a connection its calls answer
   * `integration_not_connected`.
   */
  optional?: boolean;
}

/**
 * A `fetch` for one of the gateway's capabilities. Call the provider's real
 * URLs (`https://api.dataforseo.com/v3/…`); this sends them over the
 * AppGateway binding, which checks the app's manifest lists the capability,
 * injects the key the gateway holds and forwards the call. The app never
 * sees the key. A refusal the gateway makes itself comes back as a response
 * {@link gatewayRefusal} recognizes; anything else is the provider's answer.
 *
 * For an OAuth provider (`google-workspace`, `github`, ...) the gateway
 * puts the token of the person's connection in this app on the call, to
 * the provider's API hosts only. Without one the answer is a 409
 * `integration_not_connected` refusal with the `connectPath` to send the
 * person to ({@link connectUrl}).
 *
 * In local dev only, with no binding, the developer's own key from
 * `.dev.vars` reaches the provider directly, under the gateway's names:
 * a catalog provider's from the catalog, a provider registered on the
 * gateway from its spec in `.everyapp/providers/<id>.json` (`everyapp
 * provider show <id> --save` writes it), put on the call as the gateway's
 * spec says. An OAuth provider's calls carry a token you obtained
 * yourself ({@link devAccessTokenName}), to its API hosts only.
 */
export function integrationFetch(
  options: IntegrationFetchOptions & { optional: true },
): typeof fetch | null;
export function integrationFetch(
  options: IntegrationFetchOptions,
): typeof fetch;
export function integrationFetch({
  env,
  provider,
  for: explicitTarget,
  optional = false,
}: IntegrationFetchOptions): typeof fetch | null {
  const catalogEntry = fetchableCapability(provider);
  const what = `integrationFetch("${provider}")`;
  // Checked now, so a call nobody's fails where the fetch is made; and
  // again per call, where an identity may since have neared its expiry.
  attributionFor(env, explicitTarget, what);
  const values = env as Record<string, unknown>;
  const binding = gatewayBinding(env);

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  // An id outside the catalog: the gateway's to resolve over the binding,
  // or in local dev, the registered row's spec `everyapp dev` hands over.
  const integration =
    catalogEntry ??
    (binding ? undefined : devRegisteredProvider(provider, values));
  // An API-key provider in local dev: the developer's own key. An OAuth
  // provider decides per call (a dev token, or `integration_not_connected`).
  const local =
    binding || integration?.mode !== "api_key"
      ? null
      : localAuthorization(integration, values);
  if (!binding && integration?.mode === "api_key" && !local) {
    if (optional) return null;
    throw new ConfigurationError(
      `${integration.label} is unavailable: deploy with the EVERY_APP_GATEWAY binding, or set ${capabilitySettings(integration).join(", ")} in .dev.vars for local development.`,
    );
  }

  return async (input, init) => {
    const target = attributionFor(env, explicitTarget, what);
    const outbound = new Request(input, init);
    const upstream = new URL(outbound.url);
    const headers = new Headers(outbound.headers);
    headers.delete("authorization");
    headers.delete("cookie");

    if (!integration) {
      // A gateway-registered provider: the gateway holds its spec, so the
      // gateway checks the host; here only that it is https at all.
      if (upstream.protocol !== "https:") {
        throw new TypeError(
          `integrationFetch("${provider}") reaches https URLs only, not ${upstream.protocol}//${upstream.host}.`,
        );
      }
      applyAttribution(headers, target);
      return binding!.fetch(
        streamingRequest(
          `${BINDING_ORIGIN}${integrationProxyPath(provider, upstream)}`,
          outbound,
          headers,
        ),
      );
    }

    // In local dev a provider's host setting (`.dev.vars`) adds its host,
    // as the gateway's setting does there.
    const hosts =
      integration.mode === "oauth_client"
        ? [...integration.api]
        : binding
          ? [...integration.hosts]
          : apiKeyHosts(integration, values);
    if (upstream.protocol !== "https:" || !hosts.includes(upstream.host)) {
      throw new TypeError(
        `integrationFetch("${provider}") only reaches ${hosts.join(", ")}, not ${upstream.host}.`,
      );
    }
    if (binding) {
      applyAttribution(headers, target);
      return binding.fetch(
        streamingRequest(
          `${BINDING_ORIGIN}${integrationProxyPath(provider, upstream)}`,
          outbound,
          headers,
        ),
      );
    }

    applyAttribution(headers, undefined);
    if (integration.mode === "oauth_client") {
      return devHeldTokenCall({
        provider,
        capability: integration,
        outbound,
        upstream,
        headers,
        values,
      });
    }
    // The developer's own key, put where the provider's entry says, as the
    // gateway would put its own.
    const auth = local as DevAuthorization;
    for (const [name, value] of Object.entries(auth.headers)) {
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(auth.query)) {
      upstream.searchParams.set(name, value);
    }
    return fetch(streamingRequest(upstream.toString(), outbound, headers));
  };
}

/**
 * The `.dev.vars` name of a held token for `provider` in local dev
 * (`GOOGLE_WORKSPACE_ACCESS_TOKEN`, `GITHUB_ACCESS_TOKEN`): a token the
 * developer obtained themselves, standing in for the connection the
 * gateway would hold. Dev-only: the gateway never reads it.
 */
export function devAccessTokenName(provider: string): string {
  return `${providerSettingPrefix(provider)}ACCESS_TOKEN`;
}

/**
 * Where a person connects `provider` in this app:
 * `/connect/<id>?app=<EVERYAPP_APP_ID>`, as the gateway's refusal and
 * status name it (without the app id when the env has none).
 */
function appConnectPath(
  provider: string,
  values: Record<string, unknown>,
): string {
  const app = stringValue(values[APP_ID_ENV]);
  return app
    ? `${connectPath(provider)}?app=${encodeURIComponent(app)}`
    : connectPath(provider);
}

/**
 * An app's call to an OAuth provider's API in local dev, with no
 * gateway: the developer's own token from `.dev.vars` as the bearer,
 * straight to the provider (the host was checked already), or the
 * gateway's `integration_not_connected` refusal without one.
 */
async function devHeldTokenCall({
  provider,
  capability,
  outbound,
  upstream,
  headers,
  values,
}: {
  provider: string;
  capability: OAuthClientCapability;
  outbound: Request;
  upstream: URL;
  headers: Headers;
  values: Record<string, unknown>;
}): Promise<Response> {
  const token = stringValue(values[devAccessTokenName(provider)]);
  if (!token) {
    const path = appConnectPath(provider, values);
    return devRefusal(
      409,
      "integration_not_connected",
      `${capability.label} isn't connected here. In local dev, set ${devAccessTokenName(provider)} in .dev.vars to a token you obtained yourself; deployed, the person connects in the app at ${path}.`,
      { connectPath: path, reconnect: false },
    );
  }
  const method = outbound.method.toUpperCase();
  headers.set("authorization", `Bearer ${token}`);
  for (const name of ["access_token", "token"]) {
    upstream.searchParams.delete(name);
  }
  headers.delete("x-http-method-override");
  return fetch(
    new Request(upstream.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? null : outbound.body,
      signal: outbound.signal,
      // As the gateway: the token never follows a redirect.
      redirect: "manual",
      ...(method === "GET" || method === "HEAD" ? {} : { duplex: "half" }),
    } as RequestInit),
  );
}

type DevAuthorization = NonNullable<ReturnType<typeof authorizationFor>>;

/**
 * The developer's own key from `.dev.vars` (with EVERYAPP_DEV set), under
 * the gateway's names; null until every setting it needs is.
 */
function localAuthorization(
  integration: ApiKeyCapability,
  values: Record<string, unknown>,
): DevAuthorization | null {
  if (!values["EVERYAPP_DEV"]) return null;
  return authorizationFor(integration, values);
}

/**
 * The gateway's refusal shape (`{ error, code, message }`, the code in
 * `x-everyapp-error`) from the local-dev twin, so {@link gatewayRefusal}
 * reads it the same way.
 */
function devRefusal(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  const labels: Record<number, string> = { 409: "Conflict" };
  return Response.json(
    { error: labels[status] ?? "Error", code, message, ...extra },
    { status, headers: { [GATEWAY_ERROR_HEADER]: code } },
  );
}

/**
 * The manifest's entry for `id` in local dev, from
 * EVERYAPP_DEV_CAPABILITIES (the manifest's `capabilities` as JSON, which
 * `everyAppWorker()` writes in dev): the entry, `null` when the manifest
 * doesn't list it, `undefined` when the variable is missing or isn't JSON
 * (a hand-rolled harness), so nothing is known.
 */
function devManifestEntry(
  id: string,
  values: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const raw = values["EVERYAPP_DEV_CAPABILITIES"];
  if (typeof raw !== "string") return undefined;
  let capabilities: Record<string, unknown> | undefined;
  try {
    capabilities = jsonRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (!capabilities) return undefined;
  return Object.hasOwn(capabilities, id)
    ? (jsonRecord(capabilities[id]) ?? null)
    : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A provider outside the catalog in local dev (no binding): the gateway
 * row's spec from EVERYAPP_DEV_PROVIDERS (`.everyapp/providers/<id>.json`,
 * which `everyAppWorker()` reads in dev), or a ConfigurationError naming
 * the file that doesn't parse, or the command that writes one.
 */
function devRegisteredProvider(
  provider: string,
  values: Record<string, unknown>,
): ApiKeyCapability | OAuthClientCapability {
  if (!values["EVERYAPP_DEV"]) {
    throw new ConfigurationError(
      `"${provider}" isn't in the built-in provider catalog. A provider registered on the gateway (everyapp provider add) is reached through the EVERY_APP_GATEWAY binding, or in everyapp dev from ${devProviderFile(provider)}.`,
    );
  }
  const resolved = resolveDevProvider(values, provider);
  if (!resolved.found) throw new ConfigurationError(resolved.problem);
  if (resolved.capability.mode === "ai") {
    throw new ConfigurationError(
      `${provider} is an AI provider: list it under providers and call it with createGatewayFetch(), not integrationFetch().`,
    );
  }
  return resolved.capability;
}

/**
 * The provider `integrationFetch()` calls: one whose key or OAuth client
 * the gateway holds, or undefined for an id outside the built-in catalog
 * (a provider registered on the gateway, which the binding resolves).
 */
function fetchableCapability(
  provider: string,
): ApiKeyCapability | OAuthClientCapability | undefined {
  const found = CATALOG.get(String(provider));
  if (!found) return undefined;
  if (found.mode === "service") {
    throw new ConfigurationError(
      `${String(provider)} is a gateway service: call its helper from @every-app/sdk/server (sendEmail(), listMembers()), not integrationFetch().`,
    );
  }
  if (found.mode === "ai") {
    throw new ConfigurationError(
      `${String(provider)} is an AI provider: list it under providers and call it with createGatewayFetch(), not integrationFetch().`,
    );
  }
  return found;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface IntegrationStatus extends SetupInfo {
  /** The app's manifest lists the capability. */
  requested: boolean;
  /** The gateway holds a key for it (in local dev: `.dev.vars` sets one). */
  configured: boolean;
  /** Calls would go through. */
  ready: boolean;
}

/**
 * The email capability's status: as {@link IntegrationStatus}, plus the
 * From a message without `from` gets, the `from` patterns the gateway
 * accepts from this app (its installation's senders, `everyapp email set
 * --sender`) and the provider mail goes out with (`cloudflare` or `resend`).
 */
export type EmailIntegrationStatus = IntegrationStatus &
  Pick<EmailCapabilityStatus, "sender" | "senders" | "provider">;

/**
 * An OAuth provider's status: as {@link IntegrationStatus}, plus the
 * scopes the app's manifest lists, where the person connects in this app,
 * and their connection to this app. `configured` means the gateway holds
 * the client; `ready` that a call for this person would go through.
 */
export type OAuthClientIntegrationStatus = IntegrationStatus & {
  /** The provider's scopes as the app's `everyapp.config.ts` lists them. */
  scopes: readonly string[];
  /**
   * Where the person connects the provider in this app:
   * `/connect/<id>?app=<app>` on the Gateway ({@link connectUrl} builds
   * the absolute URL); null when the app can't connect (the manifest
   * doesn't list it, or the gateway holds no client).
   */
  connectPath: string | null;
  /**
   * The connection the call would use (the person's in this app, or the
   * member's `for: { background: true, userId }` names), or null when there
   * is none. `ready` false with `missingScopes` when it lacks a scope the
   * app now lists, and `reconnect` when the person has to connect again
   * (missing scopes, or it expired).
   */
  connection: {
    /** The account's name at the provider (an email address, a login). */
    label: string | null;
    /** The scopes it holds, canonical. */
    scopes: readonly string[];
    ready: boolean;
    missingScopes?: readonly string[];
    reconnect?: true;
  } | null;
};

/** The status of a capability: email's carries its senders, an OAuth provider's the connection. */
export type IntegrationStatusOf<P extends string> = P extends "email"
  ? EmailIntegrationStatus
  : P extends OAuthClientCapabilityId
    ? OAuthClientIntegrationStatus
    : IntegrationStatus;

/**
 * Whether the app can use an integration right now, without calling the
 * provider: show "an admin needs to set up DataForSEO" (or "sending isn't
 * set up", or "connect Google") up front instead of failing mid-task. An
 * OAuth provider's status carries the person's connection in this app and
 * where to connect.
 */
export async function integrationStatus<
  P extends CapabilityId | (string & {}),
>({
  env,
  provider,
  for: explicitTarget,
}: {
  env: object;
  provider: P;
  /**
   * Whom the status is for: the request being served (its person), so an
   * OAuth provider's `connection` is that person's in this app; `{
   * background: true, userId }` that member's. Explicitly the inbound
   * request or `{ background: true, organizationId, userId? }`, as on
   * every call.
   */
  for?: GatewayCallFor;
}): Promise<IntegrationStatusOf<P>> {
  const status = await readIntegrationStatus({
    env,
    provider,
    ...(explicitTarget === undefined ? {} : { for: explicitTarget }),
  });
  return withSetup(
    status,
    String(provider),
    env as Record<string, unknown>,
  ) as IntegrationStatusOf<P>;
}

/** A status before its setup fields are filled in. */
type Bare<S> = Omit<S, keyof SetupInfo>;

/**
 * `status` with its setup fields: the Gateway's as it sent them, or in
 * local development (no binding) the `.dev.vars` names a status that
 * isn't configured lacks.
 */
function withSetup<S extends Omit<IntegrationStatus, keyof SetupInfo>>(
  status: S & Partial<SetupInfo>,
  provider: string,
  values: Record<string, unknown>,
): S & SetupInfo {
  const binding = gatewayBinding(values);
  if (binding || !status.requested || status.configured) {
    return {
      ...status,
      settings: Array.isArray(status.settings) ? status.settings : [],
      setup: typeof status.setup === "string" ? status.setup : null,
      command: typeof status.command === "string" ? status.command : null,
    };
  }
  const integration =
    CATALOG.get(provider) ?? devRegisteredProvider(provider, values);
  const label = integration?.label ?? provider;
  if (integration?.mode === "oauth_client") {
    // In dev a token stands in for the connection; the client is the
    // deployed gateway's alone.
    const name = devAccessTokenName(provider);
    return {
      ...status,
      settings: [name],
      setup: `${label} isn't connected for local development: set ${name} in .dev.vars to a token you obtained yourself.`,
      command: null,
    };
  }
  const settings =
    provider === "email"
      ? ["EMAIL_FROM"]
      : integration
        ? [...capabilitySettings(integration)]
        : [];
  return {
    ...status,
    settings,
    setup: settings.length
      ? `${label} isn't set up for local development: set ${settings.join(" and ")} in .dev.vars.`
      : `${label} isn't set up for local development.`,
    command: null,
  };
}

async function readIntegrationStatus<P extends CapabilityId | (string & {})>({
  env,
  provider,
  for: explicitTarget,
}: {
  env: object;
  provider: P;
  for?: GatewayCallFor;
}): Promise<
  Omit<IntegrationStatusOf<P>, keyof SetupInfo> & Partial<SetupInfo>
> {
  const target = attributionFor(
    env,
    explicitTarget,
    `integrationStatus("${String(provider)}")`,
  );
  const values = env as Record<string, unknown>;
  const binding = gatewayBinding(env);
  // A provider registered on the gateway is the gateway's to answer for;
  // without one, the catalog, or in local dev the row's spec from
  // `.everyapp/providers/<id>.json`.
  const integration =
    binding && typeof binding.fetch === "function"
      ? CATALOG.get(String(provider))
      : (CATALOG.get(String(provider)) ??
        devRegisteredProvider(String(provider), values));
  if (integration?.mode === "ai") {
    throw new ConfigurationError(
      `${String(provider)} is an AI provider: it has no integration status (createGatewayFetch() answers ai_provider_not_configured when its key is unset).`,
    );
  }
  const unavailable = (): IntegrationStatusOf<P> =>
    (provider === "email"
      ? {
          requested: false,
          configured: false,
          ready: false,
          sender: null,
          senders: [],
          provider: null,
        }
      : integration?.mode === "oauth_client"
        ? {
            requested: false,
            configured: false,
            ready: false,
            scopes: [],
            connectPath: null,
            connection: null,
          }
        : {
            requested: false,
            configured: false,
            ready: false,
          }) as IntegrationStatusOf<P>;
  if (binding && typeof binding.fetch === "function") {
    const statusUrl = `${BINDING_ORIGIN}${INTEGRATION_PROXY_PREFIX}/${provider}`;
    let response: Response;
    if (target === undefined) {
      response = await binding.fetch(statusUrl);
    } else {
      // Whose status: the person's identity (their connection in this
      // app), the member background work names, or the organization's,
      // as a call would carry it.
      const headers = new Headers();
      applyAttribution(headers, target);
      response = await binding.fetch(statusUrl, { headers });
    }
    if (!response.ok) return unavailable();
    return (await response.json()) as IntegrationStatusOf<P>;
  }
  if (!integration) return unavailable();
  if (integration.mode === "service") {
    if (provider === "email") {
      return devEmailStatus(values) as IntegrationStatusOf<P>;
    }
    // Members: listMembers() answers from the dev identity, nothing to set.
    const dev = Boolean(values["EVERYAPP_DEV"]);
    return {
      requested: true,
      configured: dev,
      ready: dev,
    } as IntegrationStatusOf<P>;
  }
  if (integration.mode === "oauth_client") {
    return devOAuthStatus(String(provider), values) as IntegrationStatusOf<P>;
  }
  const configured = Boolean(
    values["EVERYAPP_DEV"] && authorizationFor(integration, values),
  );
  return {
    requested: true,
    configured,
    ready: configured,
  } as IntegrationStatusOf<P>;
}

/**
 * An OAuth provider in local dev, with no gateway, shaped as the
 * gateway's status is: the scopes from the manifest's entry
 * (EVERYAPP_DEV_CAPABILITIES), and a token in `.dev.vars` standing in for
 * a connection that holds them all. An app whose manifest doesn't list
 * the provider is told nothing.
 */
function devOAuthStatus(
  id: string,
  values: Record<string, unknown>,
): Bare<OAuthClientIntegrationStatus> {
  const entry = devManifestEntry(id, values);
  if (entry === null) {
    return {
      requested: false,
      configured: false,
      ready: false,
      scopes: [],
      connectPath: null,
      connection: null,
    };
  }
  const listed = entry?.["scopes"];
  const scopes = Array.isArray(listed)
    ? listed.filter((scope): scope is string => typeof scope === "string")
    : [];
  const token = Boolean(stringValue(values[devAccessTokenName(id)]));
  return {
    requested: true,
    configured: token,
    ready: token,
    scopes,
    connectPath: appConnectPath(id, values),
    connection: token ? { label: null, scopes, ready: true } : null,
  };
}

/**
 * Email in local dev, with no gateway: sends are printed unless `.dev.vars`
 * sets EMAIL_FROM (and the REST settings), and the senders are the ones
 * `.dev.vars` sets as EVERYAPP_EMAIL_SENDERS, standing in for the
 * installation's (`everyapp email set --sender`); unset, none. The
 * provider is the one the gateway would pick from the same settings:
 * `cloudflare` for the REST pair, `resend` for RESEND_API_KEY, EMAIL_PROVIDER
 * choosing when both are set.
 */
function devEmailStatus(
  values: Record<string, unknown>,
): Bare<EmailIntegrationStatus> {
  const dev = Boolean(values["EVERYAPP_DEV"]);
  const configured = dev && Boolean(stringValue(values["EMAIL_FROM"]));
  const choice = chooseEmailProvider(values["EMAIL_PROVIDER"], (provider) =>
    (
      provider === "cloudflare"
        ? stringValue(values["EMAIL_REST_API_TOKEN"]) &&
          stringValue(values["CLOUDFLARE_ACCOUNT_ID"])
        : stringValue(values["RESEND_API_KEY"])
    )
      ? "settings"
      : null,
  );
  return {
    requested: true,
    configured,
    ready: configured,
    sender: configured
      ? parseEmailSender(
          stringValue(values["EMAIL_FROM"]),
          stringValue(values["EMAIL_FROM_NAME"]),
        )
      : null,
    senders: dev ? parseEmailList(values[EMAIL_SENDERS_ENV]) : [],
    provider: configured && choice.ok ? choice.provider : null,
  };
}
