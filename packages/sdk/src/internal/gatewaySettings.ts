/**
 * The Gateway's settings and the app's own secrets, by name: the Gateway
 * settings an operator changes with `everyapp secret set <NAME>` (plain
 * secrets on the Gateway Worker, read on its next request), the ones the
 * install writes once, and the names an app's own secret can never take.
 * What an app's manifest needs of them is appSettings.ts. One registry serves
 * the CLI (a Gateway name goes to the Gateway, any other to the app in the
 * current directory), the manifest validator (an app's `secrets` may not
 * take a Gateway name, since the app reaches those through `providers` and
 * `capabilities`) and the Gateway's dev config, which a test keeps
 * declaring every settable one.
 */
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
  type Capability,
  type CapabilitySecret,
} from "./capabilities.js";
import {
  PLAIN_SIGN_IN_SETTINGS,
  SIGN_IN_GATEWAY_SETTINGS,
} from "./signInProviders.js";

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

/**
 * The settings the catalog's providers read (the AI providers' keys, the
 * API-key providers' keys and hosts, the OAuth clients), in catalog order, the install's own left out: what `everyapp
 * secret set` accepts because a provider reads it. A gateway's registered
 * rows add theirs at run time (providerRegistry.settingNames()).
 */
const PROVIDER_GATEWAY_SETTINGS: readonly string[] = [
  ...new Set(
    CAPABILITY_IDS.flatMap((id) => {
      const capability = CAPABILITIES[id];
      return capability.mode === "service"
        ? []
        : capabilitySettings(capability);
    }),
  ),
].filter((name) => !INSTALL_OWNED.has(name));

/** The Gateway's own optional settings `everyapp secret set` changes: nothing a provider reads. */
export const GATEWAY_OWN_SETTINGS = [
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
  // Self-hosted Gateway app installs: off unless exactly "on" (everyapp deploy-token add).
  "BROWSER_APP_INSTALLS",
  "DISPATCH_NAMESPACE",
  "THIRD_PARTY_DOMAIN",
  // "true" lets event webhooks target http: and private hosts (self-host only).
  "EVENTS_ALLOW_PRIVATE_TARGETS",
] as const;

export type SettableGatewaySetting =
  | Exclude<CapabilitySecret, (typeof INSTALL_OWNED_GATEWAY_SETTINGS)[number]>
  | (typeof GATEWAY_OWN_SETTINGS)[number];

/**
 * The Gateway's optional settings `everyapp secret set` changes: every
 * setting a catalog provider reads, the Gateway's own, then the sign-in
 * providers' (`<ID>_SIGNIN_<FIELD>`, ./signInProviders.ts).
 */
export const SETTABLE_GATEWAY_SETTINGS: readonly SettableGatewaySetting[] = [
  ...(PROVIDER_GATEWAY_SETTINGS as readonly SettableGatewaySetting[]),
  ...GATEWAY_OWN_SETTINGS,
  ...(SIGN_IN_GATEWAY_SETTINGS as readonly SettableGatewaySetting[]),
];

const SETTABLE: ReadonlySet<string> = new Set(SETTABLE_GATEWAY_SETTINGS);

/**
 * The credential names of remote MCP apps (`everyapp mcp add <url>`,
 * ./remoteMcp.ts): `<ID>_MCP_TOKEN` by default, any name ending in
 * `_MCP_TOKEN` by choice. A family rather than a list, so the names a
 * registry row declares at run time route to the Gateway like the fixed
 * names (`everyapp secret set` reads no registry to decide), an app's own
 * secret can never take one (the manifest validator refuses the family),
 * and a remote server can never be given a fixed provider key.
 */
export const REMOTE_MCP_SECRET_PATTERN = /^[A-Z][A-Z0-9_]*_MCP_TOKEN$/;

/** Whether `name` is a remote MCP app's credential name (`TREG_MCP_TOKEN`). */
export function isRemoteMcpSecretName(name: string): boolean {
  return REMOTE_MCP_SECRET_PATTERN.test(name);
}

/**
 * Whether `everyapp secret set <name>` changes the Gateway: one of the
 * fixed settings, or a remote MCP app's credential name.
 */
export function isSettableGatewaySetting(name: string): boolean {
  return SETTABLE.has(name) || isRemoteMcpSecretName(name);
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
  "EVENTS_ALLOW_PRIVATE_TARGETS",
] as const satisfies readonly SettableGatewaySetting[];

const PLAIN: ReadonlySet<string> = new Set([
  ...PLAIN_GATEWAY_SETTINGS,
  // The sign-in providers' ids, issuer, label and tenant; their client
  // secrets are credentials.
  ...PLAIN_SIGN_IN_SETTINGS,
]);

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

/** Gateway settings for local testing only, set in the gateway's `.dev.vars`, never deployed. */
export const DEV_ONLY_GATEWAY_SETTINGS = [
  "MCP_ACCESS_TOKEN_TTL",
  // "true" sends the DataForSEO provider app's calls to the free sandbox.
  "DATAFORSEO_SANDBOX",
] as const;

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
  for (const id of CAPABILITY_IDS) {
    const capability = CAPABILITIES[id];
    if (capabilitySettings(capability).includes(name)) {
      return { kind: capability.mode === "ai" ? "provider" : "capability", id };
    }
  }
  return null;
}
