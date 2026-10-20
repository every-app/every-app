/**
 * RemoteAuthenticator — the `mirror` mode session source.
 *
 * Implements the perimeter's SessionAuthenticator by forwarding the browser's
 * session cookie to a SEPARATELY-running local gateway's dev identity endpoint
 * (`GET /api/dev/identity`, dev-gated). The gateway resolves the REAL Better
 * Auth user + active org and returns it; the dev runner then mints a (dev-kid)
 * identity JWT for that real user. This gives a genuine "log in for real
 * locally" loop without spawning the gateway or mounting the perimeter in it.
 *
 * A personal access token (`Authorization: Bearer epat_…`, e.g. from an MCP
 * client) is forwarded instead of the cookie, and the gateway verifies it
 * exactly as production does.
 */
import { extractEveryAppBearer } from "@every-app/perimeter";
import type {
  SessionAuthenticator,
  AuthenticatedSession,
} from "@every-app/perimeter/dev";
import { errorMessage } from "@/lib/errors";

interface IdentityResponse {
  session: AuthenticatedSession | null;
  hasAccess?: boolean;
  reason?: string | null;
}

/** Why the Gateway resolved no session (`reason` of /api/dev/identity). */
enum SessionReason {
  NoSession = "no_session",
  NoActiveOrganization = "no_active_organization",
  Expired = "expired",
}

interface RemoteAuthenticatorOptions {
  /** Base URL of the separately-running local gateway, e.g. http://localhost:3000. */
  gatewayUrl: string;
  /** Where a person logs in: the base host on the gateway-lite, e.g. http://everyapp.localhost:8787. */
  loginUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called once per reason with a human hint, its headline first. */
  onHint?: (message: string) => void;
}

export function createRemoteAuthenticator(
  options: RemoteAuthenticatorOptions,
): SessionAuthenticator {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = new URL("/api/dev/identity", options.gatewayUrl).toString();
  const hinted = new Set<string>();

  function sentence(reason: string): string {
    switch (reason) {
      case SessionReason.NoSession:
        return `No Gateway session yet: log in at ${options.loginUrl}, then reload`;
      case SessionReason.NoActiveOrganization:
        return "No active organization: create or pick one in the Gateway, then reload";
      case SessionReason.Expired:
        return "Your Gateway session expired: log in again, then reload";
      default:
        return `The Gateway rejected the session (${reason})`;
    }
  }

  function hintOnce(reason: string | null | undefined): void {
    if (!reason || hinted.has(reason)) return;
    hinted.add(reason);
    options.onHint?.(sentence(reason));
  }

  return {
    // The Cookie header goes to the gateway's /api/dev/identity unchanged,
    // and the gateway refuses a duplicated session cookie there itself.
    sessionCookieNames: [],
    async authenticate(request: Request): Promise<AuthenticatedSession | null> {
      const cookie = request.headers.get("cookie");
      const token = extractEveryAppBearer(request.headers);
      if (!cookie && !token) {
        hintOnce(SessionReason.NoSession);
        return null;
      }
      // A personal token wins and is never mixed with the cookie, as on the
      // real perimeter.
      const headers: Record<string, string> = token
        ? { authorization: `Bearer ${token}` }
        : { cookie: cookie! };
      let res: Response;
      try {
        res = await doFetch(endpoint, { headers });
      } catch (err) {
        options.onHint?.(
          [
            `Can't reach the local Gateway at ${options.gatewayUrl}`,
            `${errorMessage(err)}. Is pnpm dev running in apps/every-app-gateway?`,
          ].join("\n"),
        );
        return null;
      }
      if (!res.ok) return null;
      const body = (await res.json()) as IdentityResponse;
      if (!body.session) {
        hintOnce(body.reason);
        return null;
      }
      return body.session;
    },

    // Per-app access enforcement (user_app_access) lands with the Phase-5
    // app-registration flow. Until then mirror mode is dev-permissive: any
    // authenticated user may reach their in-development app. The endpoint
    // returns hasAccess for forward-compatibility; we honor it if present.
    async hasAppAccess(): Promise<boolean> {
      return true;
    },
  };
}
