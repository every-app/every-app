/**
 * The Gateway's settings and the app's own secrets, by name: the Gateway
 * settings an operator changes with `everyapp secret set <NAME>` (plain
 * secrets on the Gateway Worker, read on its next request), the ones the
 * install writes once, which of the first kind an app's manifest needs,
 * and the names an app's own secret can never take. One registry serves
 * the CLI (a Gateway name goes to the Gateway, any other to the app in the
 * current directory), the manifest validator (an app's `secrets` may not
 * take a Gateway name, since the app reaches those through `providers` and
 * `capabilities`) and the Gateway's dev config, which a test keeps
 * declaring every settable one.
 */
import {
  aiProviderSettings,
  DEV_AI_PROVIDERS,
  devAiProvider,
} from "./aiProviders.js";
import {
  CAPABILITIES,
  capabilitySettings,
  isCapabilityId,
  type Capability,
} from "./capabilities.js";

/** The Gateway's optional settings `everyapp secret set` changes. */
export const SETTABLE_GATEWAY_SETTINGS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  // Workers AI's API token; its account is the install's CLOUDFLARE_ACCOUNT_ID.
  "WORKERS_AI_API_TOKEN",
  "DATAFORSEO_API_KEY",
  "CONTEXT_API_KEY",
  // Social networks' OAuth clients, and the Mastodon instance's URL.
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "FACEBOOK_APP_ID",
  "FACEBOOK_APP_SECRET",
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "THREADS_APP_ID",
  "THREADS_APP_SECRET",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "TIKTOK_CLIENT_ID",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_BUSINESS_CLIENT_ID",
  "TIKTOK_BUSINESS_CLIENT_SECRET",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "PINTEREST_CLIENT_ID",
  "PINTEREST_CLIENT_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "MASTODON_CLIENT_ID",
  "MASTODON_CLIENT_SECRET",
  "MASTODON_URL",
  "KICK_CLIENT_ID",
  "KICK_CLIENT_SECRET",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TUMBLR_CLIENT_ID",
  "TUMBLR_CLIENT_SECRET",
  "DRIBBBLE_CLIENT_ID",
  "DRIBBBLE_CLIENT_SECRET",
  // Mail and calendar clients.
  "GOOGLE_WORKSPACE_CLIENT_ID",
  "GOOGLE_WORKSPACE_CLIENT_SECRET",
  "MICROSOFT_365_CLIENT_ID",
  "MICROSOFT_365_CLIENT_SECRET",
  "AI_PROXY_EXTRA_ROUTES",
  // Email's providers: Cloudflare's REST token, Resend's key, the choice.
  "EMAIL_REST_API_TOKEN",
  "RESEND_API_KEY",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "MCP_OAUTH_ENABLED",
  "MCP_DCR_ENABLED",
  "MCP_ALLOWED_ORIGINS",
  "MCP_AUDIT_RETENTION_DAYS",
  "CLOUDFLARE_ACCESS_OIDC_ISSUER",
  "CLOUDFLARE_ACCESS_OIDC_CLIENT_ID",
  "CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET",
  "CLOUDFLARE_ACCESS_OIDC_LABEL",
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CLOUDFLARE_ACCESS_AUD",
  "CLOUDFLARE_ACCESS_APPS_AUD",
  "CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS",
  "CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN",
  "EMAIL_PASSWORD_SIGN_IN",
  // "false" keeps the hosted gateway's sign-up invite-only.
  "HOSTED_OPEN_SIGNUP",
  // Release deployers and the hosted third-party domain. The hosted launch
  // gate, THIRD_PARTY_DEPLOYS, is never set from here: it is opened by
  // hand once the launch checks pass (docs/runbooks/hosted-install.md).
  "CF_DEPLOY_TOKEN",
  // Self-hosted browser installs are on by default; "off" opts out.
  "BROWSER_APP_INSTALLS",
  "DISPATCH_NAMESPACE",
  "THIRD_PARTY_DOMAIN",
] as const;

export type SettableGatewaySetting = (typeof SETTABLE_GATEWAY_SETTINGS)[number];

const SETTABLE: ReadonlySet<string> = new Set(SETTABLE_GATEWAY_SETTINGS);

/** Whether `everyapp secret set <name>` changes the Gateway. */
export function isSettableGatewaySetting(
  name: string,
): name is SettableGatewaySetting {
  return SETTABLE.has(name);
}

/**
 * Settable Gateway settings whose value is a plain word, address, list
 * or switch rather than a credential: a sender, a provider choice, a
 * URL, an audience, a flag. `everyapp secret set` may show these as they
 * are typed and check their shape; anything else is a credential and
 * stays hidden.
 */
export const PLAIN_GATEWAY_SETTINGS = [
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "EMAIL_PROVIDER",
  "EMAIL_PASSWORD_SIGN_IN",
  "MASTODON_URL",
  "AI_PROXY_EXTRA_ROUTES",
  "MCP_OAUTH_ENABLED",
  "MCP_DCR_ENABLED",
  "MCP_ALLOWED_ORIGINS",
  "MCP_AUDIT_RETENTION_DAYS",
  "CLOUDFLARE_ACCESS_OIDC_ISSUER",
  "CLOUDFLARE_ACCESS_OIDC_CLIENT_ID",
  "CLOUDFLARE_ACCESS_OIDC_LABEL",
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CLOUDFLARE_ACCESS_AUD",
  "CLOUDFLARE_ACCESS_APPS_AUD",
  "CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS",
  "CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN",
  "HOSTED_OPEN_SIGNUP",
  "BROWSER_APP_INSTALLS",
  "DISPATCH_NAMESPACE",
  "THIRD_PARTY_DOMAIN",
] as const satisfies readonly SettableGatewaySetting[];

const PLAIN: ReadonlySet<string> = new Set(PLAIN_GATEWAY_SETTINGS);

/** Whether a settable Gateway setting's value is a plain value, not a credential. */
export function isPlainGatewaySetting(name: string): boolean {
  return PLAIN.has(name);
}

/**
 * Settable Gateway settings only the hosted gateway reads: a self-hosted
 * install never needs them, so `secret list` leaves them out there.
 */
export const HOSTED_ONLY_GATEWAY_SETTINGS = [
  "HOSTED_OPEN_SIGNUP",
  "DISPATCH_NAMESPACE",
  "THIRD_PARTY_DOMAIN",
] as const satisfies readonly SettableGatewaySetting[];

const HOSTED_ONLY: ReadonlySet<string> = new Set(HOSTED_ONLY_GATEWAY_SETTINGS);

export function isHostedOnlyGatewaySetting(name: string): boolean {
  return HOSTED_ONLY.has(name);
}

/**
 * The Gateway's own settings: the install writes them once (`everyapp
 * setup`), or an operator by hand (THIRD_PARTY_DEPLOYS), and `everyapp
 * secret set` never changes them. An app's own Worker may still have a
 * secret of the same name (OpenSEO's BETTER_AUTH_SECRET): the two never meet.
 */
export const INSTALL_OWNED_GATEWAY_SETTINGS = [
  "GATEWAY_URL",
  "APP_BASE_DOMAIN",
  "BETTER_AUTH_SECRET",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "GATEWAY_DEPLOYMENT_MODE",
  "CLOUDFLARE_ACCOUNT_ID",
  "THIRD_PARTY_DEPLOYS",
] as const;

const INSTALL_OWNED: ReadonlySet<string> = new Set(
  INSTALL_OWNED_GATEWAY_SETTINGS,
);

export function isInstallOwnedGatewaySetting(name: string): boolean {
  return INSTALL_OWNED.has(name);
}

/** Gateway settings for local testing only, set in the gateway's `.dev.vars`, never deployed. */
export const DEV_ONLY_GATEWAY_SETTINGS = ["MCP_ACCESS_TOKEN_TTL"] as const;

export function isDevOnlyGatewaySetting(name: string): boolean {
  return (DEV_ONLY_GATEWAY_SETTINGS as readonly string[]).includes(name);
}

/**
 * Names an app's own secret can't take: the deploy sets GATEWAY_URL on
 * every Worker and builds in the identity settings, the gateway binding
 * and the platform's own namespaces. Checked without regard to case. The
 * SDK's `everyAppWorker()` keeps the same rule as a regex (its config
 * module can't import this one); a test keeps them in step.
 */
const RESERVED_APP_SECRET_NAMES: ReadonlySet<string> = new Set([
  "GATEWAY_URL",
  "CF_VERSION_METADATA",
]);
const RESERVED_APP_SECRET_PREFIXES = [
  "EVERYAPP_",
  "EVERY_APP_",
  "APP__",
] as const;

/** What the reserved names are, for messages. */
export const RESERVED_APP_SECRET_NAMES_TEXT =
  "GATEWAY_URL, CF_VERSION_METADATA and the EVERYAPP_*, EVERY_APP_* and APP__* names";

export function isReservedAppSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RESERVED_APP_SECRET_NAMES.has(upper) ||
    RESERVED_APP_SECRET_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/** Which AI provider or capability reads a Gateway setting, if any does. */
export type GatewaySettingOwner =
  | { kind: "provider"; id: string }
  | { kind: "capability"; id: string };

/**
 * The AI provider or capability a Gateway setting belongs to: what to list
 * in a manifest instead of holding the key as the app's own.
 */
export function gatewaySettingOwner(name: string): GatewaySettingOwner | null {
  for (const [id, spec] of Object.entries(DEV_AI_PROVIDERS)) {
    if (aiProviderSettings(spec).includes(name))
      return { kind: "provider", id };
  }
  for (const [id, capability] of Object.entries(CAPABILITIES)) {
    if (capabilitySettings(capability).includes(name)) {
      return { kind: "capability", id };
    }
  }
  return null;
}

/** One Gateway setting an app's manifest needs, and whether it can do without. */
export interface GatewaySettingNeed {
  name: SettableGatewaySetting;
  /**
   * Required: an AI provider's key, an `api_key` capability's key, an OAuth
   * client's id and secret, a service's `settings`, and the AI proxy's extra
   * routes when the manifest asks for any. Optional: a service's
   * `optionalSettings` (another transport) and a host setting with a default.
   */
  required: boolean;
}

/**
 * The settable Gateway settings an app's manifest needs: the keys of its
 * AI `providers`, the keys, clients, senders and transports of its
 * `capabilities`, and AI_PROXY_EXTRA_ROUTES when `ai.routes` asks for
 * paths beyond inference; in the manifest's order, each once (required
 * wins). Settings the install owns (Workers AI's and email's
 * CLOUDFLARE_ACCOUNT_ID) are left out: they are set already. An unknown
 * provider or capability contributes nothing; the manifest validator
 * refuses it elsewhere.
 */
export function gatewaySettingsFor(manifest: {
  readonly providers?: ReadonlyArray<string | { readonly id: string }>;
  readonly capabilities?: { readonly [id: string]: unknown };
  readonly ai?: { readonly routes?: readonly string[] };
}): GatewaySettingNeed[] {
  const needs: Array<{ name: string; required: boolean }> = [];
  for (const entry of manifest.providers ?? []) {
    // A provider is listed by id, or as an entry with its need (appSettings.ts).
    const spec = devAiProvider(typeof entry === "string" ? entry : entry.id);
    if (!spec) continue;
    for (const name of aiProviderSettings(spec))
      needs.push({ name, required: true });
  }
  for (const id of Object.keys(manifest.capabilities ?? {})) {
    if (!isCapabilityId(id)) continue;
    const capability: Capability = CAPABILITIES[id];
    switch (capability.mode) {
      case "api_key":
        needs.push({ name: capability.secret, required: true });
        break;
      case "service":
        for (const name of capability.settings)
          needs.push({ name, required: true });
        for (const name of capability.optionalSettings) {
          needs.push({ name, required: false });
        }
        break;
      case "oauth_client":
        needs.push({ name: capability.secrets.clientId, required: true });
        if (capability.secrets.clientSecret) {
          needs.push({ name: capability.secrets.clientSecret, required: true });
        }
        if (capability.hostSetting) {
          needs.push({
            name: capability.hostSetting,
            required: !capability.defaultOrigin,
          });
        }
        break;
    }
  }
  if (manifest.ai?.routes?.length) {
    needs.push({ name: "AI_PROXY_EXTRA_ROUTES", required: true });
  }
  const byName = new Map<string, GatewaySettingNeed>();
  for (const need of needs) {
    if (!isSettableGatewaySetting(need.name)) continue;
    const seen = byName.get(need.name);
    if (seen) seen.required ||= need.required;
    else byName.set(need.name, { name: need.name, required: need.required });
  }
  return [...byName.values()];
}
