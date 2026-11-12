// "Sign in with Every App", start to finish, minus the browser and the listener (port of
// HelperCore/SignInFlow.swift):
// 1. GET {app}/.well-known/oauth-protected-resource: `resource` must be the app's origin;
//    `authorization_servers[0]` is the Gateway.
// 2. GET {gateway}/.well-known/oauth-authorization-server: `issuer` must be the Gateway.
// 3. The client id registered with that Gateway, from the cache, or registered now and cached.
// 4. The browser (via `authorize`) with PKCE, `state` and `resource`; the code comes back.
// 5. The token exchange, with `resource`.
// A cached client the Gateway no longer knows (`invalid_client`) is forgotten and the sign-in
// runs once more with a fresh registration.

import { CLIENT_NAME, OAuthClient, OAuthError, type AuthorizationServerMetadata, type OAuthGrant } from "./oauth";
import { createPkce, randomToken } from "./pkce";
import type { CallbackExpectation } from "./redirect";
import { AuthError } from "./errors";
import { normalized, originOf } from "./url";

/** Where a cached client id lives, with when it was last used for a sign-in or refresh and the
 * name it was registered under (the consent page shows that name). */
export interface ClientIdCache {
  entry(issuer: string): { clientId: string; lastUsed: number; name?: string } | undefined;
  save(clientId: string, issuer: string, lastUsed: number, name?: string): void;
  forget(issuer: string): void;
}

export function touchClient(cache: ClientIdCache, issuer: string, now = Date.now()): void {
  const entry = cache.entry(issuer);
  if (entry) cache.save(entry.clientId, issuer, now, entry.name);
}

/** The Gateway drops a client unused for 60 days, and its authorize page then shows an error
 * instead of redirecting, so `invalid_client` never reaches us. Register again before that. */
export const CLIENT_MAX_IDLE_MS = 50 * 24 * 3600 * 1000;

export type Authorize = (authorizationUrl: string, expectation: CallbackExpectation) => Promise<string>;

export class SignInFlow {
  constructor(
    private readonly cache: ClientIdCache,
    private readonly client: OAuthClient = new OAuthClient(),
    private readonly now: () => number = Date.now,
  ) {}

  /** `redirectUri` is the listener's `http://127.0.0.1:<port>/callback`. `authorize` opens the
   * authorization URL and returns the code from a callback that meets the expectation; it throws
   * `OAuthError("invalidClient")` if the Gateway answers that. */
  async run(appUrl: string, redirectUri: string, authorize: Authorize): Promise<OAuthGrant> {
    const origin = originOf(appUrl);
    if (!origin) throw new AuthError("message", "That app URL isn't valid.");
    const resource = normalized(origin);
    const protectedResource = await this.client.discoverResource(origin);
    const issuer = protectedResource.authorizationServers[0]!;
    const metadata = await this.client.discover(issuer);

    let retried = false;
    for (;;) {
      const { clientId, fresh } = await this.clientId(metadata);
      try {
        const pkce = createPkce();
        const expectation: CallbackExpectation = {
          state: randomToken(),
          issuer: metadata.issuer,
          issRequired: metadata.authorizationResponseIssParameterSupported === true,
        };
        const url = OAuthClient.authorizationUrl({ metadata, clientId, redirectUri, pkce, state: expectation.state, resource });
        const code = await authorize(url, expectation);
        const grant = await this.client.exchange({ code, metadata, clientId, redirectUri, pkce, resource, appUrl: origin });
        touchClient(this.cache, metadata.issuer, this.now());
        return grant;
      } catch (error) {
        if (error instanceof OAuthError && error.kind === "invalidClient" && !fresh && !retried) {
          this.cache.forget(metadata.issuer);
          retried = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async clientId(metadata: AuthorizationServerMetadata): Promise<{ clientId: string; fresh: boolean }> {
    const now = this.now();
    const cached = this.cache.entry(metadata.issuer);
    // A client registered under an earlier name registers again, so the consent page shows this one.
    if (cached && cached.name === CLIENT_NAME && now - cached.lastUsed < CLIENT_MAX_IDLE_MS) return { clientId: cached.clientId, fresh: false };
    if (!metadata.registrationEndpoint) {
      throw new OAuthError("registrationFailed", "It doesn't offer dynamic client registration.");
    }
    const id = await this.client.register(metadata.registrationEndpoint);
    this.cache.save(id, metadata.issuer, now, CLIENT_NAME);
    return { clientId: id, fresh: true };
  }
}
