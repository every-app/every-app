/**
 * The handoff that gives a third-party app host its own session
 * (@every-app/perimeter's hostSession.ts has the protocol):
 *
 *  - on the app host, an unauthenticated page navigation starts it
 *    ({@link startHostSession}): a nonce cookie and a redirect to the
 *    control plane;
 *  - on the control plane, `GET /app-session` (signed in) posts itself to
 *    `POST /app-session/start`, which checks the registry, the membership
 *    and the access, then sends the browser back with a 60-second code
 *    ({@link serveAppSessionRoute});
 *  - on the app host, `/__everyapp/session` exchanges the code for the
 *    host's session cookie ({@link exchangeHostSession}).
 *
 * Only a hosted gateway with a third-party domain serves any of this
 * (server.ts); elsewhere the paths are the control plane's or the app's as
 * before.
 */
import {
  HANDOFF_CODE_TTL_SECONDS,
  handoffReturnPath,
  hashNonce,
  HOST_NONCE_COOKIE,
  HOST_NONCE_TTL_SECONDS,
  HOST_SESSION_COOKIE,
  HOST_SESSION_PATH,
  HOST_SESSION_TTL_SECONDS,
  hostAdmitsApp,
  hostCookie,
  importHostSessionKey,
  isNonceValue,
  logEvent,
  newCodeId,
  newNonce,
  readCookie,
  routeHost,
  signHostToken,
  verifyHostToken,
  type AppRegistry,
  type HostProfile,
  type HostSessionKey,
  type RegisteredApp,
} from "@every-app/perimeter";
import { auth } from "@/auth";
import { thirdPartyAppRole } from "@/perimeter/hostSessionAuthenticator";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";

const keyCache = new Map<string, Promise<HostSessionKey>>();

/** The handoff's MAC key, or null without BETTER_AUTH_SECRET. */
export function hostSessionKey(env: {
  BETTER_AUTH_SECRET?: string;
}): Promise<HostSessionKey> | null {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  let key = keyCache.get(secret);
  if (!key) {
    key = importHostSessionKey(secret);
    keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(
  status: number,
  title: string,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      },
    },
  );
}

function refusal(status: number, error: string, message: string): Response {
  logEvent("app_session.refused", { error }, "warn");
  return page(status, "Can't open this app", `<p>${escapeHtml(message)}</p>`);
}

function redirect(
  location: string,
  status: 302 | 303,
  cookies: string[] = [],
): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}

/**
 * On a third-party app host: remember a nonce in the browser (the one it
 * already holds, so tabs starting at once share it) and send it to the
 * control plane to come back with a code.
 */
export async function startHostSession(
  request: Request,
  host: string,
  gatewayUrl: string,
): Promise<Response> {
  const held = readCookie(request.headers, HOST_NONCE_COOKIE);
  const nonce = isNonceValue(held) ? held : newNonce();
  const target = new URL("/app-session", gatewayUrl);
  target.searchParams.set(
    "return_to",
    `https://${host}${handoffReturnPath(new URL(request.url))}`,
  );
  target.searchParams.set("nonce_hash", await hashNonce(nonce));
  return redirect(target.toString(), 302, [
    hostCookie(HOST_NONCE_COOKIE, nonce, HOST_NONCE_TTL_SECONDS),
  ]);
}

/** The third-party page a handoff returns to, or null. */
function thirdPartyReturnUrl(
  value: string | null,
  profile: HostProfile,
): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return routeHost(url.host, profile).kind === "third_party" ? url : null;
}

function signInRedirect(returnTo: string, nonceHash: string): Response {
  const back = new URLSearchParams({
    return_to: returnTo,
    nonce_hash: nonceHash,
  });
  return redirect(
    `/sign-in?${new URLSearchParams({ redirect: `/app-session?${back}` })}`,
    303,
  );
}

/** `GET /app-session`: post the handoff from the gateway's own origin. */
async function continuePage(
  request: Request,
  profile: HostProfile,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const returnTo = thirdPartyReturnUrl(params.get("return_to"), profile);
  const nonceHash = params.get("nonce_hash");
  if (!returnTo || !isNonceValue(nonceHash)) {
    return refusal(400, "invalid_request", "This link to an app is broken.");
  }
  const signedIn = await auth.api.getSession({ headers: request.headers });
  if (!signedIn?.session) {
    return signInRedirect(returnTo.toString(), nonceHash);
  }
  // Posted rather than followed as a link, so only a page on the gateway's
  // own origin starts a handoff (the control-plane guard checks the POST).
  const scriptNonce = newCodeId();
  return page(
    200,
    "Opening app",
    `<form method="post" action="/app-session/start"><input type="hidden" name="return_to" value="${escapeHtml(returnTo.toString())}"><input type="hidden" name="nonce_hash" value="${escapeHtml(nonceHash)}"><p>Opening ${escapeHtml(returnTo.host)}…</p><button type="submit">Continue</button></form><script nonce="${scriptNonce}">document.forms[0].submit()</script>`,
    {
      "content-security-policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; form-action 'self' ${returnTo.origin}; frame-ancestors 'none'; base-uri 'none'`,
    },
  );
}

/**
 * `POST /app-session/start`: the signed-in person, an app they may open on
 * this host, and a code to take back to it.
 */
async function issueCode(
  request: Request,
  { profile, key, registry }: AppSessionDeps,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refusal(400, "invalid_request", "This link to an app is broken.");
  }
  const rawReturnTo = form.get("return_to");
  const rawNonceHash = form.get("nonce_hash");
  const returnTo = thirdPartyReturnUrl(
    typeof rawReturnTo === "string" ? rawReturnTo : null,
    profile,
  );
  const nonceHash = typeof rawNonceHash === "string" ? rawNonceHash : null;
  if (!returnTo || !isNonceValue(nonceHash)) {
    return refusal(400, "invalid_request", "This link to an app is broken.");
  }
  const signedIn = await auth.api.getSession({ headers: request.headers });
  if (!signedIn?.session) {
    return signInRedirect(returnTo.toString(), nonceHash);
  }

  let app: RegisteredApp | null = null;
  try {
    app = await registry.findByHostname(returnTo.host);
  } catch {
    // A row the gateway can't route opens nothing.
    app = null;
  }
  if (
    !app ||
    !app.rowId ||
    app.status === "disabled" ||
    !hostAdmitsApp({ kind: "third_party" }, app)
  ) {
    return refusal(404, "unknown_app_host", "There is no app at this address.");
  }
  const role = await thirdPartyAppRole(signedIn.user.id, app);
  if (!role) {
    return refusal(
      403,
      "no_app_access",
      "Your account can't open this app. Ask an admin of its organization for access.",
    );
  }

  const code = await signHostToken(key, {
    typ: "code",
    sid: signedIn.session.id,
    sub: signedIn.user.id,
    app: app.rowId,
    host: returnTo.host,
    nh: nonceHash,
    rt: handoffReturnPath(returnTo),
    jti: newCodeId(),
    exp: Math.floor(Date.now() / 1000) + HANDOFF_CODE_TTL_SECONDS,
  });
  const exchange = new URL(HOST_SESSION_PATH, returnTo.origin);
  exchange.searchParams.set("code", code);
  logEvent("app_session.code_issued", {
    app: app.appId,
    org: app.organizationId,
  });
  return redirect(exchange.toString(), 303);
}

interface AppSessionDeps {
  profile: HostProfile;
  key: HostSessionKey;
  registry: AppRegistry;
}

/**
 * The control plane's handoff routes, or null for any other path (and on
 * a gateway without a third-party domain, which never calls this).
 */
export async function serveAppSessionRoute(
  request: Request,
  deps: AppSessionDeps,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/app-session") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    return continuePage(request, deps.profile);
  }
  if (pathname === "/app-session/start") {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    return issueCode(request, deps);
  }
  return null;
}

/**
 * `/__everyapp/session` on a third-party app host: trade a code for the
 * host's session cookie, once, before it expires, on its own host and app,
 * in the browser holding the handoff's nonce.
 */
export async function exchangeHostSession(
  request: Request,
  options: { app: RegisteredApp; host: string; key: HostSessionKey },
): Promise<Response> {
  const { app, host, key } = options;
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  const claims = await verifyHostToken(
    key,
    new URL(request.url).searchParams.get("code"),
    "code",
  );
  const nonce = readCookie(request.headers, HOST_NONCE_COOKIE);
  if (
    !claims ||
    claims.host !== host ||
    claims.app !== app.rowId ||
    !nonce ||
    (await hashNonce(nonce)) !== claims.nh
  ) {
    return expiredLink("handoff_invalid");
  }
  const claimed = await RateLimitCounterRepository.claimOnce(
    `app-session-code:${claims.jti}`,
    // Past the code's own expiry, after which it fails verification anyway.
    new Date((claims.exp + HANDOFF_CODE_TTL_SECONDS) * 1000),
  );
  if (!claimed) return expiredLink("handoff_used");

  const now = Math.floor(Date.now() / 1000);
  const session = await signHostToken(key, {
    typ: "session",
    sid: claims.sid,
    sub: claims.sub,
    app: claims.app,
    host,
    iat: now,
    exp: now + HOST_SESSION_TTL_SECONDS,
  });
  return redirect(claims.rt, 303, [
    hostCookie(HOST_SESSION_COOKIE, session, HOST_SESSION_TTL_SECONDS),
    hostCookie(HOST_NONCE_COOKIE, "", 0),
  ]);
}

/**
 * A code that can't be used: expired, used, for another host or app, or
 * in a browser that didn't start the handoff. Starting again from the
 * app's home page makes a new one.
 */
function expiredLink(error: string): Response {
  logEvent("app_session.refused", { error }, "warn");
  return page(
    400,
    "This sign-in link has expired",
    `<p>This sign-in link has expired or was already used.</p><p><a href="/">Open the app again</a></p>`,
  );
}
