/**
 * The gateway proxy core — `handleGatewayRequest`.
 *
 * Composes the perimeter: resolve app from Host, enforce CSRF, decide
 * public-vs-private, authenticate + authorize, strip inbound trust headers,
 * inject a fresh identity JWT (private requests) or the public marker (public
 * routes), proxy via the `getAppFetcher` seam, and stamp security headers.
 *
 * It is dependency-injected end to end so it can be unit-tested in isolation and
 * run for real (D1 registry, Better Auth, service bindings) without changes.
 */
import { parseHost, type ParsedHost } from "./host";
import type { AppRegistry, RegisteredApp } from "./registry";
import type { AuthenticatedSession, SessionAuthenticator } from "./session";
import { matchPublicRoute } from "./publicRoutes";
import { evaluateCsrf } from "./csrf";
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
  /** Optional login URL to 302 to for unauthenticated HTML navigations. */
  loginUrl?: string;
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

function bearerChallenge(host: string): string {
  return `Bearer resource_metadata="https://${host}/.well-known/oauth-protected-resource"`;
}

function bearerJson(
  status: number,
  body: Record<string, unknown>,
  host: string,
): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": bearerChallenge(host),
      },
    }),
  );
}

function protectedResourceMetadata(
  host: string,
  resourcePath: string,
  issuer: string,
): Response {
  return withSecurityHeaders(
    new Response(
      JSON.stringify({
        resource: `https://${host}${resourcePath}`,
        authorization_servers: [issuer.replace(/\/$/, "")],
        bearer_methods_supported: ["header"],
      }),
      {
        headers: { "content-type": "application/json" },
      },
    ),
  );
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function getPublicMarker(
  deps: GatewayDeps,
  app: RegisteredApp,
): Promise<string> {
  const now = deps.now ?? Date.now();
  const cacheKey = `${app.appId}\0${deps.issuer}`;
  const cached = publicMarkerCache.get(cacheKey);
  if (cached && now - cached.mintedAtMs < PUBLIC_MARKER_REUSE_MS) {
    return cached.marker;
  }

  const marker = await mintPublicMarkerJwt(deps.privateKeyPem, {
    audience: app.appId,
    issuer: deps.issuer,
    keyId: deps.keyId,
    now,
  });
  publicMarkerCache.set(cacheKey, { marker, mintedAtMs: now });
  return marker;
}

function logProxy(options: {
  app: RegisteredApp;
  method: string;
  status: number;
  startedAtMs: number;
  mode: "public" | "user";
}): void {
  console.log(
    JSON.stringify({
      evt: "proxy",
      app: options.app.appId,
      method: options.method,
      status: options.status,
      ms: Date.now() - options.startedAtMs,
      mode: options.mode,
    }),
  );
}

export async function handleGatewayRequest(
  request: Request,
  deps: GatewayDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseHost(request.headers.get("host") ?? url.host);
  if (!parsed) {
    return json(400, { error: "missing_host" });
  }

  const app = await deps.resolveApp(parsed, deps.registry);
  if (!app) {
    // Base host (launcher) or unknown subdomain. In production this is handled
    // by the control-plane app before reaching here.
    return json(404, { error: "no_app_for_host", host: parsed.host });
  }
  if (app.status !== "active") {
    return json(503, { error: "app_unavailable", status: app.status });
  }
  // RFC 9728 metadata is served by the perimeter and never proxied — for the
  // host-level identifier and path-aware variants (…/oauth-protected-resource/mcp
  // describes the resource https://<host>/mcp). Non-GET methods on these paths
  // must not fall through to a broad public route.
  const metadataBase = "/.well-known/oauth-protected-resource";
  if (
    url.pathname === metadataBase ||
    url.pathname.startsWith(`${metadataBase}/`)
  ) {
    if (request.method !== "GET") {
      return withSecurityHeaders(
        new Response(null, { status: 405, headers: { allow: "GET" } }),
      );
    }
    const resourcePath = url.pathname.slice(metadataBase.length);
    return protectedResourceMetadata(parsed.host, resourcePath, deps.issuer);
  }
  const bearerPresent = hasBearerCredential(request.headers);
  const reservedBearerPresent = hasEveryAppBearer(request.headers);

  const publicMatch = matchPublicRoute(
    app.manifest.public,
    request.method,
    url.pathname,
  );

  // Private state-changing routes fail closed. Public routes also evaluate
  // CSRF, but a failure downgrades the request to anonymous below: this lets
  // webhooks and other programmatic clients through without ever forwarding a
  // cookie-authenticated member identity.
  const csrf = evaluateCsrf(
    request.method,
    parsed.host,
    request.headers.get("origin"),
    request.headers.get("sec-fetch-site"),
  );
  // CSRF forgery needs an ambient credential to ride; a cookieless request
  // has none, and denying it here would turn the 401 + WWW-Authenticate
  // challenge (how MCP clients discover the authorization server) into an
  // opaque 403 for every unauthenticated programmatic POST.
  const hasAmbientCookie = request.headers.has("cookie");
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
  const allowed = session
    ? await deps.authenticator.hasAppAccess(session, app)
    : false;
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
    const identity = await mintIdentityJwt(deps.privateKeyPem, {
      subject: {
        sub: session.sub,
        email: session.email,
        orgId: session.orgId,
        orgRole: session.orgRole,
      },
      audience: app.appId,
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
      return bearerJson(401, { error: "unauthenticated" }, parsed.host);
    }
    return json(403, { error: "forbidden", reason: "no_app_access" });
  } else if (publicMatch.public) {
    // Signed marker, not a bare "1": the SDK verifies it, so a re-exposed app
    // worker cannot be tricked into public mode by a client-supplied header.
    // (Cached per app to half its TTL — see getPublicMarker.)
    const marker = await getPublicMarker(deps, app);
    outboundHeaders.set(PUBLIC_HEADER, marker);
  } else if (!session) {
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
    return bearerJson(401, { error: "unauthenticated" }, parsed.host);
  } else {
    return json(403, { error: "forbidden", reason: "no_app_access" });
  }

  const outbound = new Request(request.url, {
    method: request.method,
    headers: outboundHeaders,
    body: request.body,
    redirect: "manual",
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
      startedAtMs,
      mode,
    });
    return json(502, { error: "app_error", app: app.appId });
  }
  logProxy({
    app,
    method: request.method,
    status: response.status,
    startedAtMs,
    mode,
  });

  // Never rewrap a WebSocket 101 (its body/webSocket cannot be reconstructed).
  if (response.status === 101) {
    return response;
  }
  return withSecurityHeaders(response);
}
