/**
 * Which OAuth client the Gateway uses for a provider
 * (docs/design/2026-10-oauth-providers.md section 6): the Worker env's
 * settings first (`GOOGLE_CLIENT_ID`, set from the terminal), else the
 * client an owner or admin pasted under Admin → Providers, sealed in D1.
 * A client is read only while it was uploaded for the provider as it is
 * now (`oauth.client-bound-to-endpoints`): a registered row's env client
 * through the registry's `bound`, a D1 client through its own `bound_to`.
 */
import { logEvent } from "@every-app/perimeter";
import {
  oauthClientCredentials,
  providerBindingKey,
  type CapabilityLookup,
  type CapabilitySettings,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { OAuthClientRepository } from "@/server/repositories/OAuthClientRepository";
import type { SealingEnv } from "@/server/secrets/sealed";

export interface ResolvedOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** Where it came from: the Worker env, or the sealed D1 row. */
  source: "env" | "d1";
}

/** What a resolver needs to know about a provider; the lookup for a row's binding. */
interface ResolveOAuthClientInput {
  id: string;
  capability: OAuthClientCapability;
  env: CapabilitySettings & SealingEnv;
  lookup?: CapabilityLookup;
}

/** A resolver the proxy and the flow share; tests pass their own. */
export type OAuthClientResolver = (
  input: ResolveOAuthClientInput,
) => Promise<ResolvedOAuthClient | null>;

/** Whether a D1 client is for the provider as it is now, and still opens. */
function d1Usable(
  stored: { boundTo: string | null; lost: boolean },
  capability: OAuthClientCapability,
): boolean {
  return !stored.lost && stored.boundTo === providerBindingKey(capability);
}

/**
 * The env client while the registry says the provider's settings may be
 * read, else the D1 client while it was uploaded for these endpoints.
 */
export const resolveOAuthClient: OAuthClientResolver = async ({
  id,
  capability,
  env,
  lookup,
}) => {
  const fromEnv = oauthClientCredentials(capability, env);
  if (fromEnv && (!lookup?.bound || lookup.bound(id))) {
    return { ...fromEnv, source: "env" };
  }
  if (fromEnv) return null;
  let stored: Awaited<ReturnType<typeof OAuthClientRepository.credentials>>;
  try {
    stored = await OAuthClientRepository.credentials(id, env);
  } catch (error) {
    // Fails closed: a client that can't be read is one the gateway lacks.
    logEvent(
      "oauth.client_unavailable",
      { provider: id, error: error instanceof Error ? error.name : "unknown" },
      "warn",
    );
    return null;
  }
  if (!stored || !d1Usable(stored, capability)) return null;
  if (capability.secrets.clientSecret && stored.secret === null) return null;
  return {
    clientId: stored.clientId,
    ...(stored.secret ? { clientSecret: stored.secret } : {}),
    source: "d1",
  };
};
