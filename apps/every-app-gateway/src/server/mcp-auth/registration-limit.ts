/**
 * How many clients may register dynamically (/oauth/register), which
 * anyone may call without signing in. Each registration is a write to
 * OAUTH_KV, and a Cloudflare account's KV writes are shared by every
 * namespace and capped (1,000 a day on the Workers Free plan): unbounded
 * registrations would use them up and break consent and token issuance
 * for everyone. So registrations are limited three ways:
 *
 *  - per isolate, per client address: a few a minute, before anything is
 *    read, so a flood costs nothing but this isolate's memory;
 *  - per client address and per gateway, per UTC day, in D1
 *    (`rate_limit_counters`): these hold across isolates and locations. A
 *    refused request only reads two counters; only a registration let
 *    through writes them. The daily budgets are the platform policy's
 *    (server/platform-policy.ts): 20 per address and 200 per gateway when
 *    self-hosted, more on the hosted gateway, whose customers' AI clients
 *    all register here, and none when the mode is invalid.
 *
 * The Workers Rate Limiting bindings (AUTH_RATE_LIMIT_IP,
 * server/auth-rate-limit.ts) also count /oauth/register and /oauth/token
 * per address, per location, in front of this and under the same address
 * key; the daily budgets here still bound the gateway as a whole.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import { clientAddressKey } from "@/server/auth-rate-limit";
import { platformPolicy } from "@/server/platform-policy";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";

const PER_ISOLATE_PER_MINUTE = 5;
const MAX_TRACKED_ADDRESSES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADDRESS_KEY_CONTEXT = "every-app-gateway:oauth-register-address:v1";

/** This isolate's counts: address → [minute, count]. */
const recent = new Map<string, [number, number]>();
const logged = new Set<string>();

function refused(retryAfterSeconds: number): Response {
  return Response.json(
    {
      error: "rate_limited",
      error_description:
        "Too many client registrations. Try again later, or connect with a client that publishes a client ID metadata document.",
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}

/** One more registration from `address` in this isolate; false past the limit. */
function withinIsolateLimit(address: string, now: number): boolean {
  const minute = Math.floor(now / 60_000);
  const [seen, count] = recent.get(address) ?? [minute, 0];
  const current = seen === minute ? count : 0;
  if (current >= PER_ISOLATE_PER_MINUTE) return false;
  recent.delete(address);
  recent.set(address, [minute, current + 1]);
  if (recent.size > MAX_TRACKED_ADDRESSES) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
  return true;
}

async function hashAddress(address: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ADDRESS_KEY_CONTEXT}:${address}`),
  );
  return [...new Uint8Array(signature)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type RegistrationAllowance =
  | { allowed: false; response: Response }
  /** Count the registration, once it was made. Never throws. */
  | { allowed: true; spend: () => Promise<void> };

/**
 * Whether a client may register now, by the address the request came from.
 * A budget that can't be read (D1 unavailable) refuses: registration is
 * anonymous, so it fails closed.
 */
export async function allowRegistration(
  request: Request,
  now = new Date(),
): Promise<RegistrationAllowance> {
  // Requests without an address share one count.
  const address = clientAddressKey(
    request.headers.get("cf-connecting-ip") ?? "unknown",
  );
  if (!withinIsolateLimit(address, now.getTime())) {
    return { allowed: false, response: refused(60) };
  }

  const day = now.toISOString().slice(0, 10);
  const dayEnds = new Date(Date.parse(day) + DAY_MS);
  const gatewayKey = `oauth-register:gateway:${day}`;
  const addressKey = `oauth-register:address:${await hashAddress(address)}:${day}`;
  let counts: Map<string, number>;
  try {
    counts = await RateLimitCounterRepository.read(
      [gatewayKey, addressKey],
      now,
    );
  } catch (error) {
    logEvent(
      "mcp.oauth.registration_budget_unreadable",
      { message: error instanceof Error ? error.message : String(error) },
      "error",
    );
    return {
      allowed: false,
      response: Response.json(
        {
          error: "temporarily_unavailable",
          error_description: "Try again in a moment.",
        },
        {
          status: 503,
          headers: { "cache-control": "no-store", "retry-after": "30" },
        },
      ),
    };
  }

  // Registrations a day for the whole gateway, and from one client address
  // (an IPv6 address by its /64).
  const { perGateway, perAddress } = platformPolicy(env).dcr;
  const exhausted =
    (counts.get(gatewayKey) ?? 0) >= perGateway
      ? "gateway"
      : (counts.get(addressKey) ?? 0) >= perAddress
        ? "address"
        : null;
  if (exhausted) {
    // Once per isolate and day for each budget: a flood logs one line.
    const logKey = `${exhausted}:${exhausted === "gateway" ? gatewayKey : addressKey}`;
    if (!logged.has(logKey)) {
      if (logged.size > MAX_TRACKED_ADDRESSES) logged.clear();
      logged.add(logKey);
      logEvent(
        "mcp.oauth.registration_limited",
        {
          budget: exhausted,
          limit: exhausted === "gateway" ? perGateway : perAddress,
        },
        "warn",
      );
    }
    return {
      allowed: false,
      response: refused(
        Math.max(60, Math.ceil((dayEnds.getTime() - now.getTime()) / 1000)),
      ),
    };
  }

  return {
    allowed: true,
    spend: () =>
      RateLimitCounterRepository.increment(
        [gatewayKey, addressKey],
        dayEnds,
      ).catch((error: unknown) =>
        logEvent(
          "mcp.oauth.registration_budget_unwritable",
          { message: error instanceof Error ? error.message : String(error) },
          "warn",
        ),
      ),
  };
}

export function resetRegistrationLimitsForTests(): void {
  recent.clear();
  logged.clear();
}
