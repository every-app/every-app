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
}

interface HandleAppGatewayRequestOptions {
  request: Request;
  props: unknown;
  env: AppGatewayEnv;
  registry: AppRegistry;
  fetchUpstream?: (request: Request) => Promise<Response>;
}

type AppGatewayErrorCode =
  | "missing_caller_identity"
  | "caller_not_registered"
  | "caller_not_active"
  | "caller_identity_mismatch"
  | "provider_not_allowed"
  | "invalid_gateway_route"
  | "caller_registry_unavailable"
  | "internal_error";

class AppGatewayError extends Error {
  constructor(
    readonly code: AppGatewayErrorCode,
    readonly status: 401 | 403 | 404 | 500,
    message: string,
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
  fetchUpstream,
}: HandleAppGatewayRequestOptions): Promise<Response> {
  try {
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
    const caller = {
      organizationId: props.organizationId,
      appId: props.appId,
    };
    if (route.kind === "integration") {
      return handleIntegrationProxyRequest({
        request,
        capabilities: app.manifest.capabilities,
        user: await resolveAttribution(request, props, env),
        env,
        caller,
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

    const user = await resolveAttribution(request, props, env);
    console.info("AI gateway request", {
      event: "ai.proxy.request",
      organizationId: props.organizationId,
      appId: props.appId,
      workerName: props.workerName,
      provider,
      attribution: user ? "user" : "app",
      ...(user ? { userId: user.id } : {}),
    });

    return handleAuthenticatedAiProxyRequest({
      request,
      provider,
      env,
      policy: app.manifest.ai,
      caller,
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

async function resolveAttribution(
  request: Request,
  props: AppCallerProps,
  env: AppGatewayEnv,
): Promise<EveryAppUser | null> {
  const token = request.headers.get(IDENTITY_HEADER);
  if (!token) return null;

  try {
    if (!env.JWT_PUBLIC_KEY?.trim() || !env.GATEWAY_URL?.trim()) {
      throw new Error("Gateway identity verification is not configured.");
    }
    const user = await verifyIdentityJwt(token, {
      publicKeys: [env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n")],
      audience: props.workerName,
      issuer: env.GATEWAY_URL,
    });
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
          : "Internal Server Error";
  return Response.json(
    {
      error: errorLabel,
      code: error.code,
      message: error.message,
    },
    { status: error.status, headers: { [GATEWAY_ERROR_HEADER]: error.code } },
  );
}
