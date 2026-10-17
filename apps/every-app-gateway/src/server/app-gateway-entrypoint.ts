import {
  GATEWAY_ERROR_HEADER,
  IDENTITY_HEADER,
  ORG_HEADER,
  verifyIdentityJwt,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import type { AppRegistry, RegisteredApp } from "@every-app/perimeter";
import { aiRefusal, handleAuthenticatedAiProxyRequest } from "./ai-proxy";
import type { GatewayMail } from "./capabilities/email";
import {
  handleIntegrationProxyRequest,
  type IntegrationProxyEnv,
} from "./integration-proxy";
import { platformPolicy } from "./platform-policy";

const CALLER_CACHE_MAX_ENTRIES = 500;
const CALLER_CACHE_HIT_TTL_MS = 30_000;
const CALLER_CACHE_MISS_TTL_MS = 5_000;
const ORG_CACHE_MAX_ENTRIES = 500;
const ORG_CACHE_HIT_TTL_MS = 30_000;
const ORG_CACHE_MISS_TTL_MS = 5_000;

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
  WORKERS_AI_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_PROXY_EXTRA_ROUTES?: string;
  GATEWAY_DEPLOYMENT_MODE?: string;
}

/**
 * Which organizations background work from a shared app may be for: active,
 * with at least one live (not deactivated) member.
 * OrganizationRepository.isAttributable in the Worker.
 */
export interface OrganizationDirectory {
  isAttributable(organizationId: string): Promise<boolean>;
}

interface HandleAppGatewayRequestOptions {
  request: Request;
  props: unknown;
  env: AppGatewayEnv;
  registry: AppRegistry;
  organizations: OrganizationDirectory;
  fetchUpstream?: (request: Request) => Promise<Response>;
  /** The gateway's mail for the `email` capability; its own module by default. */
  mail?: () => Promise<GatewayMail>;
}

type AppGatewayErrorCode =
  | "missing_caller_identity"
  | "caller_not_registered"
  | "caller_not_active"
  | "caller_identity_mismatch"
  | "caller_identity_required"
  | "caller_identity_invalid"
  | "caller_org_mismatch"
  | "caller_org_not_attributable"
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

const organizationCache = new Map<
  string,
  { attributable: boolean; expiresAt: number }
>();

export function clearAppCallerCacheForTests(): void {
  callerCache.clear();
  organizationCache.clear();
}

export async function handleAppGatewayRequest({
  request,
  props: rawProps,
  env,
  registry,
  organizations,
  fetchUpstream,
  mail,
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
      // Awaited so a refusal `admit` throws is answered below.
      return await handleIntegrationProxyRequest({
        request,
        capabilities: app.manifest.capabilities,
        env,
        admit: async () => {
          const { organizationId, orgSource, user } = await attributeCall(
            request,
            app,
            props,
            env,
            organizations,
          );
          return {
            caller: {
              organizationId,
              appId: props.appId,
              worker: props.workerName,
              orgSource,
            },
            user,
          };
        },
        fetchUpstream,
        ...(mail ? { mail } : {}),
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

    const { organizationId, orgSource, user } = await attributeCall(
      request,
      app,
      props,
      env,
      organizations,
    );
    console.info("AI gateway request", {
      event: "ai.proxy.request",
      organizationId,
      appId: props.appId,
      workerName: props.workerName,
      provider,
      orgSource,
      attribution: user ? "user" : "app",
      ...(user ? { userId: user.id } : {}),
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
      return errorResponse(error, request);
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
      request,
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
  /**
   * Where the organization came from: the caller's upload-time props (an
   * organization's own app), the forwarded identity, or the shared app's
   * `x-everyapp-org` for background work.
   */
  orgSource: "props" | "jwt" | "header";
  user: EveryAppUser | null;
}

/**
 * Attribute a provider call. An organization's own app calls for its
 * organization (the upload-time props): a forwarded identity of that
 * organization names the user, one that doesn't verify is ignored (the call
 * is the app's), and an `x-everyapp-org` naming another organization is
 * refused. A shared app serves every organization: a forwarded identity
 * (createGatewayFetch sends the request's) decides the organization and
 * must verify (an invalid or expired one is 401, never a fallback to the
 * platform organization); without one, background work names its
 * organization in `x-everyapp-org`, which must be active with a live
 * member; with both, they must agree.
 */
async function attributeCall(
  request: Request,
  app: RegisteredApp,
  props: AppCallerProps,
  env: AppGatewayEnv,
  organizations: OrganizationDirectory,
): Promise<Attribution> {
  const asserted = request.headers.get(ORG_HEADER)?.trim() || null;
  if (app.scope !== "shared") {
    if (asserted !== null && asserted !== props.organizationId) {
      throw orgMismatch(props, "an organization's own app named another");
    }
    return {
      organizationId: props.organizationId,
      orgSource: "props",
      user: await resolveAttribution(request, props, env),
    };
  }
  const token = request.headers.get(IDENTITY_HEADER);
  if (token) {
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
    if (asserted !== null && asserted !== user.orgId) {
      throw orgMismatch(
        props,
        "the asserted organization isn't the identity's",
      );
    }
    return { organizationId: user.orgId, orgSource: "jwt", user };
  }
  if (asserted === null) {
    throw new AppGatewayError(
      "caller_identity_required",
      403,
      `A shared app's provider call needs the identity of the request it serves, or for background work the organization in ${ORG_HEADER}.`,
    );
  }
  let attributable: boolean;
  try {
    attributable = await isAttributable(organizations, asserted);
  } catch (error) {
    console.error("App gateway organization lookup failed", {
      event: "ai.proxy.organization.failed",
      appId: props.appId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw new AppGatewayError(
      "caller_registry_unavailable",
      500,
      "The gateway could not check the organization this call is for.",
    );
  }
  if (!attributable) {
    console.warn("AI gateway background organization refused", {
      event: "ai.proxy.attribution.org_refused",
      organizationId: asserted,
      appId: props.appId,
    });
    throw new AppGatewayError(
      "caller_org_not_attributable",
      403,
      "The organization this call is for is unknown, suspended or has no active members.",
    );
  }
  return { organizationId: asserted, orgSource: "header", user: null };
}

function orgMismatch(props: AppCallerProps, why: string): AppGatewayError {
  console.warn("AI gateway organization mismatch", {
    event: "ai.proxy.attribution.org_mismatch",
    organizationId: props.organizationId,
    appId: props.appId,
    message: why,
  });
  return new AppGatewayError(
    "caller_org_mismatch",
    403,
    `The organization in ${ORG_HEADER} doesn't match whom this call is for.`,
  );
}

/** Whether background work may be for `organizationId`, cached like callers. */
async function isAttributable(
  organizations: OrganizationDirectory,
  organizationId: string,
): Promise<boolean> {
  const now = Date.now();
  const cached = organizationCache.get(organizationId);
  if (cached && cached.expiresAt > now) return cached.attributable;
  if (cached) organizationCache.delete(organizationId);

  const attributable = await organizations.isAttributable(organizationId);
  organizationCache.set(organizationId, {
    attributable,
    expiresAt:
      now + (attributable ? ORG_CACHE_HIT_TTL_MS : ORG_CACHE_MISS_TTL_MS),
  });
  if (organizationCache.size > ORG_CACHE_MAX_ENTRIES) {
    const oldest = organizationCache.keys().next().value;
    if (oldest) organizationCache.delete(oldest);
  }
  return attributable;
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

function errorResponse(error: AppGatewayError, request: Request): Response {
  // On AI routes, OpenAI's error shape: the app's OpenAI client shows it.
  if (new URL(request.url).pathname.startsWith("/api/ai/")) {
    return aiRefusal(error.code, error.status, error.message);
  }
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
    {
      status: error.status,
      headers: { [GATEWAY_ERROR_HEADER]: error.code },
    },
  );
}
