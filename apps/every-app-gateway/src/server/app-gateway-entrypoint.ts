import {
  GATEWAY_ERROR_HEADER,
  IDENTITY_HEADER,
  verifyIdentityJwt,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import type { AppRegistry, RegisteredApp } from "@every-app/perimeter";
import { handleAuthenticatedAiProxyRequest } from "./ai-proxy";
import {
  handleIntegrationProxyRequest,
  type IntegrationProxyEnv,
} from "./integration-proxy";
import { spendOrgDailyCap, type DailyCounters } from "./org-daily-cap";
import { platformPolicy } from "./platform-policy";

const CALLER_CACHE_MAX_ENTRIES = 500;
const CALLER_CACHE_HIT_TTL_MS = 30_000;
const CALLER_CACHE_MISS_TTL_MS = 5_000;

export interface AppCallerProps {
  organizationId: string;
  appId: string;
  workerName: string;
}

interface AppGatewayEnv extends IntegrationProxyEnv {
  GATEWAY_URL?: string;
  JWT_PUBLIC_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AI_PROXY_EXTRA_ROUTES?: string;
  GATEWAY_DEPLOYMENT_MODE?: string;
  AI_PROXY_ORG_DAILY_LIMIT?: string;
}

interface HandleAppGatewayRequestOptions {
  request: Request;
  props: unknown;
  env: AppGatewayEnv;
  registry: AppRegistry;
  /** Where the per-organization daily caps are counted (hosted only). */
  counters: DailyCounters;
  fetchUpstream?: (request: Request) => Promise<Response>;
}

type AppGatewayErrorCode =
  | "missing_caller_identity"
  | "caller_not_registered"
  | "caller_not_active"
  | "caller_identity_mismatch"
  | "caller_identity_required"
  | "caller_identity_invalid"
  | "org_daily_cap_exceeded"
  | "provider_not_allowed"
  | "invalid_gateway_route"
  | "caller_registry_unavailable"
  | "internal_error";

class AppGatewayError extends Error {
  constructor(
    readonly code: AppGatewayErrorCode,
    readonly status: 401 | 403 | 404 | 429 | 500,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppGatewayError";
  }
}

const callerCache = new Map<
  string,
  { app: RegisteredApp | null; expiresAt: number }
>();

export function clearAppCallerCacheForTests(): void {
  callerCache.clear();
}

export async function handleAppGatewayRequest({
  request,
  props: rawProps,
  env,
  registry,
  counters,
  fetchUpstream,
}: HandleAppGatewayRequestOptions): Promise<Response> {
  try {
    const policy = platformPolicy(env);
    const props = parseCallerProps(rawProps);
    const route = routeFromPath(request);
    let app: RegisteredApp | null;
    try {
      app = await resolveCallerApp(registry, props);
    } catch (error) {
      console.error("App gateway registry lookup failed", {
        event: "ai.proxy.registry.failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw new AppGatewayError(
        "caller_registry_unavailable",
        500,
        "The app registry could not authorize this request.",
      );
    }

    if (!app) {
      throw new AppGatewayError(
        "caller_not_registered",
        403,
        "No registered app matches the service-binding caller identity.",
      );
    }
    if (app.status !== "active") {
      throw new AppGatewayError(
        "caller_not_active",
        403,
        "The calling app is not active.",
      );
    }
    if (
      app.organizationId !== props.organizationId ||
      app.appId !== props.appId ||
      app.workerName !== props.workerName
    ) {
      throw new AppGatewayError(
        "caller_identity_mismatch",
        403,
        "Service-binding caller identity does not match the registry.",
      );
    }
    if (app.scope === "shared" && !policy.sharedApps) {
      throw new AppGatewayError(
        "caller_not_active",
        403,
        "Shared apps are off on this gateway.",
      );
    }
    if (route.kind === "integration") {
      const { organizationId, user } = await attributeCall(
        request,
        app,
        props,
        env,
      );
      return handleIntegrationProxyRequest({
        request,
        capabilities: app.manifest.capabilities,
        user,
        env,
        caller: { organizationId, appId: props.appId },
        fetchUpstream,
      });
    }

    const { provider } = route;
    if (!app.manifest.providers?.includes(provider)) {
      throw new AppGatewayError(
        "provider_not_allowed",
        403,
        "The app manifest does not allow this provider.",
      );
    }

    const { organizationId, user } = await attributeCall(
      request,
      app,
      props,
      env,
    );
    console.info("AI gateway request", {
      event: "ai.proxy.request",
      organizationId,
      appId: props.appId,
      workerName: props.workerName,
      provider,
      attribution: user ? "user" : "app",
      ...(user ? { userId: user.id } : {}),
    });

    await spendDailyCap(counters, {
      organizationId,
      limit: policy.orgDailyCaps.aiProxyRequests,
    });

    return handleAuthenticatedAiProxyRequest({
      request,
      provider,
      env,
      policy: app.manifest.ai,
      caller: { organizationId, appId: props.appId },
      fetchUpstream,
    });
  } catch (error) {
    if (error instanceof AppGatewayError) {
      return errorResponse(error);
    }

    console.error("App gateway request failed", {
      event: "ai.proxy.failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return errorResponse(
      new AppGatewayError(
        "internal_error",
        500,
        "The app gateway could not complete this request.",
      ),
    );
  }
}

function parseCallerProps(value: unknown): AppCallerProps {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw missingCallerIdentity();
  }

  const candidate = value as Record<string, unknown>;
  const organizationId = nonEmptyString(candidate["organizationId"]);
  const appId = nonEmptyString(candidate["appId"]);
  const workerName = nonEmptyString(candidate["workerName"]);
  if (
    !organizationId ||
    !appId ||
    !/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(appId) ||
    !workerName ||
    !/^[a-z0-9-]+$/.test(workerName)
  ) {
    throw missingCallerIdentity();
  }

  return { organizationId, appId, workerName };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function missingCallerIdentity(): AppGatewayError {
  return new AppGatewayError(
    "missing_caller_identity",
    401,
    "The service binding did not provide a complete caller identity.",
  );
}

type GatewayRoute = { kind: "ai"; provider: string } | { kind: "integration" };

/** AI providers under /api/ai/<provider>, capabilities under /api/integrations/. */
function routeFromPath(request: Request): GatewayRoute {
  const { pathname } = new URL(request.url);
  const ai = pathname.match(/^\/api\/ai\/([a-z][a-z0-9-]*)(?:\/|$)/);
  if (ai?.[1]) return { kind: "ai", provider: ai[1] };
  if (pathname.startsWith("/api/integrations/")) return { kind: "integration" };
  throw new AppGatewayError(
    "invalid_gateway_route",
    404,
    "The named gateway entrypoint only serves AI provider and capability proxy paths.",
  );
}

async function resolveCallerApp(
  registry: AppRegistry,
  props: AppCallerProps,
): Promise<RegisteredApp | null> {
  const key = JSON.stringify([
    props.organizationId,
    props.appId,
    props.workerName,
  ]);
  const now = Date.now();
  const cached = callerCache.get(key);
  if (cached && cached.expiresAt > now) return cached.app;
  if (cached) callerCache.delete(key);

  const app = await registry.findByOrgApp(props.organizationId, props.appId);
  callerCache.set(key, {
    app,
    expiresAt: now + (app ? CALLER_CACHE_HIT_TTL_MS : CALLER_CACHE_MISS_TTL_MS),
  });
  if (callerCache.size > CALLER_CACHE_MAX_ENTRIES) {
    const oldest = callerCache.keys().next().value;
    if (oldest) callerCache.delete(oldest);
  }
  return app;
}

/** Whom a provider call is for: the organization it counts against, and the user. */
interface Attribution {
  organizationId: string;
  user: EveryAppUser | null;
}

/**
 * Attribute a provider call. An organization's own app calls for its
 * organization (the upload-time props); a forwarded identity of that
 * organization names the user, and one that doesn't verify is ignored (the
 * call is the app's). A shared app serves every organization, so the
 * forwarded identity (createGatewayFetch sends the request's) decides the
 * organization and must verify: an invalid or expired one is 401, never a
 * fallback to the platform organization, and a call without one is refused
 * for now (background work, which has no request, will assert its
 * organization another way).
 */
async function attributeCall(
  request: Request,
  app: RegisteredApp,
  props: AppCallerProps,
  env: AppGatewayEnv,
): Promise<Attribution> {
  if (app.scope !== "shared") {
    return {
      organizationId: props.organizationId,
      user: await resolveAttribution(request, props, env),
    };
  }
  const token = request.headers.get(IDENTITY_HEADER);
  if (!token) {
    throw new AppGatewayError(
      "caller_identity_required",
      403,
      "A shared app's provider call needs the identity of the request it serves.",
    );
  }
  const user = await verifyForwardedIdentity(token, props, env).catch(
    (error: unknown) => {
      console.warn("AI gateway identity attribution rejected", {
        event: "ai.proxy.attribution.rejected",
        organizationId: props.organizationId,
        appId: props.appId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw new AppGatewayError(
        "caller_identity_invalid",
        401,
        "The forwarded identity is invalid or expired.",
      );
    },
  );
  return { organizationId: user.orgId, user };
}

function verifyForwardedIdentity(
  token: string,
  props: AppCallerProps,
  env: AppGatewayEnv,
): Promise<EveryAppUser> {
  if (!env.JWT_PUBLIC_KEY?.trim() || !env.GATEWAY_URL?.trim()) {
    throw new Error("Gateway identity verification is not configured.");
  }
  return verifyIdentityJwt(token, {
    publicKeys: [env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n")],
    audience: props.workerName,
    issuer: env.GATEWAY_URL,
  });
}

/**
 * Count the call against its organization's daily cap (hosted only); a
 * spent cap is 429 until the UTC day ends, and a counter that can't be
 * read refuses too.
 */
async function spendDailyCap(
  counters: DailyCounters,
  { organizationId, limit }: { organizationId: string; limit: number },
): Promise<void> {
  const decision = await spendOrgDailyCap({
    counters,
    budget: "ai-proxy",
    organizationId,
    limit,
  });
  if (decision.allowed) return;
  console.warn("AI gateway daily cap reached", {
    event: "ai.proxy.daily_cap",
    organizationId,
    limit: decision.limit,
  });
  throw new AppGatewayError(
    "org_daily_cap_exceeded",
    429,
    `This organization has used its ${decision.limit} AI requests for today.`,
    decision.retryAfterSeconds,
  );
}

async function resolveAttribution(
  request: Request,
  props: AppCallerProps,
  env: AppGatewayEnv,
): Promise<EveryAppUser | null> {
  const token = request.headers.get(IDENTITY_HEADER);
  if (!token) return null;

  try {
    const user = await verifyForwardedIdentity(token, props, env);
    if (user.orgId !== props.organizationId) {
      throw new Error("Identity organization does not match the calling app.");
    }
    return user;
  } catch (error) {
    console.warn("AI gateway identity attribution rejected", {
      event: "ai.proxy.attribution.rejected",
      organizationId: props.organizationId,
      appId: props.appId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

function errorResponse(error: AppGatewayError): Response {
  const errorLabel =
    error.status === 401
      ? "Unauthorized"
      : error.status === 403
        ? "Forbidden"
        : error.status === 404
          ? "Not Found"
          : error.status === 429
            ? "Too Many Requests"
            : "Internal Server Error";
  return Response.json(
    {
      error: errorLabel,
      code: error.code,
      message: error.message,
    },
    {
      status: error.status,
      headers: {
        [GATEWAY_ERROR_HEADER]: error.code,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(error.retryAfterSeconds) }),
      },
    },
  );
}
