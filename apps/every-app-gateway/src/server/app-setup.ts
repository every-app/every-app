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
  evaluateAppSettings,
  type AppSetting,
  type AppSettingsReport,
  type AppSetup,
  PROVIDER_APP_TIER,
} from "@every-app/sdk/internal";

/** How an operator runs everyapp while publishing is paused. */
export const SETUP_CLI = "pnpm everyapp";

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
}

const defaultDeps: AppSetupDeps = {
  settings: env as unknown as Readonly<Record<string, unknown>>,
  emailConfigured: async () =>
    (await import("@/server/email/sendEmail")).isEmailConfigured(),
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

function parsedManifest(manifest: unknown): Record<string, unknown> | null {
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
): (holder: AppSetting["holder"], name: string) => boolean | null {
  return (holder, name) => {
    if (holder === "app") {
      return secretNames === null ? null : secretNames.includes(name);
    }
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
  const settings = appSettings(manifest);
  if (settings.length === 0) return null;
  const key = cacheKey(input);
  const cached = reports.get(key);
  if (cached) return cached;
  const listsEmail = settings.some(
    (setting) => setting.kind === "capability" && setting.id === "email",
  );
  const emailConfigured = listsEmail ? await deps.emailConfigured() : undefined;
  const report = evaluateAppSettings(
    settings,
    isSetOn(deps, input.secretNames),
    {
      readiness: (setting) =>
        setting.kind === "capability" && setting.id === "email"
          ? emailConfigured
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
