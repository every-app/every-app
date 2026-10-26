/**
 * Whether an app has what it needs set, as the gateway sees it: its
 * manifest's providers, capabilities and secrets (the settings model,
 * `@every-app/sdk/internal` appSettings) against this Worker's own env
 * (the Gateway settings) and the secret names the CLI recorded on the
 * app's row (`apps.secret_names`). The app lists (`getMyApps`, Admin →
 * Apps) show it as "Needs setup" with the one command that opens it; the
 * perimeter refuses to open an app that isn't ready; the gateway's `/mcp`
 * leaves its tools out.
 *
 * Nothing here calls out. Email counts as configured by the gateway's own
 * rule (a sender that parses and a provider that is selectable), not by
 * its setting names alone. A dispatch-tier app isn't evaluated: its
 * providers and capabilities ride the platform's settings, which the
 * platform checks at deploy, not here.
 */
import { env } from "cloudflare:workers";
import {
  appSettings,
  appSetupOf,
  BUILTIN_PROVIDERS,
  CATALOG,
  evaluateAppSettings,
  providerIds,
  type AppSetting,
  type AppSettingsReport,
  type AppSetup,
  type ProviderRegistry,
  PROVIDER_APP_TIER,
  remoteMcpOf,
} from "@every-app/sdk/internal";

import { SETUP_CLI } from "@/server/setup-cli";

export { SETUP_CLI };

export interface AppSetupInput {
  /** The row's id, the version it runs and its recorded secret names: the cache key. */
  rowId: string;
  versionId: string | null;
  /** Parsed, or null when never recorded. */
  secretNames: string[] | null;
  appId: string;
  tier: string;
  /** The stored manifest: parsed, or its JSON. */
  manifest: unknown;
  /**
   * Whether whoever reads this can run the command: the app is their
   * organization's (a shared app seen from another organization is the
   * platform's to fix).
   */
  canFix: boolean;
}

export interface AppSetupDeps {
  /** The Gateway's settings by name (its env). */
  settings: Readonly<Record<string, unknown>>;
  /** The gateway's own email rule, read only for an app that lists email. */
  emailConfigured: () => Promise<boolean>;
  /**
   * Where a provider id is found: the catalog and this gateway's
   * registered providers (server/providers), whose unbound rows' settings
   * read as unset however the env holds them.
   */
  providers: () => Promise<ProviderRegistry>;
  /**
   * A remote MCP app's credential rule (server/remote-mcp/bind.ts): set,
   * and bound to the row's origin. Read only for a row with a `remote`
   * block; `undefined` leaves it to the names.
   */
  remoteMcpReady?: (
    manifest: Record<string, unknown>,
    rowId: string,
  ) => Promise<boolean | undefined>;
}

const defaultDeps: AppSetupDeps = {
  settings: env as unknown as Readonly<Record<string, unknown>>,
  emailConfigured: async () =>
    (await import("@/server/email/sendEmail")).isEmailConfigured(),
  providers: async () =>
    (await import("@/server/providers")).gatewayProviders(),
  remoteMcpReady: async (manifest, rowId) => {
    const remote = remoteMcpOf(manifest);
    if (!remote) return undefined;
    const { credentialFor } = await import("@/server/remote-mcp/bind");
    const state = await credentialFor(remote, rowId);
    return state.kind === "ready" || state.kind === "none";
  },
};

const REPORTS_MAX_ENTRIES = 500;
/** Per isolate, by row, version and recorded names: env changes mean a new version and fresh isolates. */
const reports = new Map<string, AppSettingsReport>();

export function resetAppSetupCacheForTests(): void {
  reports.clear();
}

function cacheKey(input: AppSetupInput): string {
  const names =
    input.secretNames === null
      ? "?"
      : JSON.stringify([...input.secretNames].sort());
  return `${input.rowId}\0${input.versionId ?? ""}\0${names}`;
}

function remember(key: string, report: AppSettingsReport): void {
  reports.delete(key);
  reports.set(key, report);
  if (reports.size > REPORTS_MAX_ENTRIES) {
    const oldest = reports.keys().next().value;
    if (oldest !== undefined) reports.delete(oldest);
  }
}

/**
 * What of the registry the report depends on: the registered providers
 * the manifest names, each with whether it is bound. A manifest naming no
 * registered provider keys as before.
 */
function registryKey(
  registry: ProviderRegistry,
  settings: readonly AppSetting[],
): string {
  return settings
    .filter(
      (setting) =>
        setting.holder === "gateway" && registry.sourceOf(setting.id) === "row",
    )
    .map((setting) => `${setting.id}=${registry.bound(setting.id) ? 1 : 0}`)
    .join(",");
}

/** Whether the manifest lists a provider or capability id the catalog doesn't have. */
function namesOutsideCatalog(manifest: Record<string, unknown>): boolean {
  const ids = [
    ...providerIds(manifest as Parameters<typeof providerIds>[0]),
    ...Object.keys(
      (manifest["capabilities"] as Record<string, unknown> | undefined) ?? {},
    ),
  ];
  return ids.some((id) => !CATALOG.get(id));
}

/** A stored manifest as an object: parsed from its JSON, or null when it is neither. */
export function parsedManifest(
  manifest: unknown,
): Record<string, unknown> | null {
  if (typeof manifest === "string") {
    try {
      return parsedManifest(JSON.parse(manifest));
    } catch {
      return null;
    }
  }
  return manifest && typeof manifest === "object"
    ? (manifest as Record<string, unknown>)
    : null;
}

function isSetOn(
  deps: AppSetupDeps,
  secretNames: string[] | null,
  unbound: ReadonlySet<string>,
): (holder: AppSetting["holder"], name: string) => boolean | null {
  return (holder, name) => {
    if (holder === "app") {
      return secretNames === null ? null : secretNames.includes(name);
    }
    // A registered provider's setting counts only while its key was set
    // for the hosts the provider has now (providers.value-bound-to-hosts).
    if (unbound.has(name)) return false;
    const value = deps.settings[name];
    return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
  };
}

/**
 * The app's settings report: null when the manifest declares nothing to
 * set (or can't be read), or the app is on the dispatch tier.
 */
export async function appSettingsReport(
  input: AppSetupInput,
  deps: AppSetupDeps = defaultDeps,
): Promise<AppSettingsReport | null> {
  if (input.tier === "dispatch") return null;
  const manifest = parsedManifest(input.manifest);
  if (!manifest) return null;
  // The registered rows are read only for a manifest that names an id the
  // catalog doesn't have (one D1 read, cached 30 s per isolate), before
  // the report cache, since a provider added, replaced or bound since
  // changes what the manifest needs. Every other app costs nothing here.
  const registry = namesOutsideCatalog(manifest)
    ? await deps.providers()
    : BUILTIN_PROVIDERS;
  const settings = appSettings(manifest, registry);
  if (settings.length === 0) return null;
  // A remote MCP app's row keeps its id across a remove and an add
  // (revived), and its version is null: its registration's revision keys
  // the cache instead.
  const remoteRev = remoteMcpOf(manifest)?.rev;
  const key = `${cacheKey(input)}\0${remoteRev ?? ""}\0${registryKey(registry, settings)}`;
  const cached = reports.get(key);
  if (cached) return cached;
  const listsEmail = settings.some(
    (setting) => setting.kind === "capability" && setting.id === "email",
  );
  const emailConfigured = listsEmail ? await deps.emailConfigured() : undefined;
  const listsRemote = settings.some((setting) => setting.kind === "remote-mcp");
  const remoteReady =
    listsRemote && deps.remoteMcpReady
      ? await deps.remoteMcpReady(manifest, input.rowId)
      : undefined;
  const report = evaluateAppSettings(
    settings,
    isSetOn(deps, input.secretNames, registry.unboundSettings()),
    {
      readiness: (setting) =>
        setting.kind === "capability" && setting.id === "email"
          ? emailConfigured
          : setting.kind === "remote-mcp"
            ? remoteReady
            : undefined,
    },
  );
  remember(key, report);
  return report;
}

/**
 * The app's setup as the app lists carry it (`setup`): null when there is
 * nothing to set. The command is left out for a reader who can't run it.
 */
export async function appSetupFor(
  input: AppSetupInput,
  deps: AppSetupDeps = defaultDeps,
): Promise<AppSetup | null> {
  const report = await appSettingsReport(input, deps);
  if (!report) return null;
  return appSetupOf(report, {
    cli: SETUP_CLI,
    appId: input.appId,
    withCommand: input.canFix,
    // A provider app has no Worker and no directory: its key is set by name.
    provider: input.tier === PROVIDER_APP_TIER,
  });
}

/** Whether the app opens: ready, or nothing to check. */
export async function appIsReady(
  input: AppSetupInput,
  deps: AppSetupDeps = defaultDeps,
): Promise<boolean> {
  const report = await appSettingsReport(input, deps);
  return report?.ready ?? true;
}
