/**
 * Session authentication interface for the perimeter.
 *
 * The gateway terminates the Better Auth session cookie. The proxy core depends
 * only on this small interface so it can be unit-tested with a stub and run for
 * real against Better Auth + the access repository in production. The dev
 * gateway provides a seeded-user implementation.
 */
import type { RegisteredApp } from "./registry";

export interface AuthenticatedSession {
  sub: string;
  email: string;
  orgId: string;
  orgRole: string;
  /**
   * The organization's display name, when the authenticator read it (the
   * production ones join it with the membership). Minted as `org_name`.
   */
  orgName?: string;
  credential?: {
    kind: "session" | "pat" | "oauth";
    channel: "web" | "api";
    actor?: string;
    scopes?: string[];
  };
}

/**
 * The one scope rule for app routes: a credential opens an app's own
 * routes only with full member scope, `*` (a browser session carries no
 * credential and counts as full; a personal token created without scopes
 * holds `*`). Any narrower token (`mcp:read`, an app-domain scope the
 * person typed) opens nothing there, so apps never check scopes on their
 * own routes: every identity they receive on one acts as the member in
 * full.
 */
export function hasFullAppScope(
  credential: AuthenticatedSession["credential"],
): boolean {
  if (!credential) return true;
  return (credential.scopes ?? []).includes("*");
}

/**
 * What may reach a host's `/mcp` where MCP is served: full scope, or at
 * least one `mcp:` scope (the ToolBus then decides read or write from the
 * exact scopes, and `*` alone counts there). A token with only app-domain
 * scopes opens no MCP either.
 */
export function mayUseMcp(
  credential: AuthenticatedSession["credential"],
): boolean {
  if (hasFullAppScope(credential)) return true;
  return (credential?.scopes ?? []).some((scope) => scope.startsWith("mcp:"));
}

export interface SessionAuthenticator {
  /**
   * The names of the cookie `authenticate` reads the session from (every
   * variant, such as with and without `__Secure-`). The gateway refuses a
   * request carrying it more than once before authenticating (cookies.ts).
   * Required so an authenticator can't skip that refusal by omission; one
   * that reads no cookie passes `[]`.
   */
  sessionCookieNames: readonly string[];
  /** Resolve the session from the request cookie, or null if unauthenticated. */
  authenticate(request: Request): Promise<AuthenticatedSession | null>;
  /**
   * Whether the user may access this app (org membership + app installed).
   * A session instead of `true` lets them in acting as that session: the
   * same person in the organization the app belongs to, when the session
   * acts under another of their organizations. The identity JWT carries its
   * organization and role.
   */
  hasAppAccess(
    session: AuthenticatedSession,
    app: RegisteredApp,
  ): Promise<boolean | AuthenticatedSession>;
}
