/**
 * The app side of the `app` event sink (docs/design/2026-11-birds-decisions/app-event-sink.md).
 *
 * `everyApp()` answers the reserved `POST /__everyapp/events` here, before
 * any app code runs and whether or not the app passed `events`:
 *
 *  - the request needs the Gateway's system token for this app (purpose
 *    `events.deliver`), whose `bh` claim is the SHA-256 of this exact body,
 *    so a token opens one delivery and nothing else;
 *  - the envelope must name the organization this Worker serves
 *    (`EVERY_APP_ORG_ID`), when it is pinned;
 *  - only then is `events.on` called, under `withOrganization()`, so every
 *    Gateway call it makes is that organization's background work.
 *
 * The perimeter refuses the path from outside and strips inbound
 * `x-everyapp-*` headers, so only the Gateway's event bus reaches it, over
 * the service binding.
 */
import {
  APP_EVENTS_PATH,
  ConfigurationError,
  EVENT_HEADERS,
  IdentityError,
  SYSTEM_HEADER,
  bodyHash,
  resolveVerifyOptions,
  verifySystemJwt,
  type AppEventEnvelope,
  type RequestIdentityOptions,
} from "../internal/index.js";
import { withOrganization } from "./context.js";
import type { ExecutionContextLike } from "./everyApp.js";

/** One event the Gateway delivered: the webhook envelope, plus the delivery's id and attempt. */
export interface AppEvent extends AppEventEnvelope {
  delivery: { id: string; attempt: number };
}

export type AppEventHandler<TEnv = unknown> = (
  event: AppEvent,
  env: TEnv,
  ctx: ExecutionContextLike,
) => unknown | Promise<unknown>;

/**
 * `everyApp(handler, { events: { on } })`. `on` is one function for every
 * event, or one per exact type (`"member.removed"`). An event with no
 * handler is acknowledged and dropped. A handler that throws answers 500,
 * and the Gateway retries the delivery with its usual backoff.
 */
export interface AppEventsOptions<TEnv = unknown> {
  on: AppEventHandler<TEnv> | Partial<Record<string, AppEventHandler<TEnv>>>;
}

export interface EventsEndpointOptions {
  events?: AppEventsOptions<never>;
  /** How to verify the Gateway's token (keys, issuer, audience, dev opt-in). */
  identity: RequestIdentityOptions;
}

/** The most body the endpoint reads: an envelope's data is at most 16 KiB. */
const MAX_BODY_BYTES = 64 * 1024;

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isEnvelope(value: unknown): value is AppEventEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const org = v.organization as Record<string, unknown> | undefined;
  return (
    typeof v.id === "string" &&
    typeof v.type === "string" &&
    typeof v.version === "number" &&
    typeof v.time === "string" &&
    !!org &&
    typeof org === "object" &&
    typeof org.id === "string" &&
    !!v.data &&
    typeof v.data === "object" &&
    !Array.isArray(v.data)
  );
}

function handlerFor(
  on: AppEventsOptions<never>["on"],
  type: string,
): AppEventHandler<never> | undefined {
  if (typeof on === "function") return on;
  return Object.prototype.hasOwnProperty.call(on, type) ? on[type] : undefined;
}

/**
 * Answer a request to the reserved events path, or return null for any
 * other path so the app's own handler runs.
 */
export async function handleEventsRequest(
  request: Request,
  env: unknown,
  ctx: ExecutionContextLike,
  options: EventsEndpointOptions,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== APP_EVENTS_PATH) return null;
  if (request.method !== "POST") {
    return answer(405, { error: "method_not_allowed" });
  }

  let verify;
  try {
    verify = resolveVerifyOptions(options.identity);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(error);
      return answer(500, { error: "misconfigured", message: error.message });
    }
    throw error;
  }

  let claims;
  try {
    claims = await verifySystemJwt(request.headers.get(SYSTEM_HEADER) ?? "", {
      ...verify,
      purpose: "events.deliver",
    });
  } catch (error) {
    if (error instanceof IdentityError) {
      return answer(401, { error: "unauthenticated", message: error.message });
    }
    throw error;
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return answer(413, { error: "too_large" });
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return answer(413, { error: "too_large" });
  }
  // The token was minted for this exact body: another body, even one the
  // Gateway sent, is refused.
  if (claims.bh !== (await bodyHash(body))) {
    return answer(401, {
      error: "unauthenticated",
      message: "the token was minted for another delivery",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (!isEnvelope(parsed)) {
    return answer(400, { error: "invalid_request" });
  }
  const pinned = options.identity.organizationId;
  if (pinned && parsed.organization.id !== pinned) {
    return answer(403, {
      error: "forbidden",
      message: `the event is for organization "${parsed.organization.id}", and this Worker serves "${pinned}"`,
    });
  }

  if (!options.events) {
    // The manifest subscribes, but the Worker passes no `events` to
    // everyApp(): say so, and let the Gateway retry once it does.
    return answer(404, {
      error: "no_handler",
      message: "everyApp() was given no events: { on }",
    });
  }
  const handler = handlerFor(options.events.on, parsed.type);
  if (!handler) return answer(200, { ok: true, handled: false });

  const event: AppEvent = {
    ...parsed,
    delivery: {
      id: request.headers.get(EVENT_HEADERS.delivery) ?? "",
      attempt: Number(request.headers.get(EVENT_HEADERS.attempt) ?? "0") || 0,
    },
  };
  try {
    await withOrganization(parsed.organization.id, () =>
      handler(event, env as never, ctx),
    );
  } catch (error) {
    console.error(error);
    return answer(500, { error: "handler_failed" });
  }
  return answer(200, { ok: true, handled: true });
}
