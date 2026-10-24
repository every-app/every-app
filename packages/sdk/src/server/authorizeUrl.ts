import {
  CAPABILITIES,
  ConfigurationError,
  type Capability,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
} from "../internal/index.js";
import type { OAuthClientIntegrationStatus } from "./integrationFetch.js";

export interface AuthorizeUrlOptions {
  /** The OAuth client, as listed in the manifest's `capabilities`. */
  provider: OAuthClientCapabilityId;
  /** What `integrationStatus()` answered for it, ready and with its `clientId`. */
  status: OAuthClientIntegrationStatus;
  /** One of the redirect URIs the operator registered on the client. */
  redirectUri: string;
  /** The app's own anti-forgery value, checked when the person comes back. */
  state: string;
  /** PKCE: the S256 challenge of the verifier the app keeps for the exchange. */
  codeChallenge?: string;
  /**
   * The provider's extras (`prompt`, `login_hint`, Google's `hd`). Never
   * one of the parameters this helper sets (PKCE's and the provider's own
   * included), nor Google's `include_granted_scopes`.
   */
  params?: Record<string, string>;
}

/**
 * Parameters the helper owns: the status decides the scopes, the caller's
 * other arguments decide the rest (PKCE from `codeChallenge`, always as
 * S256), each provider's own are fixed (Google's `access_type=offline` is
 * what gets a refresh token, Microsoft's `response_mode=query` is what
 * the callback reads), and Google's `include_granted_scopes` would widen
 * the token to every scope the person ever granted this client, which the
 * gateway refuses (`integration_scope_exceeded`).
 */
const RESERVED_PARAMS = [
  "scope",
  "user_scope",
  "client_id",
  "redirect_uri",
  "state",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "access_type",
  "response_mode",
  "include_granted_scopes",
];

/** The OAuth clients with scope sets: the ones this helper builds for. */
function scopedClientIds(): string[] {
  return (Object.entries(CAPABILITIES) as [string, Capability][])
    .filter(([, found]) => found.mode === "oauth_client" && found.scopePolicy)
    .map(([id]) => id);
}

/**
 * The provider's authorize URL to send a person to, for a client with
 * scope sets (`google-workspace`, `microsoft-365`, `slack`), built from the
 * capability's status: the registry's authorize endpoint (or the instance
 * the status names), `client_id`, `response_type=code`, `redirect_uri`,
 * `state`, and the scopes the status allows this app, which are exactly
 * what the gateway will let the token carry. Each provider's own needs
 * are added: Google's `access_type=offline` (a refresh token), Microsoft's
 * `response_mode=query`, Slack's comma-joined `scope` and its `user_scope`
 * (the status's `userScopes`, when the app's sets include a user set). With
 * `codeChallenge`, PKCE as S256. The app keeps its `state` and verifier
 * for the callback.
 *
 * A client without scope sets (LinkedIn, Mastodon, ...) is refused: the
 * registry's checklist for one isn't what the gateway holds a token to,
 * so an app builds that URL itself from the status's `clientId`.
 *
 * Throws a `TypeError` naming the fix when the client has no scope sets,
 * when the status isn't ready or has no `clientId`, when the status lacks
 * `scopes`, or when `params` names a parameter the helper sets.
 */
export function authorizeUrl({
  provider,
  status,
  redirectUri,
  state,
  codeChallenge,
  params,
}: AuthorizeUrlOptions): URL {
  const capability = oauthClientCapability(provider);
  if (!capability.scopePolicy) {
    throw new TypeError(
      `authorizeUrl() builds URLs for clients with scope sets (${scopedClientIds().join(", ")}); build ${capability.label}'s authorize URL yourself from the status's clientId.`,
    );
  }
  if (!status.ready || !status.clientId) {
    throw new TypeError(
      `authorizeUrl(${JSON.stringify(provider)}) needs a ready status with a clientId, and integrationStatus() answered ready: ${String(status.ready)}. Show ${capability.label} as not available instead: its operator sets the client up on the gateway, and an app lists the scope sets it uses in everyapp.config.ts.`,
    );
  }
  if (!status.scopes) {
    throw new TypeError(
      `authorizeUrl(${JSON.stringify(provider)}) takes ${capability.label}'s scopes from integrationStatus().scopes, which this status lacks: pass the status as the gateway (or everyapp dev) answered it.`,
    );
  }
  for (const name of Object.keys(params ?? {})) {
    if (!RESERVED_PARAMS.includes(name)) continue;
    throw new TypeError(
      name === "include_granted_scopes"
        ? `authorizeUrl(${JSON.stringify(provider)}): include_granted_scopes would widen the token to every scope the person granted this client, which the gateway refuses (integration_scope_exceeded); leave it out of params.`
        : `authorizeUrl(${JSON.stringify(provider)}) sets ${name} itself; leave it out of params.`,
    );
  }

  const base = status.origin ?? capability.defaultOrigin;
  if (!/^https:/.test(capability.authorize.url) && !base) {
    throw new TypeError(
      `authorizeUrl(${JSON.stringify(provider)}) needs the instance ${capability.label} is on: the status carries it as origin once ${capability.hostSetting} is set.`,
    );
  }
  const url = new URL(capability.authorize.url, base);
  // The status speaks for the gateway: its scopes are the token's ceiling.
  const scopes = status.scopes;
  const slack = url.host === "slack.com";

  url.searchParams.set("client_id", status.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scopes.join(slack ? "," : " "));
  if (status.userScopes && status.userScopes.length > 0) {
    url.searchParams.set("user_scope", status.userScopes.join(","));
  }
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (url.host === "accounts.google.com") {
    // Without it Google issues no refresh token.
    url.searchParams.set("access_type", "offline");
  } else if (url.host === "login.microsoftonline.com") {
    url.searchParams.set("response_mode", "query");
  }
  for (const [name, value] of Object.entries(params ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

/** The OAuth client `provider` names, from plain JavaScript or a stale type too. */
function oauthClientCapability(
  provider: OAuthClientCapabilityId,
): OAuthClientCapability {
  const found = Object.hasOwn(CAPABILITIES, provider)
    ? CAPABILITIES[provider]
    : undefined;
  if (found?.mode !== "oauth_client") {
    throw new ConfigurationError(
      `${JSON.stringify(String(provider))} isn't an OAuth client the gateway holds.`,
    );
  }
  return found;
}
