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
 */
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
  type ApiKeyCapability,
  type Capability,
  type CapabilityLookup,
} from "./capabilities.js";
import {
  isDevOnlyGatewaySetting,
  isInstallOwnedGatewaySetting,
  isReservedAppSecretName,
  isSettableGatewaySetting,
} from "./gatewaySettings.js";
import {
  describeSpecProblems,
  parseProviderSpec,
  PROVIDER_ID,
} from "./providerSpec.js";

/** A `providers` row as the gateway or the CLI read it. */
export interface ProviderRow {
  id: string;
  /** The spec, as JSON text or already parsed. */
  spec: unknown;
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
  /** The rows this registry left out, each with why. */
  readonly rejected: readonly RowRefusal[];
}

export interface ProviderRegistryOptions {
  /**
   * A host no row may name on this gateway, with why: the gateway's own
   * host and anything under its apps' base domain. The pure rules refuse
   * the rest (IP literals, localhost, `.internal`).
   */
  refuseHost?: (host: string) => string | null;
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
  capability: ApiKeyCapability,
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
  for (const host of capability.hosts) {
    const problem = publicHostProblem(host) ?? context.refuseHost?.(host);
    if (problem) {
      return { id, code: "PROVIDER_HOST_REFUSED", message: problem };
    }
  }
  return null;
}

/** A row's spec parsed and checked: the capability, or the refusal. */
export function resolveProviderRow(
  row: ProviderRow,
  context: {
    rowSettings: ReadonlySet<string>;
    refuseHost?: (host: string) => string | null;
  },
):
  | { ok: true; capability: ApiKeyCapability }
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
  const accepted = new Map<string, ApiKeyCapability>();
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
    accepted.set(row.id, resolved.capability);
    for (const name of capabilitySettings(resolved.capability)) {
      rowSettings.add(name);
    }
  }
  const all = new Map<string, Capability>([...catalog, ...accepted]);
  let names: Set<string> | undefined;
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
    rejected,
  };
}

/** The catalog alone, as a registry: what every surface reads without a gateway's rows. */
export const BUILTIN_PROVIDERS: ProviderRegistry = providerRegistry();
