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
  credential?: {
    kind: "session" | "pat" | "oauth";
    channel: "web" | "api";
    actor?: string;
    scopes?: string[];
  };
}

/**
 * Whether a credential is for MCP only: every one of its scopes is an `mcp:`
 * scope (a personal token created with `["mcp:read"]`, say). Such a
 * credential reaches an app's `/mcp` and nothing else, so a read-only token
 * stays read-only even though apps don't check scopes on their own routes.
 * Browser sessions carry no credential, and a token created without scopes
 * holds `*`, full access.
 */
export function isMcpOnlyCredential(
  credential: AuthenticatedSession["credential"],
): boolean {
  const scopes = credential?.scopes ?? [];
  return scopes.length > 0 && scopes.every((scope) => scope.startsWith("mcp:"));
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
  /** Whether the user may access this app (org membership + app installed). */
  hasAppAccess(
    session: AuthenticatedSession,
    app: RegisteredApp,
  ): Promise<boolean>;
}
