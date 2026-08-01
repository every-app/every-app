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

export interface SessionAuthenticator {
  /** Resolve the session from the request cookie, or null if unauthenticated. */
  authenticate(request: Request): Promise<AuthenticatedSession | null>;
  /** Whether the user may access this app (org membership + app installed). */
  hasAppAccess(
    session: AuthenticatedSession,
    app: RegisteredApp,
  ): Promise<boolean>;
}
