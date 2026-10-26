/**
 * `emit()`: an app's own event onto the gateway's event bus
 * (docs/design/2026-10-events-out.md, section 7). It is shaped like
 * `sendEmail()` on purpose: the same `{ env, for }` attribution, the same
 * route over the EVERY_APP_GATEWAY binding, the same refusals thrown as
 * `GatewayRefusalError`, and the same local-dev twin that checks what the
 * gateway would check and prints instead of sending. The name and data
 * rules live in `internal/events.ts`, which the gateway reads too, so the
 * two can't drift.
 */
import {
  APP_EVENT_DATA_MAX_BYTES,
  APP_ID_ENV,
  ConfigurationError,
  EVENTS_EMIT_PATH,
  appEventNameProblem,
  appEventType,
  checkEventData,
  type EmitEventRequest,
  type EmitEventResult,
} from "../internal/index.js";
import {
  applyAttribution,
  attributionFor,
  type GatewayCallFor,
} from "./attribution.js";
import { BINDING_ORIGIN, type GatewayServiceBinding } from "./gatewayFetch.js";
import { GatewayRefusalError, gatewayRefusal } from "./integrationFetch.js";

export interface EmitOptions {
  /** The Worker env: the EVERY_APP_GATEWAY binding when deployed; EVERYAPP_DEV in local dev. */
  env: object;
  /**
   * Whom the event is about: the inbound request (its user becomes the
   * event's actor), or `{ background: true, organizationId }` for work no
   * person started (a cron, a queue, a provider's webhook). An
   * organization's own app may omit it for background work; a shared app's
   * Worker must pass one or the other ({@link AttributionError}).
   */
  for?: GatewayCallFor;
  /**
   * The app's own name for what happened: lowercase letters, digits and
   * underscores in dotted segments (`invoice.paid`, `todo.completed`), at
   * most 64 characters. The gateway delivers it as `app.<app id>.<event>`.
   */
  event: string;
  /**
   * What a subscriber needs to act on it: a JSON object, at most 8 KiB
   * serialized, nested at most 8 levels. Ids, names, amounts and states;
   * never a credential. A key named like one at any depth (`token`,
   * `secret`, `password`, `apiKey`, `session`, `cookie`, ...) is refused.
   */
  data: Record<string, unknown>;
}

/**
 * Put an event on the gateway's event bus, for the organization's webhook
 * and email subscribers. The gateway names it `app.<app id>.<event>`, so an
 * app can never emit one of the gateway's own types (`member.joined`);
 * owners and admins choose `app.<app id>.*` (or one name) in Manage
 * workspace, Events, or with `everyapp events add`. Nothing is declared in
 * the manifest. Delivery happens after the call returns: a subscriber that
 * is down doesn't slow or fail the app.
 *
 * `data` goes, as written, to every URL a subscriber chose (Slack, Zapier,
 * an agent): put in it what a person or a workflow reads, never a
 * credential, a session or a person's private content they didn't expect
 * to leave the app. The gateway refuses a key named like a credential.
 *
 * Throws {@link GatewayRefusalError} when the gateway won't take it
 * (`event_name_invalid`, `event_data_invalid`, `event_data_refused`,
 * `event_data_too_large`, `event_rate_limited` past 600 an hour, ...), with
 * the code and a message to show. An emit that must never fail the work
 * around it goes under `ctx.waitUntil()` or a `.catch()`.
 *
 * In local dev (`everyapp dev`, no binding) the event is checked the way
 * the gateway checks it, printed, and answered `{ id: "dev-…", type }`;
 * nothing is delivered.
 */
export async function emit({
  env,
  for: explicitTarget,
  event,
  data,
}: EmitOptions): Promise<EmitEventResult> {
  const target = attributionFor(env, explicitTarget, "emit");
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  if (binding) {
    if (typeof binding.fetch !== "function") {
      throw new ConfigurationError(
        "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
      );
    }
    return emitThroughGateway(binding, target, { event, data });
  }
  if (!values["EVERYAPP_DEV"]) {
    throw new ConfigurationError(
      "Events are unavailable: deploy with the EVERY_APP_GATEWAY binding (everyapp deploy), or run under everyapp dev.",
    );
  }
  return emitInDev(values, { event, data });
}

async function emitThroughGateway(
  binding: GatewayServiceBinding,
  target: GatewayCallFor | undefined,
  body: EmitEventRequest,
): Promise<EmitEventResult> {
  const headers = new Headers({ "content-type": "application/json" });
  applyAttribution(headers, target);
  const response = await binding.fetch(
    new Request(`${BINDING_ORIGIN}${EVENTS_EMIT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const refusal = await gatewayRefusal(response);
  if (refusal) throw new GatewayRefusalError(refusal);
  if (!response.ok) {
    throw new GatewayRefusalError({
      status: response.status,
      code: "event_emit_failed",
      message: `The EveryApp gateway answered ${response.status} to the event.`,
    });
  }
  return (await response.json()) as EmitEventResult;
}

/**
 * What the gateway would do, with no gateway: the same name and data
 * rules, then one line on the console. The data isn't printed: it may hold
 * a person's content, and the line is for "it fired", not for its payload.
 */
function emitInDev(
  values: Record<string, unknown>,
  { event, data }: EmitEventRequest,
): EmitEventResult {
  const nameProblem = appEventNameProblem(event);
  if (nameProblem) {
    throw new GatewayRefusalError({
      status: 400,
      code: "event_name_invalid",
      message: nameProblem,
    });
  }
  const checked = checkEventData(data, APP_EVENT_DATA_MAX_BYTES);
  if (!checked.ok) {
    throw new GatewayRefusalError({
      status: checked.code === "event_data_too_large" ? 413 : 400,
      code: checked.code,
      message: checked.message,
    });
  }
  const appId = values[APP_ID_ENV];
  // The gateway prefixes the manifest id; a dev env without it still shows the shape.
  const type = appEventType(
    typeof appId === "string" && appId.trim() ? appId.trim() : "app",
    event,
  );
  console.info(`[everyapp dev] event ${type} (not delivered: no Gateway)`);
  return { id: `dev-${crypto.randomUUID()}`, type };
}
