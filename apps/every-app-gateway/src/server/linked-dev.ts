/**
 * Linked dev (docs/design/linked-dev.md): `ANY /linked-dev/<app id>/…` on
 * the gateway host, where `everyapp dev --gateway` on a person's computer
 * reaches the Gateway's services for one app, as them. The path's rest is
 * what the app's service binding would send (`/api/ai/<provider>/…`,
 * `/api/integrations/…`, `/api/events/emit`), served by the same
 * `handleAppGatewayRequest` with the same manifest checks, provider
 * allow-list, caps and usage counting; plus `GET …/whoami` for the
 * gateway-lite's identity.
 *
 * Bearer only. The token is a linked dev grant of the gateway's own OAuth
 * server (resource `${issuer}/linked-dev/<app id>`, props kind `dev`),
 * validated for exactly that resource (`dev.audience-is-one-app`), then
 * re-read on every call (`resolveDevCaller`: the row, the member's live
 * role, which must be owner or admin, ban, organization status, and the
 * organization's linked dev switch) and checked against the app row (in
 * the token's organization, first-party, active, not shared) and the
 * member's app access now (`dev.owner-admin-only`,
 * `dev.per-request-recheck`). Anything short of that is 401 or 403, never
 * anonymous, and nothing here reads a cookie.
 *
 * The identity and organization headers an app's SDK sends are dropped
 * before the proxy sees the request: a dev identity JWT (the SDK's
 * well-known dev key) must never be verified by a production gateway
 * (`dev.identity-never-forwarded`). Attribution is the token's.
 *
 * Spend is real, so each connection is rate-limited per minute and per
 * UTC day in D1 (`rate_limit_counters`), and its first call of a day is a
 * `connection.used` event in the audit log (`dev.rate-limited-and-audited`).
 *
 * Behind Cloudflare Access the path is bypassed (packages/cli/src/lib/
 * access/plan.ts), as `/mcp` and `/oauth/token` are: it checks its own
 * credential.
 */
import { env, waitUntil } from "cloudflare:workers";
import {
  IDENTITY_HEADER,
  ORG_HEADER,
  toOrgRole,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import { extractBearerCredential, logEvent } from "@every-app/perimeter";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { LINKED_DEV_PATH, devResource } from "./mcp-auth/resources";
import { isMcpOauthEnabled } from "./oauth-flag";
import { AppAccessRepository } from "./repositories/AppAccessRepository";
import { McpConnectionRepository } from "./repositories/McpConnectionRepository";
import { OrganizationRepository } from "./repositories/OrganizationRepository";
import { OrgAppSettingsRepository } from "./repositories/OrgAppSettingsRepository";
import { RateLimitCounterRepository } from "./repositories/RateLimitCounterRepository";
import { UsageRepository } from "./repositories/UsageRepository";
import { McpConnectionService } from "./services/McpConnectionService";

/** Per connection: calls a minute, and a UTC day (docs/design/linked-dev.md §4.3; TODO "Linked dev" question 4). */
export const LINKED_DEV_LIMITS = { perMinute: 120, perDay: 2_000 } as const;
const APP_SLUG = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const WHOAMI = "whoami";

type Refusal = {
  status: 401 | 403 | 404 | 429;
  error: string;
  message: string;
  headers?: Record<string, string>;
};

function refuse({ status, error, message, headers = {} }: Refusal): Response {
  return Response.json(
    { error, message },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 401
          ? { "www-authenticate": 'Bearer realm="every-app-linked-dev"' }
          : {}),
        ...headers,
      },
    },
  );
}

/** The app id and the rest of a `/linked-dev/<app id>/<rest>` path, or null. */
function parseLinkedDevPath(
  pathname: string,
): { appSlug: string; rest: string } | null {
  if (!pathname.startsWith(`${LINKED_DEV_PATH}/`)) return null;
  const after = pathname.slice(LINKED_DEV_PATH.length + 1);
  const slash = after.indexOf("/");
  const appSlug = slash === -1 ? after : after.slice(0, slash);
  if (!APP_SLUG.test(appSlug)) return null;
  return { appSlug, rest: slash === -1 ? "/" : after.slice(slash) };
}

/**
 * Serve a linked dev request, or null when the path isn't one (the
 * caller then answers 404 for the bypassed prefix). Never throws: a
 * failure is a 503 in the shape the SDK reads.
 */
export async function serveLinkedDevRoute(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const parsed = parseLinkedDevPath(url.pathname);
  if (!parsed) return null;
  try {
    return await dispatch(request, url, parsed.appSlug, parsed.rest);
  } catch (error) {
    logEvent(
      "linked_dev.failed",
      {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    return Response.json(
      {
        error: "temporarily_unavailable",
        message: "The Gateway couldn't serve linked dev just now.",
      },
      {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "30" },
      },
    );
  }
}

async function dispatch(
  request: Request,
  url: URL,
  appSlug: string,
  rest: string,
): Promise<Response> {
  // Off without the OAuth server: no token could have been issued.
  if (!isMcpOauthEnabled(env)) {
    return refuse({
      status: 404,
      error: "not_found",
      message: "Linked dev is off on this Gateway.",
    });
  }
  const token = extractBearerCredential(request.headers);
  if (!token) {
    return refuse({
      status: 401,
      error: "unauthenticated",
      message: "Linked dev takes a bearer token from `everyapp dev --gateway`.",
    });
  }
  const { validateLinkedDevToken } = await import("./mcp-auth/config");
  const { resolveDevCaller } = await import("./mcp-auth/validate");
  const resource = devResource(url.origin, appSlug);
  const validated = await validateLinkedDevToken(env, resource, token);
  if (!validated) {
    return refuse({
      status: 401,
      error: "invalid_token",
      message:
        "This token doesn't open linked dev for this app here. Run `everyapp dev --gateway …` to sign in again.",
    });
  }
  const caller = await resolveDevCaller(validated.props);
  if (!caller) {
    return refuse({
      status: 401,
      error: "invalid_token",
      message:
        "This linked dev connection no longer stands: it was revoked, you are no longer an owner or admin, or linked dev was turned off. Run `everyapp dev --gateway …` to sign in again.",
    });
  }
  // The app row the grant named: still active, first-party, this slug, in
  // the token's organization, the organization's own (shared apps are out
  // of this version), and the member can still open it.
  const app = await McpConnectionRepository.findActiveAppRow(caller.appRowId);
  if (
    !app ||
    app.appSlug !== appSlug ||
    app.organizationId !== caller.organizationId ||
    app.scope === "shared" ||
    !app.workerName
  ) {
    return refuse({
      status: 403,
      error: "app_unavailable",
      message: `${appSlug} isn't live on this Gateway for your workspace any more.`,
    });
  }
  if (
    !(await AppAccessRepository.hasAccessByUserAndAppSlug(
      caller.userId,
      app.appSlug,
      app.organizationId,
    ))
  ) {
    return refuse({
      status: 403,
      error: "app_access_revoked",
      message: `You can't open ${app.name} any more, so linked dev stops here.`,
    });
  }

  const user: EveryAppUser = {
    id: caller.userId,
    email: caller.email,
    orgId: caller.organizationId,
    orgRole: toOrgRole(caller.orgRole),
    orgName: caller.organizationName,
    channel: "api",
    actor: { sub: `oauth:${caller.connectionId}` },
    scopes: ["*"],
    jti: `dev:${caller.connectionId}`,
  };

  if (rest === `/${WHOAMI}`) {
    if (request.method !== "GET") {
      return new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    // Not a spend, but a token lookup and a few reads: the minute's budget
    // bounds it; the day's (the spend budget) doesn't count it.
    const limited = await rateLimit(caller.connectionId, { minuteOnly: true });
    if (limited) return limited;
    return Response.json(
      {
        user: { id: user.id, email: user.email },
        organization: {
          id: caller.organizationId,
          name: caller.organizationName,
        },
        role: user.orgRole,
        app: {
          id: app.appSlug,
          rowId: app.rowId,
          name: app.name,
          hostname: app.hostname,
        },
        connection: { id: caller.connectionId, clientName: caller.clientName },
        hasAccess: true,
        limits: LINKED_DEV_LIMITS,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const limited = await rateLimit(caller.connectionId);
  if (limited) return limited;
  noteUse(caller, app);

  // What the app's service binding would send: the same path on the
  // binding's origin, without the headers the SDK attributes with (the dev
  // identity JWT, the asserted organization) and without the bearer.
  const headers = new Headers(request.headers);
  for (const name of [
    IDENTITY_HEADER,
    ORG_HEADER,
    "authorization",
    "cookie",
    "host",
  ]) {
    headers.delete(name);
  }
  const forwarded = new Request(
    `http://every-app-gateway.internal${rest}${url.search}`,
    {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error: duplex is needed for a streamed request body in workerd
      duplex: "half",
    },
  );
  const [{ handleAppGatewayRequest }, { gatewayProviders }] = await Promise.all(
    [import("./app-gateway-entrypoint"), import("./providers")],
  );
  logEvent("linked_dev.call", {
    connection: caller.connectionId,
    user_id: caller.userId,
    organization_id: caller.organizationId,
    app: app.appSlug,
    method: request.method,
    path: rest,
  });
  return handleAppGatewayRequest({
    request: forwarded,
    props: {
      organizationId: app.organizationId,
      appId: app.appSlug,
      workerName: app.workerName,
    },
    env,
    registry: new DrizzleAppRegistry(env.DB),
    organizations: OrganizationRepository,
    usage: UsageRepository,
    waitUntil: (task) => waitUntil(task),
    caps: {
      effectiveMonthlyCaps: OrgAppSettingsRepository.getEffectiveMonthlyCaps,
      monthlyUsage: UsageRepository.monthlyUsage,
    },
    providers: gatewayProviders,
    trusted: { organizationId: app.organizationId, user },
  });
}

/** 429 past the connection's minute or day budget; the counters are in D1. */
async function rateLimit(
  connectionId: string,
  { minuteOnly = false }: { minuteOnly?: boolean } = {},
): Promise<Response | null> {
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  const day = now.toISOString().slice(0, 10);
  const minuteCount = await RateLimitCounterRepository.incrementReturning(
    `linked-dev:minute:${connectionId}:${minute}`,
    new Date((minute + 1) * 60_000),
  );
  if (minuteCount > LINKED_DEV_LIMITS.perMinute) {
    return refuse({
      status: 429,
      error: "rate_limited",
      message: `Linked dev allows ${LINKED_DEV_LIMITS.perMinute} calls a minute per connection.`,
      headers: { "retry-after": String(60 - now.getSeconds()) },
    });
  }
  if (minuteOnly) return null;
  const tomorrow = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  const dayCount = await RateLimitCounterRepository.incrementReturning(
    `linked-dev:day:${connectionId}:${day}`,
    new Date(tomorrow),
  );
  if (dayCount > LINKED_DEV_LIMITS.perDay) {
    return refuse({
      status: 429,
      error: "rate_limited",
      message: `Linked dev allows ${LINKED_DEV_LIMITS.perDay} calls a day per connection.`,
      headers: {
        "retry-after": String(Math.ceil((tomorrow - now.getTime()) / 1000)),
      },
    });
  }
  return null;
}

/**
 * The audit log's `connection.used`, once per connection per UTC day,
 * after the response: the one request of the day that claims the day's
 * counter key emits it (a claim holds across isolates and locations; the
 * row's `last_used_at` can't tell, since issuing the token is a use too).
 */
function noteUse(
  caller: {
    connectionId: string;
    userId: string;
    organizationId: string;
    clientName: string;
  },
  app: { rowId: string; appSlug: string; name: string },
): void {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const tomorrow = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  waitUntil(
    RateLimitCounterRepository.claimOnce(
      `linked-dev:used:${caller.connectionId}:${day}`,
      new Date(tomorrow),
    ).then(async (first) => {
      if (!first) return;
      await McpConnectionService.announceUsed({
        id: caller.connectionId,
        userId: caller.userId,
        organizationId: caller.organizationId,
        clientName: caller.clientName,
        app: { rowId: app.rowId, id: app.appSlug, name: app.name },
      });
    }),
  );
}
