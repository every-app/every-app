/**
 * The outbound Worker for dispatched apps: every `fetch()` a Worker in the
 * Workers for Platforms namespace makes to the internet comes here first
 * (bindings, the AppGateway one included, never do).
 *
 * Default deny. The dispatcher hands over the calling app, its organization
 * and its egress allowlist as the outbound parameter `everyapp`
 * (getAppFetcher's dispatch branch); a request goes out only to an exact
 * hostname on that list, over HTTPS. Model and data providers are refused
 * even when listed: the gateway holds those keys and an app reaches them
 * through its AppGateway binding, metered, never directly. So are the token
 * endpoints of the OAuth clients the gateway holds (not their hosts, which
 * serve the APIs apps call with their users' tokens), the gateway's own
 * hosts, and every third-party app host (THIRD_PARTY_DOMAIN; the list is
 * server/gateway-hosts.ts, shared with the event bus's target rules),
 * which a dispatched app has no business calling from outside the
 * perimeter.
 *
 * The hosted install wires it once the account has a dispatch namespace:
 * the gateway's DISPATCHER binding declares
 * `outbound = { service = "every-app-gateway", entrypoint = "Outbound",
 * parameters = ["everyapp"] }`. Self-hosted gateways have no namespace and
 * never invoke it.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  CAPABILITIES,
  oauthClientOrigin,
  type Capability,
} from "@every-app/sdk/internal";
import {
  logEvent,
  OUTBOUND_PARAMETER,
  type OutboundParameters,
} from "@every-app/perimeter";
import {
  gatewayHosts,
  isSameOrSubdomain,
  normalizeHost,
} from "@/server/gateway-hosts";

/** Hosts whose keys live in the gateway: reached through it or not at all. */
const PROVIDER_HOSTS = [
  "api.openai.com",
  "openrouter.ai",
  "api.dataforseo.com",
  "api.context.dev",
  "gateway.ai.cloudflare.com",
  // Workers AI, and the rest of Cloudflare's API.
  "api.cloudflare.com",
];

interface OutboundEnv {
  GATEWAY_URL?: string;
  APP_BASE_DOMAIN?: string;
  THIRD_PARTY_DOMAIN?: string;
  /** The Mastodon instance whose OAuth client the gateway holds. */
  MASTODON_URL?: string;
  [OUTBOUND_PARAMETER]?: unknown;
}

type EgressDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "no_app"
        | "not_https"
        | "reserved_host"
        | "reserved_endpoint"
        | "not_allowed";
    };

/** The calling app, or null when the dispatcher passed nothing usable. */
function callingApp(value: unknown): OutboundParameters | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<OutboundParameters>;
  if (
    typeof candidate.appId !== "string" ||
    typeof candidate.organizationId !== "string" ||
    typeof candidate.workerName !== "string" ||
    !Array.isArray(candidate.egress) ||
    !candidate.egress.every((host) => typeof host === "string")
  ) {
    return null;
  }
  return candidate as OutboundParameters;
}

/** Times a path may decode to something new before it counts as hiding one. */
const MAX_PATH_DECODES = 3;

/**
 * `pathname` as a lenient server might route it: percent-decoded until it
 * stops changing, lowercased, separators merged, no trailing slash; null
 * when it won't decode.
 */
function loosePath(pathname: string): string | null {
  let current = pathname;
  for (let round = 0; round <= MAX_PATH_DECODES; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) {
      return current
        .toLowerCase()
        .replace(/[/\\]+/g, "/")
        .replace(/\/$/, "");
    }
    current = next;
  }
  return null;
}

/**
 * Whether `url` is a token endpoint of an OAuth client the gateway holds,
 * however its path is spelled: a dispatched app gets tokens through its
 * AppGateway binding, with the gateway's client, never directly.
 */
function isTokenEndpoint(url: URL, env: OutboundEnv): boolean {
  const host = normalizeHost(url.hostname);
  const path = loosePath(url.pathname);
  return Object.values<Capability>(CAPABILITIES).some((capability) => {
    if (capability.mode !== "oauth_client") return false;
    const origin = oauthClientOrigin(capability, { ...env });
    const settingHost = origin ? new URL(origin).hostname : null;
    return capability.token.some((endpoint) => {
      if (normalizeHost(endpoint.host ?? settingHost ?? "") !== host) {
        return false;
      }
      if (path === null) return true;
      return typeof endpoint.path === "string"
        ? loosePath(endpoint.path) === path
        : new RegExp(endpoint.path.source, "i").test(path);
    });
  });
}

function decide(
  url: URL,
  app: OutboundParameters | null,
  env: OutboundEnv,
): EgressDecision {
  if (!app) return { allowed: false, reason: "no_app" };
  if (url.protocol !== "https:") return { allowed: false, reason: "not_https" };
  const host = normalizeHost(url.hostname);
  if (
    [...PROVIDER_HOSTS, ...gatewayHosts(env)].some((reserved) =>
      isSameOrSubdomain(host, reserved),
    )
  ) {
    return { allowed: false, reason: "reserved_host" };
  }
  if (isTokenEndpoint(url, env)) {
    return { allowed: false, reason: "reserved_endpoint" };
  }
  return app.egress.some((allowed) => normalizeHost(allowed) === host)
    ? { allowed: true }
    : { allowed: false, reason: "not_allowed" };
}

/**
 * Judge one outbound request from a dispatched Worker: forward it through
 * `send` when the app's allowlist names its host, otherwise answer 403 and
 * log the denial.
 */
export async function handleOutboundRequest(
  request: Request,
  env: OutboundEnv,
  send: (request: Request) => Promise<Response> = (outgoing) => fetch(outgoing),
): Promise<Response> {
  const url = new URL(request.url);
  const app = callingApp(env[OUTBOUND_PARAMETER]);
  const decision = decide(url, app, env);
  if (decision.allowed) return send(request);

  logEvent(
    "egress.denied",
    {
      app: app?.appId ?? null,
      org: app?.organizationId ?? null,
      worker: app?.workerName ?? null,
      host: url.hostname,
      reason: decision.reason,
    },
    "warn",
  );
  return Response.json(
    { error: "egress_denied", host: url.hostname, reason: decision.reason },
    { status: 403 },
  );
}

/** The outbound Worker entrypoint. It serves no routes of its own. */
export class Outbound extends WorkerEntrypoint<OutboundEnv> {
  async fetch(request: Request): Promise<Response> {
    return handleOutboundRequest(request, this.env);
  }
}
