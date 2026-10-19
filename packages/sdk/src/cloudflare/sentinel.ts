/**
 * What a production build of an Every App app is made of in place of the
 * install's own values. The build is tenant-neutral: whoever builds an
 * app gets the same Build Output, with these placeholders wherever an
 * install's Worker name, organization, gateway, identity key or resource
 * ids belong. The installer rewrites them (`everyapp deploy` for an own
 * Gateway, the hosted gateway's deployer for a hosted one) and refuses an
 * output in which any survives.
 *
 * A leaf module with no imports, so the gateway Worker can read the same
 * values (`@every-app/sdk/cloudflare/sentinel`) without loading the
 * Node-only Worker builder.
 */

export const BUILD_SENTINEL = Object.freeze({
  // Holds the resource separator, so no registry Worker is ever named so
  // and a string rewrite of it can't hit anything else.
  workerName: "every-hosted--sentinel",
  organizationId: "everyapp-hosted-deploy-sentinel",
  /** The gateway's URL, and so the identity issuer. */
  gatewayUrl: "https://every-hosted--sentinel.invalid",
  publicKey:
    "-----BEGIN PUBLIC KEY-----\nEVERYAPPHOSTEDDEPLOYSENTINEL\n-----END PUBLIC KEY-----\n",
});

/**
 * A manifest binding's placeholder: a D1 database's name and id, an R2
 * bucket's name, a KV namespace's or Hyperdrive config's id. The installer
 * rewrites each by its binding name; the value only has to be recognizable.
 */
export function resourceSentinel(binding: string): string {
  return `${BUILD_SENTINEL.workerName}--${binding}`;
}

/** The fields of the manifest a build's placeholders are made for. */
interface SentinelManifest {
  resources?: {
    d1?: readonly string[];
    kv?: readonly string[];
    r2?: readonly string[];
    hyperdrive?: readonly { readonly name: string }[];
  };
}

/** Everything install-specific a Worker is built from, by binding. */
export interface EveryAppDeployTarget {
  /** The Worker name the gateway registry assigned to this app. */
  workerName: string;
  /** The organization that owns the app; scopes the AppGateway binding. */
  organizationId: string;
  /** The gateway's URL, which is also the identity tokens' issuer. */
  gatewayUrl: string;
  /** SPKI PEM public keys (current + next) that verify identity tokens. */
  identityPublicKeys: string[];
  /** Provisioned resources keyed by manifest binding name. */
  resources: {
    d1?: Record<string, { name: string; id: string }>;
    kv?: Record<string, { id: string }>;
    hyperdrive?: Record<string, { id: string }>;
    /** R2 buckets by binding, under the names the registry assigned. */
    r2?: Record<string, { name: string }>;
  };
}

/** The target every production build is made for: placeholders throughout. */
export function sentinelDeployTarget(
  manifest: SentinelManifest,
): EveryAppDeployTarget {
  const byBinding = <T>(
    bindings: readonly string[] | undefined,
    value: (sentinel: string) => T,
  ): Record<string, T> =>
    Object.fromEntries(
      (bindings ?? []).map((binding) => [
        binding,
        value(resourceSentinel(binding)),
      ]),
    );
  const { resources } = manifest;
  return {
    workerName: BUILD_SENTINEL.workerName,
    organizationId: BUILD_SENTINEL.organizationId,
    gatewayUrl: BUILD_SENTINEL.gatewayUrl,
    identityPublicKeys: [BUILD_SENTINEL.publicKey],
    resources: {
      d1: byBinding(resources?.d1, (id) => ({ name: id, id })),
      kv: byBinding(resources?.kv, (id) => ({ id })),
      hyperdrive: byBinding(
        resources?.hyperdrive?.map((config) => config.name),
        (id) => ({ id }),
      ),
      r2: byBinding(resources?.r2, (name) => ({ name })),
    },
  };
}
