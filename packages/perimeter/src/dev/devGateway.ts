/**
 * Gateway-lite for `everyapp dev`.
 *
 * Runs the REAL perimeter locally: real public-route policy, real header
 * strip/inject, a real identity JWT, and a seeded dev user. The only
 * differences from prod are (1) the session is a seeded dev user instead of a
 * Better Auth cookie and (2) tokens are signed with the SDK's well-known dev
 * keypair (`@every-app/sdk/dev`) under the dev kid and the dev issuer, which
 * apps trust only in a development build.
 *
 * This module is dev-only and must never be imported by the production worker
 * entry, so the dev-identity machinery is excluded from prod bundles.
 *
 * Host is parsed dynamically (first label = app, remainder = base host) so the
 * same instance serves `todo.localhost:8787` and portless's per-worktree
 * `todo.fix-ui.everyapp.localhost` with no hardcoded base host.
 */
import {
  handleGatewayRequest,
  type GatewayDeps,
  type McpInterceptInput,
} from "../gateway";
import { InMemoryAppRegistry, type RegisteredApp } from "../registry";
import type { ParsedHost } from "../host";
import type { AuthenticatedSession, SessionAuthenticator } from "../session";
import { getAppFetcher, type AppFetcher } from "../getAppFetcher";
import {
  mintIdentityJwt,
  mintPublicMarkerJwt,
  IDENTITY_DEV_KEY_ID,
} from "@every-app/sdk/internal";
import { DEV_ISSUER, DEV_PRIVATE_KEY_PEM } from "@every-app/sdk/dev";

// Re-exported for the `everyapp dev` runner in the CLI, which consumes this
// module via the package export "@every-app/perimeter/dev".
export { parseHost } from "../host";
export type { ParsedHost } from "../host";
export type { RegisteredApp } from "../registry";
export type { AppFetcher } from "../getAppFetcher";
export type { SessionAuthenticator, AuthenticatedSession } from "../session";
export type { McpInterceptInput } from "../gateway";

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
  /** Worker env (carries the local service bindings). */
  env: Record<string, unknown>;
  /**
   * Session source. Defaults to the seeded dev user (`stub` mode). In `mirror`
   * mode the CLI injects a RemoteAuthenticator that resolves a real Better Auth
   * session from a separately-running local gateway.
   */
  authenticator?: SessionAuthenticator;
  /** Seam override for tests; defaults to real service bindings. */
  fetcherFor?(env: Record<string, unknown>, app: RegisteredApp): AppFetcher;
  /** Serve `<app>.localhost/mcp` from a local ToolBus (see GatewayDeps). */
  interceptMcp?(input: McpInterceptInput): Promise<Response | null>;
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
    // No session cookie to toss: every request is the seeded user.
    sessionCookieNames: [],
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
  // `everyapp dev` serves `<app>.localhost/mcp` from the local ToolBus
  // whatever the manifest says: dev is local only, and that URL is how an
  // app's tools are tried before it is deployed. An app that runs its own
  // MCP server (`by: "app"`) keeps it here too.
  const registry = new InMemoryAppRegistry(
    config.apps.map((app) =>
      app.manifest.mcp
        ? app
        : {
            ...app,
            manifest: {
              ...app.manifest,
              mcp: { by: "gateway", why: "everyapp dev serves it locally." },
            },
          },
    ),
  );

  const deps: GatewayDeps = {
    env: config.env,
    registry,
    authenticator: config.authenticator ?? devAuthenticator(),
    privateKeyPem: DEV_PRIVATE_KEY_PEM,
    issuer: DEV_ISSUER,
    // Dev tokens are minted under a distinct kid the SDK only trusts when
    // EVERYAPP_DEV is set and the issuer is the dev one — never in production.
    keyId: IDENTITY_DEV_KEY_ID,
    // Dev resolves by first label so the base host is never hardcoded.
    resolveApp: async (host: ParsedHost, reg) =>
      host.appLabel ? reg.findByAppId(host.appLabel) : null,
    fetcherFor: config.fetcherFor ?? getAppFetcher,
    // A dev Worker has no EVERYAPP_AUDIENCE; under EVERYAPP_DEV the SDK
    // expects the app id instead.
    audienceFor: (app) => app.appId,
    interceptMcp: config.interceptMcp,
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
  appId: string,
  subject: AuthenticatedSession = DEV_USER,
): Promise<string> {
  return mintIdentityJwt(DEV_PRIVATE_KEY_PEM, {
    subject,
    audience: appId,
    issuer: DEV_ISSUER,
    channel: "web",
    keyId: IDENTITY_DEV_KEY_ID,
  });
}

/** Mint the same signed public marker used by the HTTP dev gateway. */
export async function mintDevPublicMarkerJwt(appId: string): Promise<string> {
  return mintPublicMarkerJwt(DEV_PRIVATE_KEY_PEM, {
    audience: appId,
    issuer: DEV_ISSUER,
    keyId: IDENTITY_DEV_KEY_ID,
  });
}
