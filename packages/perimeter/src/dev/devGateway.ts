/**
 * Gateway-lite for `everyapp dev`.
 *
 * Runs the REAL perimeter locally: real public-route policy, real header
 * strip/inject, a real identity JWT signed by a local dev keypair, and a seeded
 * dev user. The only differences from prod are (1) the session is a seeded dev
 * user instead of a Better Auth cookie and (2) the keypair is generated locally.
 *
 * This module is dev-only and must never be imported by the production worker
 * entry, so the dev-identity machinery is excluded from prod bundles.
 *
 * Host is parsed dynamically (first label = app, remainder = base host) so the
 * same instance serves `todo.localhost:8787` and portless's per-worktree
 * `todo.fix-ui.everyapp.localhost` with no hardcoded base host.
 */
import { handleGatewayRequest, type GatewayDeps } from "../gateway";
import { InMemoryAppRegistry, type RegisteredApp } from "../registry";
import type { ParsedHost } from "../host";
import type { AuthenticatedSession, SessionAuthenticator } from "../session";
import { getAppFetcher, type AppFetcher } from "../getAppFetcher";
import {
  mintIdentityJwt,
  mintPublicMarkerJwt,
  IDENTITY_DEV_KEY_ID,
} from "@every-app/sdk/internal";

// Re-exported for the `everyapp dev` runner in the CLI, which consumes this
// module via the package export "@every-app/perimeter/dev".
export { parseHost } from "../host";
export type { ParsedHost } from "../host";
export type { RegisteredApp } from "../registry";
export type { AppFetcher } from "../getAppFetcher";
export type { SessionAuthenticator, AuthenticatedSession } from "../session";

/** Issuer for locally-minted dev identity tokens. */
export const DEV_ISSUER = "https://gateway.dev.localhost";

/** The seeded local dev user every request is authenticated as. */
export const DEV_USER: AuthenticatedSession = {
  sub: "dev-user",
  email: "dev@everyapp.localhost",
  orgId: "dev-org",
  orgRole: "owner",
};

export interface DevGatewayConfig {
  /** Registered apps, typically built from each app's manifest at dev start. */
  apps: RegisteredApp[];
  /** Local dev RS256 private key PEM (generated at dev start). */
  privateKeyPem: string;
  /** Worker env (carries the local service bindings). */
  env: Record<string, unknown>;
  /** Issuer for dev identity tokens. */
  issuer?: string;
  /**
   * Session source. Defaults to the seeded dev user (`stub` mode). In `mirror`
   * mode the CLI injects a RemoteAuthenticator that resolves a real Better Auth
   * session from a separately-running local gateway.
   */
  authenticator?: SessionAuthenticator;
  /** Seam override for tests; defaults to real service bindings. */
  fetcherFor?(env: Record<string, unknown>, app: RegisteredApp): AppFetcher;
}

/** Header/cookie that makes the stub authenticator treat a request as anonymous. */
export const DEV_ANON_HEADER = "x-everyapp-dev-anon";
const DEV_ANON_COOKIE = /(?:^|;\s*)everyapp_dev_anon=1(?:;|$)/;

/**
 * A dev authenticator that resolves to the seeded dev user. Requests carrying
 * `x-everyapp-dev-anon: 1` (curl) or the cookie `everyapp_dev_anon=1`
 * (browser) are treated as anonymous — public routes are auth-OPTIONAL, so
 * without this escape the always-present dev session would mask the
 * anonymous public-route behavior entirely.
 */
export function devAuthenticator(): SessionAuthenticator {
  return {
    authenticate: async (request) => {
      if (request.headers.get(DEV_ANON_HEADER) === "1") return null;
      if (DEV_ANON_COOKIE.test(request.headers.get("cookie") ?? ""))
        return null;
      return DEV_USER;
    },
    hasAppAccess: async () => true,
  };
}

/**
 * Build a `fetch` handler for the dev gateway. Resolves the app from the first
 * Host label so each worktree's base host Just Works.
 */
export function createDevGatewayHandler(config: DevGatewayConfig) {
  const registry = new InMemoryAppRegistry(config.apps);

  const deps: GatewayDeps = {
    env: config.env,
    registry,
    authenticator: config.authenticator ?? devAuthenticator(),
    privateKeyPem: config.privateKeyPem,
    issuer: config.issuer ?? "https://gateway.dev.localhost",
    // Dev tokens are minted under a distinct kid the SDK only trusts when
    // EVERYAPP_DEV is set — never in production.
    keyId: IDENTITY_DEV_KEY_ID,
    // Dev resolves by first label so the base host is never hardcoded.
    resolveApp: async (host: ParsedHost, reg) =>
      host.appLabel ? reg.findByAppId(host.appLabel) : null,
    fetcherFor: config.fetcherFor ?? getAppFetcher,
  };

  return (request: Request): Promise<Response> =>
    handleGatewayRequest(request, deps);
}

/**
 * Mint a dev-kid identity JWT for a WebSocket upgrade. Upgrades are raw-piped
 * at the socket level and never pass through `handleGatewayRequest` (Node
 * cannot represent a 101 Response), so the perimeter contract (verified
 * identity header, stripped inbound trust headers) is applied at the upgrade
 * hop instead. Defaults to the seeded dev user (stub mode); mirror mode passes
 * the real resolved session.
 */
export async function mintDevIdentityJwt(
  privateKeyPem: string,
  appId: string,
  issuer: string = DEV_ISSUER,
  subject: AuthenticatedSession = DEV_USER,
): Promise<string> {
  return mintIdentityJwt(privateKeyPem, {
    subject,
    audience: appId,
    issuer,
    channel: "web",
    keyId: IDENTITY_DEV_KEY_ID,
  });
}

/** Mint the same signed public marker used by the HTTP dev gateway. */
export async function mintDevPublicMarkerJwt(
  privateKeyPem: string,
  appId: string,
  issuer: string = DEV_ISSUER,
): Promise<string> {
  return mintPublicMarkerJwt(privateKeyPem, {
    audience: appId,
    issuer,
    keyId: IDENTITY_DEV_KEY_ID,
  });
}
