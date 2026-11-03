/**
 * The gateway's provider registry: the built-in catalog plus the rows this
 * gateway registered (`providers` in D1, written by `everyapp provider add`
 * and, later, the MCP tool), resolved once per isolate every 30 seconds
 * like the apps rows. Every reader of a capability id on the gateway (the
 * capability and AI proxies, the settings model behind "Needs setup" and
 * `/mcp`, Admin → Apps) takes the registry {@link gatewayProviders} returns,
 * so a registered provider is one wherever a catalog entry is.
 *
 * Fails closed to the catalog: a gateway whose D1 predates migration 0013
 * (the table isn't there yet) or a read that fails serves the catalog
 * alone, logged once per isolate, never a half-read set of rows. A row the
 * rules refuse (`providerRegistry` says why) is logged by id and reason,
 * never by its text.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  BUILTIN_PROVIDERS,
  gatewayHostRefusal,
  providerRegistry,
  type ProviderRegistry,
  type ProviderRow,
} from "@every-app/sdk/internal";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { appBaseDomain, thirdPartyDomain } from "@/server/app-hosts";

const CACHE_TTL_MS = 30_000;

let cached: { at: number; registry: Promise<ProviderRegistry> } | undefined;
let unavailableLogged = false;
let rejectedLogged = new Set<string>();

/**
 * Forget the cached registry: the next request on this isolate reads the
 * rows again. The provider tools call it after a write; other isolates
 * pick the change up within the 30 seconds.
 */
export function invalidateGatewayProviders(): void {
  cached = undefined;
}

export function resetGatewayProvidersForTests(): void {
  invalidateGatewayProviders();
  unavailableLogged = false;
  rejectedLogged = new Set();
}

type HostEnv = Parameters<typeof appBaseDomain>[0] &
  Parameters<typeof thirdPartyDomain>[0] & { GATEWAY_URL?: string };

/**
 * Why a host can't be a row's on this gateway: the gateway's own host, an
 * app host under APP_BASE_DOMAIN, or a third-party host under
 * THIRD_PARTY_DOMAIN. The pure rules (IP literals, localhost, `.internal`)
 * are the registry's own.
 */
export function refusedGatewayHost(
  host: string,
  settings: HostEnv,
): string | null {
  let own: string | null = null;
  try {
    own = settings.GATEWAY_URL ? new URL(settings.GATEWAY_URL).hostname : null;
  } catch {
    own = null;
  }
  // The rule itself is the SDK's, so `everyapp provider add` refuses the
  // same hosts in the same words before it writes the row.
  return gatewayHostRefusal(host, {
    gatewayHost: own,
    appBaseDomain: appBaseDomain(settings),
    thirdPartyDomain: thirdPartyDomain(settings),
  });
}

/** The registry from `rows`, with this gateway's host rule; rejected rows logged once each. */
export function registryFromRows(
  rows: readonly ProviderRow[],
  settings: HostEnv = env as unknown as HostEnv,
): ProviderRegistry {
  const registry = providerRegistry(rows, {
    refuseHost: (host) => refusedGatewayHost(host, settings),
  });
  for (const refusal of registry.rejected) {
    const key = `${refusal.id}\0${refusal.code}\0${refusal.message}`;
    if (rejectedLogged.has(key)) continue;
    rejectedLogged.add(key);
    // `reason`, as the other refusal logs name it: `code` is a never-log key.
    logEvent(
      "provider.row_invalid",
      { provider: refusal.id, reason: refusal.code, message: refusal.message },
      "warn",
    );
  }
  return registry;
}

async function readRegistry(): Promise<ProviderRegistry> {
  let rows: ProviderRow[];
  try {
    rows = await ProviderRepository.all();
  } catch (error) {
    if (!unavailableLogged) {
      unavailableLogged = true;
      logEvent(
        "provider.rows_unavailable",
        { message: error instanceof Error ? error.message : String(error) },
        "warn",
      );
    }
    return BUILTIN_PROVIDERS;
  }
  return registryFromRows(rows);
}

/**
 * The catalog and this gateway's registered providers, as of the last 30
 * seconds. A read that fails is not cached, so the next request tries
 * again.
 */
export function gatewayProviders(): Promise<ProviderRegistry> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.registry;
  const registry = readRegistry();
  cached = { at: now, registry };
  return registry;
}
