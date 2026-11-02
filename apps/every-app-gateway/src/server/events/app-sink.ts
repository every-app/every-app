/**
 * The `app` sink (docs/design/2026-11-birds-decisions/app-event-sink.md):
 * a subscription the deploy made from an app's manifest (`events: {
 * subscribe, why }`) delivers each event to that app's own Worker, over
 * its service binding (or dispatch namespace), at the reserved `POST
 * /__everyapp/events`. No URL and no secret: a one-minute system token of
 * purpose `events.deliver`, minted for the app's Worker and bound to the
 * body's SHA-256, authorizes the one delivery, and the SDK checks it
 * before the app's `events.on` runs. The perimeter refuses the path from
 * outside.
 *
 * What it may deliver is checked here again, whatever the stored row
 * says: the app must be the subscription's organization's own and live,
 * and the type must be on the allowlist (`appSinkTypeAllowed`). Retries,
 * dead-letter state and the delivery log are deliver.ts's, as for a
 * webhook.
 */
import { env } from "cloudflare:workers";
import {
  APP_EVENTS_PATH,
  EVENT_DELIVERY_TIMEOUT_MS,
  EVENT_HEADERS,
  EVENT_RESPONSE_READ_MAX_BYTES,
  PROVIDER_APP_TIER,
  SYSTEM_HEADER,
  appSinkTypeAllowed,
  bodyHash,
  mintSystemJwt,
  type AppEventEnvelope,
} from "@every-app/sdk/internal";
import { AppUnreachableError } from "@every-app/perimeter";
import type { DeliveryRow } from "@/server/repositories/EventDeliveryRepository";
import type { SubscriptionRow } from "@/server/repositories/EventSubscriptionRepository";
import { AppRepository } from "@/server/repositories/AppRepository";
import { describeAnswer, readHead, type SinkResult } from "./sink-result";

/** The app a delivery goes to, as the registry has it. */
export interface AppSinkTarget {
  rowId: string;
  organizationId: string;
  appSlug: string;
  hostname: string | null;
  workerName: string | null;
  tier: string;
  versionId: string | null;
  manifest: string | null;
  name: string;
}

/** How the sink reaches an app and signs for it; tests pass fakes. */
export interface AppSinkDeps {
  /** The app's Worker; throws AppUnreachableError when there is no binding yet. */
  fetcherFor(app: AppSinkTarget): {
    fetch(request: Request): Promise<Response>;
  };
  signing(): { privateKeyPem: string; issuer: string };
}

/** The Worker's own bindings and key. */
export function defaultAppSinkDeps(): AppSinkDeps {
  return {
    fetcherFor: (app) => {
      let fetcher: { fetch(request: Request): Promise<Response> } | undefined;
      return {
        fetch: async (request) => {
          // Loaded on demand, as catalog-sync loads the ToolBus.
          if (!fetcher) {
            const { appFetcherFor } = await import(
              "@/server/toolbus/catalog-sync"
            );
            fetcher = appFetcherFor(app);
          }
          return fetcher.fetch(request);
        },
      };
    },
    signing: () => {
      const settings = env as unknown as {
        JWT_PRIVATE_KEY?: string;
        GATEWAY_URL?: string;
      };
      return {
        privateKeyPem: (settings.JWT_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
        issuer: settings.GATEWAY_URL ?? "",
      };
    },
  };
}

function failed(
  error: string,
  dead: boolean,
  statusCode: number | null = null,
): SinkResult {
  return { ok: false, statusCode, error, dead };
}

export async function sendToApp(
  subscription: SubscriptionRow,
  envelope: AppEventEnvelope,
  delivery: DeliveryRow,
  deps: { userAgent: () => string; appSink: AppSinkDeps },
): Promise<SinkResult> {
  if (!subscription.appRowId) return failed("subscription_gone", true);
  // The allowlist, again: a row edited by hand still delivers nothing else.
  if (envelope.type !== "ping" && !appSinkTypeAllowed(envelope.type)) {
    return failed("type_not_allowed", true);
  }
  // The subscription's organization's own app, never another's (and the
  // envelope is that organization's: the event row was read under it).
  const app = await AppRepository.findById(
    subscription.appRowId,
    subscription.organizationId,
  );
  if (!app || envelope.organization.id !== subscription.organizationId) {
    return failed("app_gone", true);
  }
  if (app.tier === PROVIDER_APP_TIER || !app.workerName || !app.hostname) {
    return failed("app_has_no_worker", true);
  }
  // Not live yet (binding) or switched off: retried, so a delivery made
  // while an admin pauses the app arrives once it is back.
  if (app.status !== "active") return failed("app_not_live", false);

  const target: AppSinkTarget = {
    rowId: app.id,
    organizationId: app.organizationId,
    appSlug: app.appSlug,
    hostname: app.hostname,
    workerName: app.workerName,
    tier: app.tier,
    versionId: app.versionId ?? null,
    manifest: app.manifest ?? null,
    name: app.name,
  };
  const body = JSON.stringify(envelope);
  const signing = deps.appSink.signing();
  const token = await mintSystemJwt(signing.privateKeyPem, {
    // The Worker's name: what the app's EVERYAPP_AUDIENCE is, so a token
    // for one organization's copy of an app never opens another's.
    audience: app.workerName,
    issuer: signing.issuer,
    purpose: "events.deliver",
    bodyHash: await bodyHash(body),
  });
  let response: Response;
  try {
    response = await deps.appSink.fetcherFor(target).fetch(
      new Request(`https://${app.hostname}${APP_EVENTS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": deps.userAgent(),
          [EVENT_HEADERS.event]: envelope.type,
          [EVENT_HEADERS.eventId]: envelope.id,
          [EVENT_HEADERS.delivery]: delivery.id,
          [EVENT_HEADERS.attempt]: String(delivery.attempts),
          [SYSTEM_HEADER]: token,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(EVENT_DELIVERY_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    if (error instanceof AppUnreachableError) {
      return failed("binding_not_ready", false);
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return failed("timeout", false);
    }
    return failed(
      describeAnswer(
        "connection",
        error instanceof Error ? error.message : String(error),
      ),
      false,
    );
  }
  const status = response.status;
  if (status >= 200 && status < 300) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: true, statusCode: status };
  }
  const answer = await readHead(response, EVENT_RESPONSE_READ_MAX_BYTES).catch(
    () => "",
  );
  if (status >= 300 && status < 400) {
    return failed("redirect", false, status);
  }
  return failed(
    describeAnswer(`status_${status}`, answer),
    status === 410,
    status,
  );
}
