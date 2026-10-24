/**
 * The gateway proxy core — `handleGatewayRequest`.
 *
 * Composes the perimeter: resolve app from Host (activating one whose Worker
 * was just uploaded, through `deps.activate`), refuse to open an app that
 * needs setup (through `deps.needsSetup`), refuse the internal tools
 * contract, guard server functions, refuse a request carrying the session
 * cookie twice (cookie tossing), enforce CSRF (and the WebSocket Origin
 * check), decide public-vs-private, authenticate + authorize (an MCP-only
 * token reaches `/mcp` alone), hand `/mcp` to the gateway's ToolBus when it
 * serves the app's tools, strip inbound trust headers, inject a fresh
 * identity JWT (private requests) or the public marker (public routes),
 * proxy via the `getAppFetcher` seam, and stamp security headers.
 *
 * It is dependency-injected end to end so it can be unit-tested in isolation and
 * run for real (D1 registry, Better Auth, service bindings) without changes.
 */
import { parseHost, type ParsedHost } from "./host";
import {
  DUPLICATE_SESSION_COOKIE_MESSAGE,
  hasDuplicateSessionCookie,
} from "./cookies";
import {
  UnroutableAppError,
  type AppRegistry,
  type RegisteredApp,
} from "./registry";
import {
  isMcpOnlyCredential,
  type AuthenticatedSession,
  type SessionAuthenticator,
} from "./session";
import {
  isReservedToolsPath,
  isReservedWellKnownPath,
  matchPublicRoute,
} from "./publicRoutes";
import {
  evaluateCsrf,
  evaluateWebSocketOrigin,
  isWebSocketUpgrade,
} from "./csrf";
import { evaluateServerFnRequest, isServerFnPath } from "./serverFunctions";
import { logEvent } from "./log";
import {
  hasBearerCredential,
  hasEveryAppBearer,
  prepareOutboundHeaders,
  withSecurityHeaders,
  IDENTITY_HEADER,
  PUBLIC_HEADER,
} from "./headers";
import {
  IDENTITY_TTL_SECONDS,
  mintIdentityJwt,
  mintPublicMarkerJwt,
} from "@every-app/sdk/internal";
import {
  getAppFetcher,
  AppUnreachableError,
  type AppFetcher,
} from "./getAppFetcher";
import { stripThirdPartyAppHeaders } from "./hostSession";
import { cacheFingerprintedAsset } from "./assetCache";

/** What {@link GatewayDeps.interceptMcp} receives. */
export interface McpInterceptInput {
  /** The original request; its body is still unread. */
  request: Request;
  app: RegisteredApp;
  /** The authenticated caller, already checked for access to `app`. */
  session: AuthenticatedSession;
}

/** What {@link GatewayDeps.needsSetup} receives. */
export interface NeedsSetupInput {
  /** The app, `active` by now. */
  app: RegisteredApp;
  /** The original request; its body is still unread. */
  request: Request;
  /** Whether the manifest declares the request's route public. */
  publicRoute: boolean;
}

/** What {@link GatewayDeps.thirdParty} needs: see hostSession.ts. */
export interface ThirdPartyHostDeps {
  /**
   * Answer an unauthenticated page navigation by starting the per-host
   * session handoff with the control plane (in place of `loginUrl`).
   */
  startSession(request: Request): Promise<Response>;
}

export interface GatewayDeps {
  /** Worker env (carries service bindings + secrets). */
  env: Record<string, unknown>;
  registry: AppRegistry;
  authenticator: SessionAuthenticator;
  /** RS256 private key PEM for minting identity JWTs. */
  privateKeyPem: string;
  /** `iss` claim — the gateway's own URL. */
  issuer: string;
  /** Header kid for minted tokens. Dev sets the dev kid; prod omits (defaults). */
  keyId?: string;
  /**
   * Resolve which app a Host maps to. Production resolves by full hostname; the
   * dev gateway resolves by first label. Injected so neither is hardcoded.
   */
  resolveApp(
    host: ParsedHost,
    registry: AppRegistry,
  ): Promise<RegisteredApp | null>;
  /** Seam override (tests). Defaults to {@link getAppFetcher}. */
  fetcherFor?(env: Record<string, unknown>, app: RegisteredApp): AppFetcher;
  /**
   * The `aud` of every token minted for an app. Defaults to its Worker name,
   * the audience a deployed app expects (EVERYAPP_AUDIENCE), so a token for
   * one organization's copy of an app never opens another's. The dev
   * gateway mints for the app id, which the SDK accepts only under
   * EVERYAPP_DEV.
   */
  audienceFor?(app: RegisteredApp): string;
  /** Optional login URL to 302 to for unauthenticated HTML navigations. */
  loginUrl?: string;
  /**
   * Serve `<app-host>/mcp` from the gateway's ToolBus instead of proxying it.
   * Called for the exact path `/mcp` once the caller is authenticated and
   * allowed into the app, unless the manifest keeps MCP in the app
   * (`mcp: "app"`) or declares `/mcp` public. Return null, without reading
   * the body, to proxy the request to the app as before (e.g. the app has
   * no tool catalog).
   */
  interceptMcp?(input: McpInterceptInput): Promise<Response | null>;
  /**
   * Make a `binding` app live: its Worker is uploaded, and this may be the
   * first request that can reach it. Resolve true once this gateway reaches
   * the Worker over its service binding and has marked the app active; the
   * request is then served as for an active app. False (or a rejection)
   * leaves it "deploying", as does omitting the hook.
   */
  activate?(app: RegisteredApp): Promise<boolean>;
  /**
   * Refuse to open an app that needs setup: a required setting of its
   * manifest (a provider's key, a capability's settings, a secret of the
   * app's own) isn't set yet. Called for every path once the app is active,
   * before the reserved paths and authentication, with whether the manifest
   * declares the route public. A Response is returned as is: the gateway's
   * answers a private HTML GET navigation with a 302 to the launcher's setup
   * dialog, and anything else (public routes, API calls, other methods) with
   * a 503 `app_needs_setup`, never naming a setting. Null opens the app;
   * omitting the hook gates nothing.
   */
  needsSetup?(input: NeedsSetupInput): Promise<Response | null>;
  /**
   * Set on a third-party host (hostRoutes.ts): sign-in is the per-host
   * session handoff, and app responses lose credentialed CORS and the
   * perimeter's reserved cookies.
   */
  thirdParty?: ThirdPartyHostDeps;
  now?: number;
}

const PUBLIC_MARKER_REUSE_MS = (IDENTITY_TTL_SECONDS * 1000) / 2;

const publicMarkerCache = new Map<
  string,
  { marker: string; mintedAtMs: number }
>();

function json(status: number, body: Record<string, unknown>): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

/**
 * A registry row with a tier or scope the gateway doesn't know: the host is
 * an app's, so it is no 404, and it is never routed.
 */
export function unroutableAppResponse(error: UnroutableAppError): Response {
  logEvent(
    "app.unroutable",
    { app: error.appId, message: error.message },
    "error",
  );
  return json(503, { error: "app_unavailable", app: error.appId });
}

/**
 * App hosts advertise no OAuth (no resource_metadata): the gateway's one
 * OAuth resource is its own `/mcp`, and an app host takes personal access
 * tokens only. A client presenting another token is told where to go.
 */
function bearerChallenge(issuer: string, bearerPresented: boolean): string {
  if (!bearerPresented) return 'Bearer realm="every-app"';
  const gatewayMcp = `${issuer.replace(/\/$/, "")}/mcp`.replace(/["\\]/g, "");
  return `Bearer realm="every-app", error="invalid_token", error_description="Use a personal access token here, or connect ${gatewayMcp}"`;
}

function bearerJson(
  status: number,
  body: Record<string, unknown>,
  issuer: string,
  bearerPresented: boolean,
): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": bearerChallenge(issuer, bearerPresented),
      },
    }),
  );
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function audienceOf(deps: GatewayDeps, app: RegisteredApp): string {
  return deps.audienceFor ? deps.audienceFor(app) : app.workerName;
}

async function getPublicMarker(
  deps: GatewayDeps,
  app: RegisteredApp,
): Promise<string> {
  const now = deps.now ?? Date.now();
  const audience = audienceOf(deps, app);
  const cacheKey = `${audience}\0${deps.issuer}`;
  const cached = publicMarkerCache.get(cacheKey);
  if (cached && now - cached.mintedAtMs < PUBLIC_MARKER_REUSE_MS) {
    return cached.marker;
  }

  const marker = await mintPublicMarkerJwt(deps.privateKeyPem, {
    audience,
    issuer: deps.issuer,
    keyId: deps.keyId,
    now,
  });
  publicMarkerCache.set(cacheKey, { marker, mintedAtMs: now });
  return marker;
}

/**
 * The proxy line: `ms` is the app's time (the fetch over the binding),
 * `gatewayMs` the perimeter's own before it (resolving the app, the
 * session, the access check, the token), so the two can be told apart in
 * Workers Logs. Both are waits, not CPU (see serverTiming).
 */
function logProxy(options: {
  app: RegisteredApp;
  method: string;
  status: number;
  receivedAtMs: number;
  startedAtMs: number;
  mode: "public" | "user";
}): void {
  logEvent("proxy", {
    app: options.app.appId,
    method: options.method,
    status: options.status,
    ms: Date.now() - options.startedAtMs,
    gatewayMs: options.startedAtMs - options.receivedAtMs,
    mode: options.mode,
  });
}

/**
 * The same two durations as a `Server-Timing` header, so a browser's
 * network panel shows how long the perimeter (`gw`) and the app (`app`)
 * each took on every response. Appended, so an app's own entries stay.
 * In Workers the clock advances only at I/O, so both count waits (D1, the
 * binding, a fetch) and not the CPU spent between them: a fresh isolate's
 * initialisation shows as a small `gw` here and as cpuTimeMs in Workers
 * Logs.
 */
function serverTiming(
  receivedAtMs: number,
  startedAtMs: number,
  finishedAtMs: number,
): string {
  return `gw;dur=${startedAtMs - receivedAtMs}, app;dur=${finishedAtMs - startedAtMs}`;
}

/** Whether `deps.activate` made a `binding` app live; never throws. */
async function activated(
  deps: GatewayDeps,
  app: RegisteredApp,
): Promise<boolean> {
  if (!deps.activate) return false;
  try {
    return await deps.activate(app);
  } catch (error) {
    // Still deploying, as far as this request knows: the next one retries.
    logEvent(
      "app.activate_failed",
      {
        app: app.appId,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return false;
  }
}

export async function handleGatewayRequest(
  request: Request,
  deps: GatewayDeps,
): Promise<Response> {
  const receivedAtMs = Date.now();
  const url = new URL(request.url);
  const parsed = parseHost(request.headers.get("host") ?? url.host);
  if (!parsed) {
    return json(400, { error: "missing_host" });
  }

  let app: RegisteredApp | null;
  try {
    app = await deps.resolveApp(parsed, deps.registry);
  } catch (error) {
    if (!(error instanceof UnroutableAppError)) throw error;
    return unroutableAppResponse(error);
  }
  if (!app) {
    // Base host (launcher) or unknown subdomain. In production this is handled
    // by the control-plane app before reaching here.
    return json(404, { error: "no_app_for_host", host: parsed.host });
  }
  if (app.status === "disabled") {
    return json(503, { error: "app_unavailable", status: app.status });
  }
  if (app.status === "binding" && (await activated(deps, app))) {
    app = { ...app, status: "active" };
  }
  if (app.status !== "active") {
    // Registered and mid-deploy: `pending` until its Worker is uploaded,
    // `binding` until a gateway version with its service binding serves.
    const response = json(503, { error: "app_deploying", status: app.status });
    response.headers.set("retry-after", "5");
    return response;
  }
  // Decided once, here: the setup gate needs it before the auth logic does.
  const publicMatch = matchPublicRoute(
    app.manifest.public,
    request.method,
    url.pathname,
  );
  // An app whose required settings aren't set doesn't open, on any path:
  // its public routes close with it (the manifest weighs `required` against
  // them), and nothing below reads a credential for it.
  if (deps.needsSetup) {
    const refused = await deps.needsSetup({
      app,
      request,
      publicRoute: publicMatch.public,
    });
    if (refused) return refused;
  }
  // The tools contract is for the ToolBus over the service binding only (and
  // the SDK demands gateway-minted tokens anyway). Refuse it from outside.
  if (isReservedToolsPath(url.pathname)) {
    return json(404, { error: "not_found" });
  }
  // OAuth discovery documents stay reserved on app hosts and answer 404,
  // before any public route is consulted: an app host is no OAuth resource
  // (the gateway's own /mcp is the only one), and an app must not be able to
  // publish protected-resource, authorization-server or OpenID metadata that
  // sends a person connecting its /mcp to an authorization server of its
  // choosing (see isReservedWellKnownPath for the fallback that reads them).
  if (isReservedWellKnownPath(url.pathname)) {
    return json(404, { error: "not_found" });
  }
  // Server functions only answer same-origin fetch() calls from TanStack's
  // client, on every method and before any auth (see serverFunctions.ts).
  if (
    app.manifest.serverFnGuard !== false &&
    isServerFnPath(url.pathname, app.manifest.serverFnBase)
  ) {
    const decision = evaluateServerFnRequest(request.headers);
    if (!decision.allowed) {
      return json(403, { error: "server_fn_denied", reason: decision.reason });
    }
  }

  // Cookie tossing (cookies.ts): refused before anything reads a session.
  if (
    hasDuplicateSessionCookie(
      request.headers,
      deps.authenticator.sessionCookieNames,
    )
  ) {
    logEvent("session.duplicate_cookie", { app: app.appId }, "warn");
    return json(401, {
      error: "unauthenticated",
      reason: "duplicate_session_cookie",
      message: DUPLICATE_SESSION_COOKIE_MESSAGE,
    });
  }

  const bearerPresent = hasBearerCredential(request.headers);
  const reservedBearerPresent = hasEveryAppBearer(request.headers);

  // CSRF forgery needs an ambient credential to ride; a cookieless request
  // has none, and denying it here would turn the 401 + WWW-Authenticate
  // challenge (how a programmatic client learns it needs a token) into an
  // opaque 403 for every unauthenticated programmatic POST.
  const hasAmbientCookie = request.headers.has("cookie");

  // Private state-changing routes fail closed. Public routes also evaluate
  // CSRF, but a failure downgrades the request to anonymous below: this lets
  // webhooks and other programmatic clients through without ever forwarding a
  // cookie-authenticated member identity. A WebSocket handshake is a GET, but
  // browsers send the cookie on cross-origin handshakes too, so a
  // cookie-authenticated upgrade must come from the app's own Origin.
  const csrf =
    isWebSocketUpgrade(request.headers) && hasAmbientCookie && !bearerPresent
      ? evaluateWebSocketOrigin(parsed.host, request.headers.get("origin"))
      : evaluateCsrf(
          request.method,
          parsed.host,
          request.headers.get("origin"),
          request.headers.get("sec-fetch-site"),
        );
  if (
    !bearerPresent &&
    !csrf.allowed &&
    !publicMatch.public &&
    hasAmbientCookie
  ) {
    return json(403, { error: "csrf_denied", reason: csrf.reason });
  }
  const mode = publicMatch.public ? "public" : "user";

  // Public means auth-OPTIONAL, not auth-stripped: a logged-in member still
  // gets their identity on public routes (apps whose public surface overlaps
  // their signed-in surface — e.g. /:user booking pages next to a dashboard —
  // would otherwise serve members a logged-out page). Anonymous visitors and
  // signed-in non-members get the signed public marker instead.
  let session: AuthenticatedSession | null = null;
  if (csrf.allowed || bearerPresent) {
    try {
      session = await deps.authenticator.authenticate(request);
    } catch (error) {
      if (!publicMatch.public) throw error;
      console.error(
        `authentication failed for public app "${app.appId}"; continuing anonymously:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
    }
  }
  const access = session
    ? await deps.authenticator.hasAppAccess(session, app)
    : false;
  const allowed = access !== false;
  // The session the app sees: the one the authenticator let in with, which
  // may act under the app's own organization rather than the session's.
  if (session && typeof access === "object") session = access;
  const consumedBearer =
    session?.credential?.kind === "pat" ||
    session?.credential?.kind === "oauth";

  // Build the outbound request with all inbound trust headers stripped.
  // Public app surfaces may define their own bearer-token authentication
  // (APIs, webhooks, or ported OSS endpoints). The gateway does not interpret
  // that credential; it only forwards it on manifest-declared public routes
  // when the gateway did not consume it first.
  const outboundHeaders = prepareOutboundHeaders(
    request.headers,
    publicMatch.public,
    reservedBearerPresent || consumedBearer,
  );

  if (session && allowed) {
    // An MCP-only token answers at /mcp and nowhere else in the app.
    if (isMcpOnlyCredential(session.credential) && url.pathname !== "/mcp") {
      return json(403, { error: "forbidden", reason: "token_scope" });
    }
    if (
      deps.interceptMcp &&
      url.pathname === "/mcp" &&
      app.manifest.mcp !== "app" &&
      !publicMatch.public
    ) {
      const served = await deps.interceptMcp({ request, app, session });
      if (served) return withSecurityHeaders(served);
    }
    const identity = await mintIdentityJwt(deps.privateKeyPem, {
      subject: {
        sub: session.sub,
        email: session.email,
        orgId: session.orgId,
        orgRole: session.orgRole,
      },
      audience: audienceOf(deps, app),
      issuer: deps.issuer,
      channel: session.credential?.channel ?? "web",
      actor: session.credential?.actor
        ? { sub: session.credential.actor }
        : undefined,
      scopes: session.credential?.scopes,
      keyId: deps.keyId,
      now: deps.now,
    });
    outboundHeaders.set(IDENTITY_HEADER, identity);
  } else if (
    reservedBearerPresent ||
    consumedBearer ||
    (bearerPresent && !publicMatch.public)
  ) {
    // A consumed (gateway-validated) credential without app access fails
    // closed on every route — downgrading it to anonymous public access would
    // mask revoked grants and mis-bound tokens.
    if (!session) {
      return bearerJson(
        401,
        { error: "unauthenticated" },
        deps.issuer,
        bearerPresent,
      );
    }
    return json(403, { error: "forbidden", reason: "no_app_access" });
  } else if (publicMatch.public) {
    // Signed marker, not a bare "1": the SDK verifies it, so a re-exposed app
    // worker cannot be tricked into public mode by a client-supplied header.
    // (Cached per app to half its TTL — see getPublicMarker.)
    const marker = await getPublicMarker(deps, app);
    outboundHeaders.set(PUBLIC_HEADER, marker);
  } else if (!session) {
    if (wantsHtml(request) && deps.thirdParty) {
      return withSecurityHeaders(await deps.thirdParty.startSession(request));
    }
    if (wantsHtml(request) && deps.loginUrl) {
      return withSecurityHeaders(
        new Response(null, {
          status: 302,
          headers: {
            location: `${deps.loginUrl}?return_to=${encodeURIComponent(url.toString())}`,
          },
        }),
      );
    }
    return bearerJson(
      401,
      { error: "unauthenticated" },
      deps.issuer,
      bearerPresent,
    );
  } else {
    return json(403, { error: "forbidden", reason: "no_app_access" });
  }

  const outbound = new Request(request.url, {
    method: request.method,
    headers: outboundHeaders,
    body: request.body,
    redirect: "manual",
    // A new Request has no `cf`: pass the visitor's (country, ASN, …) on, so
    // the app sees what Cloudflare saw.
    // (Typed loosely: the CLI compiles this file without Workers types.)
    cf: (request as { cf?: unknown }).cf,
    // Preserve the WebSocket upgrade so 101s pass through the binding.
    ...(request.body ? { duplex: "half" } : {}),
  } as RequestInit);

  // A missing binding or a crashing app must surface as a clean gateway
  // error, never as an uncaught exception (Cloudflare's 1101 page).
  let response: Response;
  const startedAtMs = Date.now();
  try {
    const fetcher = (deps.fetcherFor ?? getAppFetcher)(deps.env, app);
    response = await fetcher.fetch(outbound);
  } catch (error) {
    if (error instanceof AppUnreachableError) {
      console.error(`app unreachable: ${error.message}`);
      logProxy({
        app,
        method: request.method,
        status: 503,
        receivedAtMs,
        startedAtMs,
        mode,
      });
      return json(503, { error: "app_unreachable", app: app.appId });
    }
    console.error(
      `app "${app.appId}" threw:`,
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    logProxy({
      app,
      method: request.method,
      status: 502,
      receivedAtMs,
      startedAtMs,
      mode,
    });
    return json(502, { error: "app_error", app: app.appId });
  }
  const finishedAtMs = Date.now();
  logProxy({
    app,
    method: request.method,
    status: response.status,
    receivedAtMs,
    startedAtMs,
    mode,
  });

  // Never rewrap a WebSocket 101 (its body/webSocket cannot be reconstructed),
  // except to strip what a third-party app may not say on its handshake.
  if (response.status === 101) {
    return deps.thirdParty ? stripThirdPartyAppHeaders(response) : response;
  }
  const proxied = withSecurityHeaders(
    cacheFingerprintedAsset(
      request.method,
      url.pathname,
      deps.thirdParty ? stripThirdPartyAppHeaders(response) : response,
    ),
  );
  proxied.headers.append(
    "server-timing",
    serverTiming(receivedAtMs, startedAtMs, finishedAtMs),
  );
  return proxied;
}
