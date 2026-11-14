/**
 * The last step of an app's call to an OAuth provider's API when the
 * person's connection was made through Composio
 * (docs/design/2026-11-composio.md). heldToken.ts makes every check a
 * call is held to (the manifest lists the provider, it is set up, whose
 * connection, allowed, not expired, made the way the provider is served,
 * holding what the app lists, the host one of the provider's) and hands
 * the call over. Then, each a refusal with its code:
 *
 *  - one of the provider's services in Composio owns the URL, and the
 *    connection has an account for it;
 *  - the method is one Composio sends, and a body, if any, is JSON;
 *  - one request to Composio, which adds the token: the URL with its
 *    query, and the headers the direct path would have forwarded;
 *  - the provider's answer comes back rebuilt, without its cookies.
 *
 * The key never reaches this module, and Composio's own error text never
 * reaches the app.
 */
import {
  composioServiceFor,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import type {
  ComposioCallAnswer,
  ComposioCallPort,
} from "@/server/composio/calls";
import {
  COMPOSIO_METHODS,
  ComposioBodyKind,
  ComposioFailure,
  type ComposioMethod,
} from "@/server/composio/client";
import type { HeldConnection } from "@/server/oauth/heldTokens";
import { STRIPPED_QUERY, forwardableHeaders } from "./forward";
import { readCapped } from "./read-capped";
import { capabilityRefusal } from "./refusal";

/** The largest JSON body read to be sent through Composio. */
const BODY_BYTES = 10 * 1024 * 1024;

/** Request headers Composio sets for itself, or that describe a body it writes again. */
const UNSENT_HEADERS = [
  "host",
  "content-length",
  "content-type",
  "accept-encoding",
  "x-http-method-override",
];

/**
 * The provider's headers that don't come back: hop-by-hop ones, those
 * that describe the body as the provider sent it and not as it is now,
 * and its cookies.
 */
const UNRETURNED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

/** Statuses that carry no body. */
const BODILESS = new Set([204, 205, 304]);

/** What became of a call sent through Composio. */
type ComposioCallOutcome =
  /** The provider answered. */
  | { kind: "answer"; response: Response; service: string }
  /** Refused here, or Composio or the provider couldn't be reached. */
  | { kind: "refusal"; response: Response; service: string | null }
  /** The connection can't be used any more: the person reconnects. */
  | { kind: "reconnect"; message: string; expired: boolean };

interface ComposioCallOptions {
  request: Request;
  id: string;
  capability: OAuthClientCapability;
  /** The provider URL the app named: https, on one of the provider's hosts. */
  upstream: URL;
  composio: ComposioCallPort;
  connection: HeldConnection;
  organizationId: string;
  connectPath: string;
}

function isComposioMethod(method: string): method is ComposioMethod {
  return (COMPOSIO_METHODS as readonly string[]).includes(method);
}

function isJson(contentType: string | null): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

/** The provider's answer as a `Response`. */
function rebuilt(answer: ComposioCallAnswer): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(answer.headers)) {
    if (UNRETURNED_HEADERS.has(name.toLowerCase())) continue;
    try {
      headers.set(name, value);
    } catch {
      // A name or value no header can hold: left out.
    }
  }
  const { body } = answer;
  if (BODILESS.has(answer.status)) {
    if (body.kind === ComposioBodyKind.Binary) void body.stream?.cancel();
    return new Response(null, { status: answer.status, headers });
  }
  switch (body.kind) {
    case ComposioBodyKind.Json:
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return new Response(JSON.stringify(body.value), {
        status: answer.status,
        headers,
      });
    case ComposioBodyKind.Text:
      return new Response(body.text, { status: answer.status, headers });
    case ComposioBodyKind.Binary:
      headers.set("content-type", body.contentType);
      return new Response(body.stream, { status: answer.status, headers });
  }
}

export async function sendThroughComposio({
  request,
  id,
  capability,
  upstream,
  composio,
  connection,
  organizationId,
  connectPath,
}: ComposioCallOptions): Promise<ComposioCallOutcome> {
  const label = capability.label;
  const refusal = (
    status: number,
    code: string,
    message: string,
    service: string | null = null,
  ): ComposioCallOutcome => ({
    kind: "refusal",
    response: capabilityRefusal(status, code, message),
    service,
  });
  // A service owns the URL, and the connection has its account.
  const service = composioServiceFor(id, upstream);
  if (service === null) {
    return refusal(
      400,
      "invalid_integration_route",
      `${label} is used through Composio here, and none of its services there owns this URL.`,
    );
  }
  // The connection has an account for every service the app's scopes
  // name (heldToken.ts checked), so one it lacks is a service the app
  // lists no scope for. Connecting again would not add it.
  const account = connection.accounts.find((each) => each.service === service);
  if (!account) {
    return refusal(
      400,
      "invalid_integration_route",
      `${label} is used through Composio here, and this app lists no scope for the service this URL belongs to. List one under capabilities.${id}.scopes in everyapp.config.ts and deploy again.`,
      service,
    );
  }
  // The request, as Composio sends it.
  const method = request.method.toUpperCase();
  if (!isComposioMethod(method)) {
    return refusal(
      400,
      "invalid_integration_route",
      `Through Composio, ${label} calls are ${COMPOSIO_METHODS.join(", ")}.`,
      service,
    );
  }
  let body: unknown;
  if (method !== "GET") {
    const text = await readCapped(request, BODY_BYTES);
    if (text === null) {
      return refusal(
        413,
        "integration_body_invalid",
        `Through Composio a body is at most ${BODY_BYTES / 1024 / 1024} MiB.`,
        service,
      );
    }
    if (text !== "") {
      const onlyJson = () =>
        refusal(
          400,
          "integration_body_invalid",
          "Through Composio only a JSON body can be sent.",
          service,
        );
      if (!isJson(request.headers.get("content-type"))) return onlyJson();
      try {
        body = JSON.parse(text);
      } catch {
        return onlyJson();
      }
    }
  }
  const headers = forwardableHeaders(request.headers);
  for (const name of UNSENT_HEADERS) headers.delete(name);
  for (const name of STRIPPED_QUERY) upstream.searchParams.delete(name);
  // One request to Composio.
  const sent = await composio.send({
    organizationId,
    connection,
    account,
    request: {
      toolkit: service,
      method,
      url: upstream.toString(),
      headers: [...headers.entries()],
      ...(body === undefined ? {} : { body }),
    },
  });
  if (sent.ok) {
    return { kind: "answer", response: rebuilt(sent.value), service };
  }
  switch (sent.failure) {
    case ComposioFailure.NotConnected:
      return {
        kind: "reconnect",
        message: `The account this ${label} connection uses is gone from this person's Composio; connect it again at ${connectPath}.`,
        expired: sent.expired,
      };
    case ComposioFailure.KeyRefused:
      return {
        kind: "reconnect",
        message: `Composio refused this person's key, so their ${label} connection can't be used; they link Composio again at ${connectPath}.`,
        expired: sent.expired,
      };
    case ComposioFailure.HostRefused:
      return refusal(
        400,
        "invalid_integration_route",
        `Composio doesn't send ${label} calls to ${upstream.host}.`,
        service,
      );
    case ComposioFailure.SessionGone:
    case ComposioFailure.UpstreamFailure:
      return refusal(
        502,
        "integration_upstream_failed",
        `${label} could not be reached through Composio.`,
        service,
      );
  }
}
