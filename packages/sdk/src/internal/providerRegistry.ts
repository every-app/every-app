/**
 * The provider registry: the built-in catalog (./capabilities.ts) and the
 * providers one gateway registered as rows (`everyapp provider add`,
 * `everyapp_provider_add`), resolved as one lookup
 * (docs/design/2026-10-provider-registry.md). The catalog comes first and
 * a row can never shadow it. Every row is parsed and checked again each
 * time a registry is built, so a row written by hand into D1, or one that
 * stopped passing the rules when a later catalog took its name, is left
 * out and named in `rejected` rather than served.
 *
 * The rules a row must pass (the register's `registry.*` invariants):
 *
 *  - `registry.builtin-precedence`: not a catalog id, and never `everyapp`;
 *  - `registry.row-secret-is-its-own`: each Gateway setting it names starts
 *    with its own id (`STRIPE_` for `stripe`) and is nobody else's: no
 *    install-owned, dev-only or reserved name, no settable Gateway setting
 *    (the catalog's keys and clients included), no other row's;
 *  - `registry.row-hosts-public-https`: each host is a public DNS name (not
 *    an IP literal, localhost, or a `.local`, `.internal` or `.arpa` name)
 *    and not one the gateway serves itself (`refuseHost`, which knows the
 *    gateway's own host and `APP_BASE_DOMAIN`).
 *
 * A second kind of row, a scope-set overlay (`provider_scope_sets`,
 * `everyapp provider scope-set add`), adds a named scope set to a
 * built-in OAuth client that has scope sets (Google, Microsoft, Slack):
 * its scopes, and the routes on the client's own API hosts it unlocks,
 * checked by the rules a built-in set is checked by
 * (`providers.scope-set-overlay-within-client`). An overlay never replaces
 * one of the client's own sets, never names a host outside the client's
 * `api`, and never applies to a registered row (an operator replaces the
 * row's spec instead). Apps list an overlay set under `scopes` as they
 * list a built-in one.
 */
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
  type ApiKeyCapability,
  type Capability,
  type CapabilityLookup,
  type OAuthClientCapability,
  type OAuthScopeSet,
} from "./capabilities.js";
import {
  isDevOnlyGatewaySetting,
  isInstallOwnedGatewaySetting,
  isReservedAppSecretName,
  isSettableGatewaySetting,
} from "./gatewaySettings.js";
import { parseScopeSetOverlay, withScopeSets } from "./oauthSpec.js";
import { isSignInSettingName } from "./signInProviders.js";
import {
  describeSpecProblems,
  parseProviderSpec,
  PROVIDER_ID,
  type RegistrableCapability,
} from "./providerSpec.js";

/** A `providers` row as the gateway or the CLI read it. */
export interface ProviderRow {
  id: string;
  /** The spec, as JSON text or already parsed. */
  spec: unknown;
  /**
   * What the row's key was set for: {@link providerBindingKey} of the row
   * as it was when `everyapp secret set` last set one of its settings;
   * null until then. The gateway reads the row's settings only while this
   * equals the key of the row it has now (`providers.value-bound-to-hosts`).
   */
  boundTo?: string | null;
  /** Who registered it (the Cloudflare login's email, or a member's), for the person setting its key. */
  addedBy?: string | null;
  /** When, in epoch milliseconds. */
  addedAt?: number | null;
}

/** A `provider_scope_sets` row as the gateway or the CLI read it. */
export interface ScopeSetRow {
  /** The built-in OAuth client the set belongs to (`google-workspace`). */
  providerId: string;
  /** The set's name, what an app lists under `scopes` (`gmail.send`). */
  name: string;
  /** The set's spec, as JSON text or already parsed (`parseScopeSetOverlay`'s shape). */
  spec: unknown;
  addedBy?: string | null;
  addedAt?: number | null;
}

/** One overlay the registry serves, as `provider show` reports it. */
export interface RegisteredScopeSet {
  providerId: string;
  name: string;
  set: OAuthScopeSet;
  addedBy: string | null;
  addedAt: number | null;
}

export type ScopeSetRefusalCode =
  | "SCOPE_SET_INVALID"
  | "SCOPE_SET_PROVIDER_UNKNOWN"
  | "SCOPE_SET_BUILTIN";

/** Why an overlay row is not a scope set on this gateway. */
export interface ScopeSetRefusal {
  providerId: string;
  name: string;
  code: ScopeSetRefusalCode;
  message: string;
}

/**
 * The part of a row a key is set for: its hosts, its host setting and its
 * auth, as one canonical string (sorted keys, sorted hosts), so that
 * replacing a row's hosts or auth changes the key and the value it held
 * is no longer read until the operator sets it again. For an OAuth
 * provider the client is bound to its authorize, token and revoke URLs,
 * its API hosts, where the client goes on the token request and its
 * client setting names (`oauth.client-bound-to-endpoints`): an admin who
 * re-points `tokenUrl` has to paste the secret again.
 */
export function providerBindingKey(capability: RegistrableCapability): string {
  if (capability.mode === "ai") {
    // An `ai` row's key is bound to where the proxy sends it: its base URL and the key's placement.
    return JSON.stringify({
      kind: "ai",
      auth: sortedAuth(capability.auth),
      origin: capability.origin,
      basePath: capability.basePath ?? null,
    });
  }
  if (capability.mode === "oauth_client") {
    return JSON.stringify({
      kind: "oauth2-user",
      authorizeUrl: capability.authorize.url,
      tokenUrl: capability.flow?.tokenUrl ?? null,
      revokeUrl: capability.flow?.revokeUrl ?? null,
      inject: capability.token[0]?.inject ?? "form",
      clientId: capability.secrets.clientId,
      clientSecret: capability.secrets.clientSecret ?? null,
      hosts: [...capability.api].sort(),
    });
  }
  return JSON.stringify({
    auth: sortedAuth(capability.auth),
    hostSetting: capability.hostSetting ?? null,
    hosts: [...capability.hosts].sort(),
  });
}

/** An auth block with its keys sorted, one level down too, for a canonical key. */
function sortedAuth(auth: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(auth)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([field, value]) => [
        field,
        typeof value === "object" && value !== null
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : value,
      ]),
  );
}

/** One registered row as `provider list` and `provider show` report it. */
export interface RegisteredProvider {
  id: string;
  capability: RegistrableCapability;
  /** Whether the row's key was set for the hosts and auth it has now. */
  bound: boolean;
  addedBy: string | null;
  addedAt: number | null;
}

export type RowRefusalCode =
  | "PROVIDER_SPEC_INVALID"
  | "PROVIDER_BUILTIN"
  | "PROVIDER_SECRET_TAKEN"
  | "PROVIDER_HOST_REFUSED";

/** Why a row is not a provider on this gateway. */
export interface RowRefusal {
  id: string;
  code: RowRefusalCode;
  message: string;
}

export interface ProviderRegistry extends CapabilityLookup {
  /** Every id, the catalog's first in catalog order, then the rows' in row order. */
  ids(): readonly string[];
  entries(): ReadonlyArray<readonly [string, Capability]>;
  sourceOf(id: string): "catalog" | "row" | undefined;
  /** Every Gateway setting any provider reads, the catalog's and the rows'. */
  settingNames(): ReadonlySet<string>;
  /**
   * Whether `id`'s settings may be read: always for a catalog entry; for a
   * row, only while its key was set for the hosts and auth it has now.
   * False for an id the registry doesn't have.
   */
  bound(id: string): boolean;
  /** The settings of rows whose key isn't bound: read as unset everywhere. */
  unboundSettings(): ReadonlySet<string>;
  /** The registered rows this registry serves, in row order. */
  rows(): readonly RegisteredProvider[];
  /** The rows this registry left out, each with why. */
  readonly rejected: readonly RowRefusal[];
  /** The scope-set overlays this registry applied to built-in clients, in row order. */
  scopeSets(): readonly RegisteredScopeSet[];
  /** Where a client's scope set comes from: its catalog entry, an overlay row, or nowhere. */
  scopeSetSource(
    providerId: string,
    name: string,
  ): "catalog" | "row" | undefined;
  /** The overlay rows this registry left out, each with why. */
  readonly rejectedScopeSets: readonly ScopeSetRefusal[];
}

export interface ProviderRegistryOptions {
  /**
   * A host no row may name on this gateway, with why: the gateway's own
   * host and anything under its apps' base domain. The pure rules refuse
   * the rest (IP literals, localhost, `.internal`).
   */
  refuseHost?: (host: string) => string | null;
  /** The scope-set overlays (`provider_scope_sets`), applied to the catalog's OAuth clients. */
  scopeSets?: readonly ScopeSetRow[];
}

/** The reserved app id no provider may take. */
const RESERVED_IDS = new Set(["everyapp"]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".arpa"];

/** The prefix a provider's own Gateway settings carry: `stripe` → `STRIPE_`, `tiktok-business` → `TIKTOK_BUSINESS_`. */
export function providerSettingPrefix(id: string): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_`;
}

/** Why `host` can't be a row's, by the pure rules alone; null when it can. */
export function publicHostProblem(host: string): string | null {
  if (IPV4.test(host)) return `${host} is an IP address, not a host name`;
  if (
    host === "localhost" ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return `${host} is not a public host`;
  }
  return null;
}

/** What a gateway serves itself, for {@link gatewayHostRefusal}. */
export interface GatewayHosts {
  /** The gateway's own host (`apps.example.com`), or its URL. */
  gatewayHost?: string | null;
  /** Where its apps live (`APP_BASE_DOMAIN`): the domain and everything under it. */
  appBaseDomain?: string | null;
  /** A hosted gateway's third-party domain (`THIRD_PARTY_DOMAIN`), when it has one. */
  thirdPartyDomain?: string | null;
}

/** A bare lowercase host from a host or a URL; null when neither. */
function bareHost(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase().replace(/\.$/, "");
  if (!text) return null;
  if (!text.includes("/")) return text;
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why a row can't send its key to `host` on this gateway: the gateway's
 * own host, an app host under its base domain, or a host under its
 * third-party domain. Null when none applies. The gateway applies it on
 * every read (`refusedGatewayHost`, with its env) and the CLI at `provider
 * add` (with the install's gateway host and base domain), in the same words.
 */
export function gatewayHostRefusal(
  host: string,
  hosts: GatewayHosts,
): string | null {
  const own = bareHost(hosts.gatewayHost);
  if (own && host === own) return `${host} is this gateway's own host`;
  const base = bareHost(hosts.appBaseDomain);
  if (base && (host === base || host.endsWith(`.${base}`))) {
    return `${host} is under this gateway's app domain ${base}`;
  }
  const third = bareHost(hosts.thirdPartyDomain);
  if (third && (host === third || host.endsWith(`.${third}`))) {
    return `${host} is under this gateway's third-party domain ${third}`;
  }
  return null;
}

/**
 * Why a setting name can't be a row's: a name the Gateway, the catalog or
 * another provider already reads, or one outside the row's own prefix.
 * Null when the row may hold it.
 */
export function rowSecretProblem(
  id: string,
  name: string,
  taken: (name: string) => boolean,
): string | null {
  const prefix = providerSettingPrefix(id);
  if (!name.startsWith(prefix)) {
    return `${name} doesn't start with ${prefix}: a provider's settings carry its own id`;
  }
  if (isInstallOwnedGatewaySetting(name)) {
    return `${name} is one of the Gateway's own keys`;
  }
  if (isDevOnlyGatewaySetting(name)) {
    return `${name} is a local-development setting`;
  }
  if (isReservedAppSecretName(name)) {
    return `${name} is a name everyapp sets itself`;
  }
  if (isSignInSettingName(name)) {
    return `${name} is a sign-in provider's setting name (every <ID>_SIGNIN_<FIELD> name is the Gateway's, set with \`everyapp signin add\`)`;
  }
  if (isSettableGatewaySetting(name)) {
    return `${name} is a Gateway setting another provider or the Gateway reads`;
  }
  if (taken(name)) {
    return `${name} is another registered provider's`;
  }
  return null;
}

/**
 * Check one parsed row against the catalog and the other rows. Pure: the
 * CLI runs it before writing D1, the MCP tool before writing, and the
 * gateway again on every read.
 */
export function checkProviderRow(
  id: string,
  capability: RegistrableCapability,
  context: {
    /** Settings the other rows hold. */
    rowSettings: ReadonlySet<string>;
    refuseHost?: (host: string) => string | null;
  },
): RowRefusal | null {
  if (RESERVED_IDS.has(id) || CAPABILITY_IDS.includes(id as never)) {
    return {
      id,
      code: "PROVIDER_BUILTIN",
      message: `${id} is a built-in provider; a registered one can't take its id`,
    };
  }
  for (const name of capabilitySettings(capability)) {
    const problem = rowSecretProblem(id, name, (each) =>
      context.rowSettings.has(each),
    );
    if (problem) {
      return { id, code: "PROVIDER_SECRET_TAKEN", message: problem };
    }
  }
  for (const host of registrableHosts(capability)) {
    const problem = publicHostProblem(host) ?? context.refuseHost?.(host);
    if (problem) {
      return { id, code: "PROVIDER_HOST_REFUSED", message: problem };
    }
  }
  return null;
}

/**
 * Every host a row sends a secret to: an API-key provider's `hosts`; an
 * OAuth provider's API hosts (the token), and its authorize, token and
 * revoke hosts (the client). Each passes the row host rules.
 */
export function registrableHosts(capability: RegistrableCapability): string[] {
  if (capability.mode === "api_key") return [...capability.hosts];
  if (capability.mode === "ai")
    return [new URL(capability.origin).hostname.toLowerCase()];
  const hosts = [...capability.api];
  const urls = [
    capability.authorize.url,
    capability.flow?.tokenUrl,
    capability.flow?.revokeUrl,
    capability.flow?.identity?.url,
  ];
  for (const url of urls) {
    if (!url) continue;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!hosts.includes(host)) hosts.push(host);
    } catch {
      // The parser refused it already.
    }
  }
  return hosts;
}

/** A row's spec parsed and checked: the capability, or the refusal. */
export function resolveProviderRow(
  row: ProviderRow,
  context: {
    rowSettings: ReadonlySet<string>;
    refuseHost?: (host: string) => string | null;
  },
):
  | { ok: true; capability: RegistrableCapability }
  | { ok: false; refusal: RowRefusal } {
  let spec: unknown = row.spec;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch {
      return {
        ok: false,
        refusal: {
          id: row.id,
          code: "PROVIDER_SPEC_INVALID",
          message: "the stored spec isn't JSON",
        },
      };
    }
  }
  const parsed = parseProviderSpec(spec);
  if (!parsed.ok) {
    return {
      ok: false,
      refusal: {
        id: row.id,
        code: "PROVIDER_SPEC_INVALID",
        message: describeSpecProblems(parsed.problems),
      },
    };
  }
  if (parsed.id !== row.id || !PROVIDER_ID.test(row.id)) {
    return {
      ok: false,
      refusal: {
        id: row.id,
        code: "PROVIDER_SPEC_INVALID",
        message: `the row is ${row.id} but its spec says ${parsed.id}`,
      },
    };
  }
  const refusal = checkProviderRow(parsed.id, parsed.capability, context);
  return refusal
    ? { ok: false, refusal }
    : { ok: true, capability: parsed.capability };
}

/**
 * The built-in OAuth client an overlay may extend: a catalog entry of mode
 * `oauth_client` with a scope policy. Null for anything else (an API-key
 * entry, a client without sets, a registered row, an unknown id).
 */
export function overlayableClient(
  providerId: string,
): OAuthClientCapability | null {
  if (!CAPABILITY_IDS.includes(providerId as never)) return null;
  const capability = CAPABILITIES[
    providerId as keyof typeof CAPABILITIES
  ] as Capability;
  return capability.mode === "oauth_client" && capability.scopePolicy
    ? capability
    : null;
}

/** An overlay row's spec parsed and checked against its client: the set, or the refusal. */
export function resolveScopeSetRow(
  row: ScopeSetRow,
): { ok: true; set: OAuthScopeSet } | { ok: false; refusal: ScopeSetRefusal } {
  const refuse = (code: ScopeSetRefusalCode, message: string) => ({
    ok: false as const,
    refusal: { providerId: row.providerId, name: row.name, code, message },
  });
  const client = overlayableClient(row.providerId);
  if (!client) {
    return refuse(
      "SCOPE_SET_PROVIDER_UNKNOWN",
      `${row.providerId} isn't a built-in OAuth client with scope sets (google-workspace, microsoft-365, slack); a registered provider's sets are in its spec`,
    );
  }
  if (Object.hasOwn(client.scopePolicy!.sets, row.name)) {
    return refuse(
      "SCOPE_SET_BUILTIN",
      `${row.name} is one of ${row.providerId}'s own sets; an overlay adds a set, never replaces one`,
    );
  }
  let spec: unknown = row.spec;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch {
      return refuse("SCOPE_SET_INVALID", "the stored spec isn't JSON");
    }
  }
  const parsed = parseScopeSetOverlay(
    typeof spec === "object" && spec !== null && !Array.isArray(spec)
      ? { ...(spec as Record<string, unknown>), name: row.name }
      : spec,
    { id: row.providerId, capability: client },
  );
  if (!parsed.ok) {
    return refuse("SCOPE_SET_INVALID", describeSpecProblems(parsed.problems));
  }
  return { ok: true, set: parsed.set };
}

/**
 * The catalog and `rows` as one registry. Rows are taken in order; a row
 * whose settings another earlier row holds is the one refused.
 */
export function providerRegistry(
  rows: readonly ProviderRow[] = [],
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  const catalog = new Map<string, Capability>(
    CAPABILITY_IDS.map((id) => [id, CAPABILITIES[id] as Capability]),
  );
  // Scope-set overlays on the catalog's OAuth clients, before any row is
  // looked at: a row never shadows the catalog, with or without overlays.
  const overlays: RegisteredScopeSet[] = [];
  const rejectedScopeSets: ScopeSetRefusal[] = [];
  const overlaySets = new Map<string, Record<string, OAuthScopeSet>>();
  for (const row of options.scopeSets ?? []) {
    if (
      overlays.some(
        (each) => each.providerId === row.providerId && each.name === row.name,
      )
    ) {
      rejectedScopeSets.push({
        providerId: row.providerId,
        name: row.name,
        code: "SCOPE_SET_INVALID",
        message: "listed twice",
      });
      continue;
    }
    const resolved = resolveScopeSetRow(row);
    if (!resolved.ok) {
      rejectedScopeSets.push(resolved.refusal);
      continue;
    }
    overlays.push({
      providerId: row.providerId,
      name: row.name,
      set: resolved.set,
      addedBy: row.addedBy ?? null,
      addedAt: row.addedAt ?? null,
    });
    const sets = overlaySets.get(row.providerId) ?? {};
    sets[row.name] = resolved.set;
    overlaySets.set(row.providerId, sets);
  }
  for (const [id, sets] of overlaySets) {
    const client = catalog.get(id);
    if (client?.mode === "oauth_client") {
      catalog.set(id, withScopeSets(client, sets));
    }
  }
  const accepted = new Map<string, RegisteredProvider>();
  const rejected: RowRefusal[] = [];
  const rowSettings = new Set<string>();
  for (const row of rows) {
    if (accepted.has(row.id)) {
      rejected.push({
        id: row.id,
        code: "PROVIDER_SPEC_INVALID",
        message: "listed twice",
      });
      continue;
    }
    const resolved = resolveProviderRow(row, {
      rowSettings,
      ...(options.refuseHost ? { refuseHost: options.refuseHost } : {}),
    });
    if (!resolved.ok) {
      rejected.push(resolved.refusal);
      continue;
    }
    accepted.set(row.id, {
      id: row.id,
      capability: resolved.capability,
      bound: row.boundTo === providerBindingKey(resolved.capability),
      addedBy: row.addedBy ?? null,
      addedAt: row.addedAt ?? null,
    });
    for (const name of capabilitySettings(resolved.capability)) {
      rowSettings.add(name);
    }
  }
  const all = new Map<string, Capability>([
    ...catalog,
    ...[...accepted.values()].map(
      (row) => [row.id, row.capability] as [string, Capability],
    ),
  ]);
  let names: Set<string> | undefined;
  let unbound: Set<string> | undefined;
  return {
    get: (id) => all.get(id),
    ids: () => [...all.keys()],
    entries: () => [...all.entries()],
    sourceOf: (id) =>
      catalog.has(id) ? "catalog" : accepted.has(id) ? "row" : undefined,
    settingNames: () => {
      names ??= new Set(
        [...all.values()].flatMap((capability) =>
          capabilitySettings(capability),
        ),
      );
      return names;
    },
    bound: (id) => catalog.has(id) || (accepted.get(id)?.bound ?? false),
    unboundSettings: () => {
      unbound ??= new Set(
        [...accepted.values()]
          .filter((row) => !row.bound)
          .flatMap((row) => capabilitySettings(row.capability)),
      );
      return unbound;
    },
    rows: () => [...accepted.values()],
    rejected,
    scopeSets: () => [...overlays],
    scopeSetSource: (providerId, name) => {
      if (
        overlays.some(
          (each) => each.providerId === providerId && each.name === name,
        )
      ) {
        return "row";
      }
      const capability = CAPABILITY_IDS.includes(providerId as never)
        ? (CAPABILITIES[providerId as keyof typeof CAPABILITIES] as Capability)
        : undefined;
      return capability?.mode === "oauth_client" &&
        capability.scopePolicy &&
        Object.hasOwn(capability.scopePolicy.sets, name)
        ? "catalog"
        : undefined;
    },
    rejectedScopeSets,
  };
}

/** The catalog alone, as a registry: what every surface reads without a gateway's rows. */
export const BUILTIN_PROVIDERS: ProviderRegistry = providerRegistry();
