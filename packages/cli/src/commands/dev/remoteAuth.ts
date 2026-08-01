/**
 * RemoteAuthenticator — the `mirror` mode session source.
 *
 * Implements the perimeter's SessionAuthenticator by forwarding the browser's
 * session cookie to a SEPARATELY-running local gateway's dev identity endpoint
 * (`GET /api/dev/identity`, dev-gated). The gateway resolves the REAL Better
 * Auth user + active org and returns it; the dev runner then mints a (dev-kid)
 * identity JWT for that real user. This gives a genuine "log in for real
 * locally" loop without spawning the gateway or mounting the perimeter in it.
 */
import type {
  SessionAuthenticator,
  AuthenticatedSession,
} from "@every-app/perimeter/dev";

interface IdentityResponse {
  session: {
    sub: string;
    email: string;
    orgId: string;
    orgRole: string;
  } | null;
  hasAccess?: boolean;
  reason?: string | null;
}

interface RemoteAuthenticatorOptions {
  /** Base URL of the separately-running local gateway, e.g. http://localhost:3000. */
  gatewayUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called once with a human hint when a fixable reason is returned. */
  onHint?: (message: string) => void;
}

export function createRemoteAuthenticator(
  options: RemoteAuthenticatorOptions,
): SessionAuthenticator {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = new URL("/api/dev/identity", options.gatewayUrl).toString();
  const hinted = new Set<string>();

  function hintOnce(reason: string | null | undefined): void {
    if (!reason || hinted.has(reason)) return;
    hinted.add(reason);
    const message =
      reason === "no_active_organization"
        ? "mirror: you're logged in but have no active organization — create/select one in the gateway, then reload."
        : reason === "no_session"
          ? "mirror: no gateway session yet — log in at the base host, then reload the app."
          : `mirror: gateway returned reason="${reason}".`;
    options.onHint?.(message);
  }

  return {
    async authenticate(request: Request): Promise<AuthenticatedSession | null> {
      const cookie = request.headers.get("cookie");
      if (!cookie) {
        hintOnce("no_session");
        return null;
      }
      let res: Response;
      try {
        res = await doFetch(endpoint, { headers: { cookie } });
      } catch (err) {
        options.onHint?.(
          `mirror: could not reach the gateway at ${options.gatewayUrl} (${String(
            err,
          )}). Is it running (\`pnpm dev\` in apps/every-app-gateway)?`,
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
