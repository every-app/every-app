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
 * through its AppGateway binding, metered, never directly. So are the
 * gateway's own hosts, and every third-party app host (THIRD_PARTY_DOMAIN),
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
  logEvent,
  OUTBOUND_PARAMETER,
  type OutboundParameters,
} from "@every-app/perimeter";
import { appBaseDomain } from "@/server/app-hosts";

/** Hosts whose keys live in the gateway: reached through it or not at all. */
const PROVIDER_HOSTS = [
  "api.openai.com",
  "openrouter.ai",
  "api.dataforseo.com",
  "api.context.dev",
  "gateway.ai.cloudflare.com",
];

interface OutboundEnv {
  GATEWAY_URL?: string;
  APP_BASE_DOMAIN?: string;
  THIRD_PARTY_DOMAIN?: string;
  [OUTBOUND_PARAMETER]?: unknown;
}

type EgressDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "no_app" | "not_https" | "reserved_host" | "not_allowed";
    };

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isSameOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

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

function gatewayHosts(env: OutboundEnv): string[] {
  const hosts: string[] = [];
  const base = appBaseDomain(env);
  if (base) hosts.push(base);
  // As set, unvalidated: whatever it names is denied.
  if (env.THIRD_PARTY_DOMAIN?.trim()) hosts.push(env.THIRD_PARTY_DOMAIN);
  try {
    if (env.GATEWAY_URL) hosts.push(new URL(env.GATEWAY_URL).hostname);
  } catch {
    // An unparsable GATEWAY_URL names no host to protect.
  }
  return hosts.map(normalizeHost);
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
