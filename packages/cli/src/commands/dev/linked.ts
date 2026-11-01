/**
 * Linked mode's two pieces in the gateway-lite (docs/design/linked-dev.md
 * §4.2, §4.3):
 *
 *  - the authenticator: everyone who reaches the loopback port is the
 *    person whose token this is, as stub mode makes everyone the seeded
 *    user, except that the identity is the real member the Gateway's
 *    `whoami` answers, re-read every minute, so a revoked token or a lost
 *    role or app access stops the local app within a minute;
 *  - the forwarder at `/__everyapp/gateway/*` under the app's host: the
 *    SDK's shim sends the service binding's requests here with the run's
 *    nonce; this strips the identity and organization headers (a dev
 *    identity JWT must never reach a production Gateway), adds the bearer
 *    and forwards to `${gateway}/linked-dev/<app>/…`, streaming both ways.
 *    Browser requests are refused (as the cron trigger refuses them): the
 *    custom header already keeps a simple cross-origin request out.
 */
import { randomBytes } from "node:crypto";
import type { AuthenticatedSession, SessionAuthenticator } from "@every-app/perimeter/dev";
import { IDENTITY_HEADER, LINKED_DEV_FORWARD_PATH, LINKED_DEV_HEADER, ORG_HEADER } from "@every-app/sdk/internal";
import { errorMessage, EveryAppError } from "@/lib/errors";
import type { LinkedSession, LinkedWhoami } from "@/lib/linkedDev";
import type { EventSink } from "@/lib/output/events";
import { isBrowserRequest } from "./mode";

/** How long a `whoami` answer stands before it is re-read. */
const WHOAMI_TTL_MS = 60_000;

/** A new nonce per run; the dev Worker gets it through its env, nothing else does. */
export function newLinkedDevNonce(): string {
  return randomBytes(24).toString("base64url");
}

interface LinkedIdentity {
  /** The current member, or null once the Gateway refuses the token. */
  current(): Promise<LinkedWhoami | null>;
  authenticator: SessionAuthenticator;
}

/**
 * The gateway-lite's session source in linked mode. The first `whoami`
 * is awaited by the caller before the app starts (a refused token stops
 * the run with its reason); later ones run every minute, and a refusal
 * answers no session, never the stale one.
 */
export function createLinkedIdentity(
  session: LinkedSession,
  options: { out: EventSink; now?: () => number },
): LinkedIdentity {
  const now = options.now ?? Date.now;
  // The last answer, a refusal included: a refused token is asked about
  // again after a minute, not on every request.
  let known: { who: LinkedWhoami | null; at: number } | null = null;
  let refused: string | null = null;
  let pending: Promise<LinkedWhoami | null> | null = null;

  async function read(): Promise<LinkedWhoami | null> {
    try {
      const who = await session.whoami();
      known = { who, at: now() };
      refused = null;
      return who;
    } catch (error) {
      const message = errorMessage(error);
      if (refused !== message) {
        refused = message;
        options.out.emit({
          type: "warning",
          code: "LINKED_DEV_REFUSED",
          message,
          data: error instanceof EveryAppError ? (error.data ?? {}) : {},
        });
      }
      known = { who: null, at: now() };
      return null;
    }
  }

  const current = (): Promise<LinkedWhoami | null> => {
    if (known && now() - known.at < WHOAMI_TTL_MS) return Promise.resolve(known.who);
    pending ??= read().finally(() => {
      pending = null;
    });
    return pending;
  };

  const sessionOf = (who: LinkedWhoami): AuthenticatedSession => ({
    sub: who.user.id,
    email: who.user.email,
    orgId: who.organization.id,
    orgRole: who.role,
    orgName: who.organization.name,
  });

  return {
    current,
    authenticator: {
      sessionCookieNames: [],
      async authenticate() {
        const who = await current();
        return who ? sessionOf(who) : null;
      },
      // Real access: the Gateway's consent, whoami and every forwarded
      // call check that the member can still open the app.
      async hasAppAccess() {
        const who = await current();
        return Boolean(who?.hasAccess);
      },
    },
  };
}

/** Hop-by-hop and connection headers never forwarded. */
const DROPPED = new Set([
  IDENTITY_HEADER,
  ORG_HEADER,
  LINKED_DEV_HEADER,
  "authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
]);

export interface LinkedForwarder {
  /** Whether `pathname` is the forwarder's (`/__everyapp/gateway/…`). */
  matches(pathname: string): boolean;
  handle(request: Request): Promise<Response>;
}

/** The forwarder for one run: its nonce, and the session whose token it adds. */
export function createLinkedForwarder(
  session: LinkedSession,
  nonce: string,
  options: { fetchImpl?: typeof fetch } = {},
): LinkedForwarder {
  const fetchImpl = options.fetchImpl ?? fetch;
  const prefix = `${LINKED_DEV_FORWARD_PATH}/`;
  return {
    matches: (pathname) => pathname === LINKED_DEV_FORWARD_PATH || pathname.startsWith(prefix),
    async handle(request) {
      const url = new URL(request.url);
      const headers = request.headers;
      if (
        isBrowserRequest({
          origin: headers.get("origin") ?? undefined,
          referer: headers.get("referer") ?? undefined,
          "sec-fetch-mode": headers.get("sec-fetch-mode") ?? undefined,
          "sec-fetch-site": headers.get("sec-fetch-site") ?? undefined,
        })
      ) {
        return Response.json(
          { error: "forbidden", message: "The linked dev forwarder takes the app's own calls, not a web page's." },
          { status: 403 },
        );
      }
      if (headers.get(LINKED_DEV_HEADER) !== nonce) {
        return Response.json(
          { error: "forbidden", message: "Not this run's app: the linked dev nonce is missing or stale." },
          { status: 403 },
        );
      }
      const rest = url.pathname.slice(LINKED_DEV_FORWARD_PATH.length) || "/";
      const target = `${session.routeUrl}${rest}${url.search}`;
      const forwarded = new Headers();
      headers.forEach((value, name) => {
        if (!DROPPED.has(name.toLowerCase())) forwarded.set(name, value);
      });
      // Read once, so the one retry below can send the same body (the
      // SDK's bodies are small JSON; a provider's streamed answer comes
      // back streamed regardless).
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const send = async (): Promise<Response> => {
        forwarded.set("authorization", `Bearer ${await session.token()}`);
        return fetchImpl(target, {
          method: request.method,
          headers: forwarded,
          ...(body && body.byteLength > 0 ? { body } : {}),
          // A 3xx the Gateway passes through from a provider is the app's
          // to see, as the service binding would hand it over; the laptop
          // never follows a provider's Location itself.
          redirect: "manual",
        });
      };
      try {
        const response = await send();
        // Only the route's own challenge (its realm) means the token: a
        // provider's 401 passed through by the AI proxy is the app's to see.
        if (response.status !== 401 || !isLinkedDevChallenge(response)) return strip(response);
        // Once: a token that just expired, or was refreshed on another
        // run. A second 401 is the Gateway's answer, which the app sees;
        // so is the first when no new token can be had (the grant revoked:
        // the minute's re-read then says why in the terminal).
        session.invalidate();
        let retried: Response;
        try {
          retried = await send();
        } catch (error) {
          if (error instanceof EveryAppError) return strip(response);
          throw error;
        }
        return strip(retried);
      } catch (error) {
        return Response.json(
          {
            error: "gateway_unreachable",
            message: `Can't reach ${session.gateway}: ${errorMessage(error)}`,
          },
          { status: 502 },
        );
      }
    },
  };
}

/** The realm the Gateway's linked dev route puts on its own 401s (server/linked-dev.ts). */
const LINKED_DEV_REALM = 'realm="every-app-linked-dev"';

function isLinkedDevChallenge(response: Response): boolean {
  return (response.headers.get("www-authenticate") ?? "").includes(LINKED_DEV_REALM);
}

/** The Gateway's answer as the binding would give it: without hop-by-hop headers. */
function strip(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of ["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]) {
    headers.delete(name);
  }
  return new Response(response.body, { status: response.status, headers });
}
