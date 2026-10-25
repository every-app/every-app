import {
  CATALOG,
  EVENTS_EMIT_PATH,
  GATEWAY_ERROR_HEADER,
  IDENTITY_HEADER,
  ORG_HEADER,
  providerIds,
  parseIntegrationProxyPath,
  verifyIdentityJwt,
  type CapabilityLookup,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import type { AppRegistry, RegisteredApp } from "@every-app/perimeter";
import { aiRefusal, handleAuthenticatedAiProxyRequest } from "./ai-proxy";
import {
  AI_DEFAULT_PROVIDER,
  resolveAiDefault,
  type AiDefaultChoice,
} from "@every-app/sdk/internal";
import {
  capExceededFields,
  capRefusalMessage,
  checkMonthlyCap,
  clearAppCapCache,
  type AppCapSources,
  type MonthlyCapCheck,
} from "./app-cap";
import type { GatewayMail } from "./capabilities/email";
import {
  handleAppEmit,
  loadAppEmitDeps,
  type AppEmitDeps,
} from "./events/app-emit";
import {
  handleIntegrationProxyRequest,
  type IntegrationProxyEnv,
} from "./integration-proxy";
import { platformPolicy } from "./platform-policy";
import {
  dollarsToMicros,
  type UsageEvent,
  type UsageRecorder,
} from "./usage-event";

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
  /** Cloudflare AI Gateway in front of the AI providers (ai-proxy.ts). */
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_API_KEY?: string;
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
  /**
   * The event bus and the emit counter for `POST /api/events/emit`
   * (events/app-emit.ts); the gateway's own, loaded on first use, by
   * default. Tests pass fakes.
   */
  events?: () => Promise<AppEmitDeps>;
  /**
   * Where answered calls are counted (UsageRepository in the Worker). Only
   * an app with a registry row (`rowId`) is counted; nothing is without one.
   */
  usage?: UsageRecorder;
  /** Runs the count after the response is sent (`ctx.waitUntil`). */
  waitUntil?: (task: Promise<unknown>) => void;
  /**
   * The organizations' monthly caps and the month's counts (app-cap.ts;
   * OrgAppSettingsRepository and UsageRepository in the Worker). Checked
   * after attribution, before a provider is called; only for an app with
   * a registry row, since only those are counted.
   */
  caps?: AppCapSources;
  /**
   * Where a provider id is found: the catalog and this gateway's registered
   * providers (server/providers in the Worker); the catalog alone when
   * absent.
   */
  providers?: () => Promise<CapabilityLookup>;
  /**
   * The organization's stored default model provider (`org_settings.ai_default`,
   * ai-default.ts in the Worker), for the `default` route; the catalog's
   * order alone when absent (tests).
   */
  aiDefault?: (organizationId: string) => Promise<AiDefaultChoice | null>;
  /**
   * What a cap check's standing is reported to, after the answer
   * (events/cap-events.ts: cap.warning at 80%, cap.reached and
   * app.paused_cap at the cap); the event bus by default, loaded on first
   * use. Tests pass a fake.
   */
  onCap?: (
    organizationId: string,
    appRowId: string,
    check: MonthlyCapCheck,
  ) => Promise<void>;
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
  | "app_monthly_cap_exceeded"
  | "invalid_gateway_route"
  | "caller_registry_unavailable"
  | "internal_error";

class AppGatewayError extends Error {
  constructor(
    readonly code: AppGatewayErrorCode,
    readonly status: 401 | 403 | 404 | 429 | 500,
    message: string,
    /** Extra response headers (a 429's `Retry-After`). */
    readonly headers: Record<string, string> = {},
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
  clearAppCapCache();
}

export async function handleAppGatewayRequest({
  request,
  props: rawProps,
  env,
  registry,
  organizations,
  fetchUpstream,
  mail,
  events,
  usage,
  waitUntil,
  caps,
  providers,
  aiDefault = readAiDefaultChoice,
  onCap = noteCapCheckLater,
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
    // Whom an answered call is counted against: set by `admit` (or the AI
    // route's attribution below), so a refused call is never counted. The
    // call is counted (`calls` 1) the moment the provider answers, under
    // waitUntil, since a browser or app that stops reading the body is not
    // heard in workerd; what the body reported is added (`calls` 0) when it
    // was read to the end.
    let attributed: Attribution | null = null;
    const count = (event: Omit<UsageEvent, "organizationId" | "userId">) => {
      if (!usage || !attributed) return;
      const task = usage
        .record({
          ...event,
          organizationId: attributed.organizationId,
          userId: attributed.user?.id ?? "",
        })
        .catch((error: unknown) => {
          console.error("App gateway usage count failed", {
            event: "usage.record.failed",
            appId: props.appId,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        });
      if (waitUntil) waitUntil(task);
    };
    const appRowId = app.rowId;
    // The organization's monthly caps on this app's provider calls (a
    // number of calls, dollars of provider-reported cost), once the call
    // is attributed and before a provider is called. Only calls that are
    // counted are capped: the gateway's own services (email, members) are
    // neither. A refused call is not counted. The dollar cap reads the
    // cost already reported this month, so the call that crosses it is
    // answered and the next one refused.
    const enforceCap = async (organizationId: string) => {
      if (!caps || !appRowId) return;
      const check = await checkMonthlyCap(caps, organizationId, appRowId);
      // The standing goes to the event bus after the answer: a warning
      // near a cap, and a cap being reached, each announced once per kind.
      if (check.caps !== undefined) {
        const task = onCap(organizationId, appRowId, check).catch(
          (error: unknown) => {
            console.error("App gateway cap event failed", {
              event: "events.cap_failed",
              appId: props.appId,
              message: error instanceof Error ? error.message : "Unknown error",
            });
          },
        );
        if (waitUntil) waitUntil(task);
      }
      if (!check.exceeded) return;
      console.warn("App gateway monthly cap reached", {
        event: "usage.cap_exceeded",
        organizationId,
        appId: props.appId,
        appRowId,
        ...capExceededFields(check),
      });
      throw new AppGatewayError(
        "app_monthly_cap_exceeded",
        429,
        capRefusalMessage(props.appId, check),
        { "retry-after": String(check.retryAfterSeconds) },
      );
    };

    if (route.kind === "events") {
      // An app's own event: attributed like a capability call, never
      // counted or capped (not a provider call). The bus and the counter
      // load with the first emit on an isolate.
      const { organizationId, user } = await attributeCall(
        request,
        app,
        props,
        env,
        organizations,
      );
      const deps = await (events ?? loadAppEmitDeps)();
      return handleAppEmit({ request, app, organizationId, user }, deps);
    }

    const lookup = providers ? await providers() : CATALOG;
    if (route.kind === "integration") {
      const url = new URL(request.url);
      // Only to tell a provider call from a service's for the cap: a
      // provider whose host comes from a setting parses to null here and
      // still counts as a provider call.
      const providerCall =
        parseIntegrationProxyPath(url.pathname, url.search, undefined, lookup)
          ?.kind !== "service";
      // Awaited so a refusal `admit` throws is answered below.
      return await handleIntegrationProxyRequest({
        request,
        capabilities: app.manifest.capabilities,
        lookup,
        emailSenders: app.emailSenders ?? [],
        env,
        admit: async () => {
          const { organizationId, orgSource, user } = await attributeCall(
            request,
            app,
            props,
            env,
            organizations,
          );
          if (providerCall) await enforceCap(organizationId);
          attributed = { organizationId, orgSource, user };
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
        // Loaded on first use: it reads D1.
        listMembers: async (organizationId) => {
          const { OrganizationMembersRepository } = await import(
            "./repositories/OrganizationMembersRepository"
          );
          return OrganizationMembersRepository.listAppMembers({
            organizationId,
            appSlug: app.appId,
            shared: app.scope === "shared",
          });
        },
        ...(appRowId
          ? {
              onCall: (report) =>
                count({
                  appRowId,
                  kind: "capability",
                  target: report.capability,
                  status: report.status,
                  calls: 1,
                }),
              onCost: (report) =>
                count({
                  appRowId,
                  kind: "capability",
                  target: report.capability,
                  status: report.status,
                  calls: 0,
                  costMicros: dollarsToMicros(report.cost),
                }),
            }
          : {}),
      });
    }

    const { provider } = route;
    // `default` is the Gateway's default model provider, for an app whose
    // manifest says `ai: { chat: true }`; any other id must be listed.
    const isDefault = provider === AI_DEFAULT_PROVIDER;
    const allowed = isDefault
      ? Boolean(app.manifest.ai?.chat)
      : providerIds(app.manifest).includes(provider);
    if (!allowed) {
      throw new AppGatewayError(
        "provider_not_allowed",
        403,
        isDefault
          ? "The app manifest does not ask for the default model: set ai: { chat: true } (or list a provider under providers)."
          : "The app manifest does not allow this provider.",
      );
    }

    const { organizationId, orgSource, user } = await attributeCall(
      request,
      app,
      props,
      env,
      organizations,
    );
    await enforceCap(organizationId);
    attributed = { organizationId, orgSource, user };
    // The default resolves on the organization's choice and this env;
    // the proxy refuses with what to set when nothing is configured.
    const resolution = isDefault
      ? resolveAiDefault({
          choice: await aiDefault(organizationId),
          isSet: (name) => {
            const value = (env as Record<string, unknown>)[name];
            return typeof value === "string"
              ? value.trim().length > 0
              : Boolean(value);
          },
          lookup,
        })
      : undefined;
    console.info("AI gateway request", {
      event: "ai.proxy.request",
      organizationId,
      appId: props.appId,
      workerName: props.workerName,
      provider: resolution?.provider ?? provider,
      ...(resolution
        ? { via: AI_DEFAULT_PROVIDER, source: resolution.source }
        : {}),
      orgSource,
      attribution: user ? "user" : "app",
      ...(user ? { userId: user.id } : {}),
    });

    return handleAuthenticatedAiProxyRequest({
      request,
      provider,
      env,
      lookup,
      policy: app.manifest.ai,
      ...(resolution ? { aiDefault: resolution } : {}),
      caller: { organizationId, appId: props.appId },
      fetchUpstream,
      ...(appRowId
        ? {
            onAnswer: (report) =>
              count({
                appRowId,
                kind: "ai",
                target: report.provider,
                ...(report.model ? { model: report.model } : {}),
                status: report.status,
                calls: 1,
              }),
            onUsage: (report) =>
              count({
                appRowId,
                kind: "ai",
                target: report.provider,
                ...(report.model ? { model: report.model } : {}),
                status: report.status,
                calls: 0,
                inputTokens: report.usage?.input ?? 0,
                outputTokens: report.usage?.output ?? 0,
                // The call's price where the provider's answer carries it
                // (`cost.responseField`: OpenRouter's usage.cost).
                ...(report.usage?.cost === undefined
                  ? {}
                  : { costMicros: dollarsToMicros(report.usage.cost) }),
              }),
          }
        : {}),
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

/** The organization's stored default model provider, read through the per-isolate cache (ai-default.ts), loaded with the first default-route call. */
async function readAiDefaultChoice(
  organizationId: string,
): Promise<AiDefaultChoice | null> {
  const { aiDefaultChoiceFor } = await import("./ai-default");
  return aiDefaultChoiceFor(organizationId);
}

/** The bus's cap events, loaded with the first cap that is set on an isolate. */
async function noteCapCheckLater(
  organizationId: string,
  appRowId: string,
  check: MonthlyCapCheck,
): Promise<void> {
  const { noteCapCheck } = await import("./events/cap-events");
  await noteCapCheck(organizationId, appRowId, check);
}

type GatewayRoute =
  | { kind: "ai"; provider: string }
  | { kind: "integration" }
  | { kind: "events" };

/** AI providers under /api/ai/<provider>, capabilities under /api/integrations/, the app's own events at /api/events/emit. */
function routeFromPath(request: Request): GatewayRoute {
  const { pathname } = new URL(request.url);
  const ai = pathname.match(/^\/api\/ai\/([a-z][a-z0-9-]*)(?:\/|$)/);
  if (ai?.[1]) return { kind: "ai", provider: ai[1] };
  if (pathname.startsWith("/api/integrations/")) return { kind: "integration" };
  if (pathname === EVENTS_EMIT_PATH) return { kind: "events" };
  throw new AppGatewayError(
    "invalid_gateway_route",
    404,
    "The named gateway entrypoint only serves AI provider, capability proxy and event emit paths.",
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
    return aiRefusal(error.code, error.status, error.message, error.headers);
  }
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
      headers: { ...error.headers, [GATEWAY_ERROR_HEADER]: error.code },
    },
  );
}
