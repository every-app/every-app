/**
 * The sign-in providers a Gateway can offer beside passwords ("Continue
 * with Google"), as data: what each one is called, the Worker secrets it
 * reads, where the OAuth app is made, the scopes asked for and which claim
 * becomes the email. One catalog serves the Gateway (which providers are
 * on, the sign-in page's buttons, Manage workspace → Sign-in), the CLI
 * (`everyapp signin add|list|show|remove`, `secret set`), the manifest
 * validator (an app's own secret can never take one of these names) and
 * the docs' drift tests.
 *
 * Naming rule, agreed with the provider registry's conventions
 * (docs/design/2026-10-provider-registry.md, section 6): a sign-in
 * provider's settings are `<ID>_SIGNIN_<FIELD>`, with FIELD one of
 * CLIENT_ID, CLIENT_SECRET, ISSUER, LABEL or TENANT. The `_SIGNIN_` infix is
 * what keeps the family apart from the API providers' `<ID>_API_KEY`,
 * `<ID>_CLIENT_ID` (the OAuth clients the Gateway holds for apps) and the
 * MCP apps' `<ID>_MCP_TOKEN`: `GOOGLE_SIGNIN_CLIENT_ID` is the sign-in
 * provider's, `GOOGLE_WORKSPACE_CLIENT_ID` the OAuth client apps use, and
 * a registered provider row or an app manifest can never claim a name in
 * the family (isSignInSettingName).
 *
 * The settings are Worker secrets, set under the Cloudflare login (`everyapp
 * signin add`, or `secret set`), never from the admin UI or an agent
 * connection: a stolen session can't add a way in.
 */

export const SIGN_IN_PROVIDER_IDS = [
  "google",
  "microsoft",
  "github",
  "apple",
  "cloudflare",
  "oidc",
] as const;

export type SignInProviderId = (typeof SIGN_IN_PROVIDER_IDS)[number];

/** What a setting of a sign-in provider holds. */
export type SignInSettingRole =
  | "clientId"
  | "clientSecret"
  | "issuer"
  | "label"
  | "tenant";

export interface SignInSetting {
  /** `GOOGLE_SIGNIN_CLIENT_ID`. */
  readonly name: string;
  readonly role: SignInSettingRole;
  /** Without it the provider is off (an incomplete set is reported). */
  readonly required: boolean;
  /**
   * A plain value (an id, a URL, a word) `everyapp secret set` may show as
   * typed; a credential stays hidden.
   */
  readonly plain: boolean;
  /** One line: what to paste here. */
  readonly what: string;
}

export interface SignInProvider {
  readonly id: SignInProviderId;
  /** The button: "Continue with <label>". The `oidc` entry's label is a setting. */
  readonly label: string;
  /** Where the OAuth app is created. */
  readonly console: string;
  /** What the OAuth app is called there ("OAuth client ID", "App registration"). */
  readonly appNoun: string;
  readonly settings: readonly SignInSetting[];
  /** The scopes requested: identity only, nothing an app could act with. */
  readonly scopes: readonly string[];
  /** Which claim becomes the email, and what makes it count as verified. */
  readonly emailClaim: string;
  /** The everyapp skill's setup guide, relative to the skill. */
  readonly setup: `setup/signin-${SignInProviderId}.md`;
  /** Caveats worth a line in every listing. */
  readonly notes: readonly string[];
}

/** The path Better Auth serves the provider's callback on, under the Gateway's URL. */
export function signInCallbackPath(id: SignInProviderId): string {
  return `/api/auth/callback/${id}`;
}

/** The redirect URL to register with the provider, for a Gateway at `gatewayUrl`. */
export function signInCallbackUrl(
  gatewayUrl: string,
  id: SignInProviderId,
): string {
  return `${gatewayUrl.replace(/\/+$/, "")}${signInCallbackPath(id)}`;
}

function settingName(id: SignInProviderId, field: string): string {
  return `${id.toUpperCase()}_SIGNIN_${field}`;
}

function clientPair(
  id: SignInProviderId,
  what: { clientId: string; clientSecret: string },
): SignInSetting[] {
  return [
    {
      name: settingName(id, "CLIENT_ID"),
      role: "clientId",
      required: true,
      plain: true,
      what: what.clientId,
    },
    {
      name: settingName(id, "CLIENT_SECRET"),
      role: "clientSecret",
      required: true,
      plain: false,
      what: what.clientSecret,
    },
  ];
}

const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

export const SIGN_IN_PROVIDERS: Readonly<
  Record<SignInProviderId, SignInProvider>
> = {
  google: {
    id: "google",
    label: "Google",
    console: "https://console.cloud.google.com/apis/credentials",
    appNoun: "OAuth client ID (Web application)",
    settings: clientPair("google", {
      clientId:
        "The OAuth client's Client ID (ends in .apps.googleusercontent.com)",
      clientSecret: "The OAuth client's Client secret",
    }),
    scopes: IDENTITY_SCOPES,
    emailClaim:
      "the ID token's `email`, counted as verified only when its `email_verified` is true (every Google account's own address is)",
    setup: "setup/signin-google.md",
    notes: [
      "An OAuth consent screen still in Testing only signs in the test users listed on it; publish it for everyone else.",
    ],
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft",
    console:
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    appNoun: "App registration",
    settings: [
      ...clientPair("microsoft", {
        clientId: "The app registration's Application (client) ID",
        clientSecret:
          "A client secret from Certificates & secrets (it expires; 24 months at most)",
      }),
      {
        name: settingName("microsoft", "TENANT"),
        role: "tenant",
        required: false,
        plain: true,
        what: "The Directory (tenant) ID to pin sign-in to your own directory; unset means any Microsoft account (common), which then needs the xms_edov claim",
      },
    ],
    scopes: IDENTITY_SCOPES,
    emailClaim:
      "the ID token's `email`, counted as verified when MICROSOFT_SIGNIN_TENANT pins your own directory, or the token carries `xms_edov: true` (the optional claim that says the domain's owner verified it), `email_verified: true`, a matching `verified_primary_email`, or comes from a personal Microsoft account",
    setup: "setup/signin-microsoft.md",
    notes: [
      "Without MICROSOFT_SIGNIN_TENANT, add the optional claims `email` and `xms_edov` under Token configuration, or every sign-in is refused as unverified: any tenant's admin can put any address on their users.",
    ],
  },
  github: {
    id: "github",
    label: "GitHub",
    console: "https://github.com/settings/developers",
    appNoun: "OAuth App",
    settings: clientPair("github", {
      clientId: "The OAuth App's Client ID",
      clientSecret: "A client secret generated on the OAuth App",
    }),
    scopes: ["read:user", "user:email"],
    emailClaim:
      "the primary address from GitHub's emails API, counted as verified only when GitHub marks it verified",
    setup: "setup/signin-github.md",
    notes: [
      "GitHub Apps are something else: make an OAuth App (Settings → Developer settings → OAuth Apps).",
    ],
  },
  apple: {
    id: "apple",
    label: "Apple",
    console:
      "https://developer.apple.com/account/resources/identifiers/list/serviceId",
    appNoun: "Services ID",
    settings: clientPair("apple", {
      clientId: "The Services ID's identifier (com.example.gateway)",
      clientSecret:
        "The client secret JWT you generate from your Sign in with Apple key (ES256; valid six months at most, then generate it again)",
    }),
    scopes: ["email", "name"],
    emailClaim:
      "the ID token's `email`, counted as verified only when its `email_verified` is true; someone who chose Hide My Email arrives as a @privaterelay.appleid.com address, which no invitation names",
    setup: "setup/signin-apple.md",
    notes: [
      "Apple returns to the Gateway with a POST; behind the outer ring, `everyapp access on` leaves /api/auth/callback/apple public (it only redirects to the same URL as a GET, which Access then checks).",
      "The client secret is a JWT that expires within six months: generate a new one before then or sign-in stops.",
    ],
  },
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    console: "https://dash.cloudflare.com/?to=/:account/oauth-clients",
    appNoun: "OAuth client (Manage Account → OAuth clients)",
    settings: clientPair("cloudflare", {
      clientId: "The OAuth client's Client ID",
      clientSecret: "The OAuth client's Client secret",
    }),
    scopes: ["user-details.read"],
    emailClaim:
      "the Cloudflare API's /user `email` (the account's sign-in address). Cloudflare reports no verified flag, so the email counts as verified on the strength of the client being private: only members of your Cloudflare account can authorize it, and they got in by accepting an invitation sent to that address",
    setup: "setup/signin-cloudflare.md",
    notes: [
      "Keep the client private (the default): a public client lets any Cloudflare user sign in, and Cloudflare says nothing about whether their address is verified. Making a client public is permanent.",
      "The Cloudflare account's members sign in; for everyone else use Cloudflare Access's one-time PIN (`everyapp access on`) or another provider.",
    ],
  },
  oidc: {
    id: "oidc",
    label: "SSO",
    console: "your identity provider's admin console",
    appNoun: "OpenID Connect client (web application, authorization code)",
    settings: [
      {
        name: settingName("oidc", "ISSUER"),
        role: "issuer",
        required: true,
        plain: true,
        what: "The issuer URL (https://…), which serves /.well-known/openid-configuration",
      },
      ...clientPair("oidc", {
        clientId: "The client ID",
        clientSecret: "The client secret",
      }),
      {
        name: settingName("oidc", "LABEL"),
        role: "label",
        required: false,
        plain: true,
        what: 'The button text after "Continue with" (default "SSO")',
      },
    ],
    scopes: IDENTITY_SCOPES,
    emailClaim:
      "the ID token's `email` (else the userinfo endpoint's), counted as verified only when `email_verified` is true",
    setup: "setup/signin-oidc.md",
    notes: [
      "Cloudflare Access has its own settings (CLOUDFLARE_ACCESS_OIDC_*, `everyapp access`): use those for Access, this for Okta, Keycloak, Auth0, Authentik, Google Workspace as an OIDC issuer and the like. For Microsoft Entra ID use the `microsoft` provider: Entra's ID tokens carry no `email_verified`, so through this entry every sign-in would be refused as unverified.",
      "ID tokens must be signed with RS256 (every major provider's default).",
    ],
  },
};

/** The catalog in listing order. */
export const SIGN_IN_PROVIDER_LIST: readonly SignInProvider[] =
  SIGN_IN_PROVIDER_IDS.map((id) => SIGN_IN_PROVIDERS[id]);

export function isSignInProviderId(value: string): value is SignInProviderId {
  return (SIGN_IN_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Every setting a sign-in provider reads, in catalog order: what `everyapp
 * secret set` accepts for the Gateway, and what the Gateway's dev config
 * declares.
 */
export const SIGN_IN_GATEWAY_SETTINGS: readonly string[] =
  SIGN_IN_PROVIDER_LIST.flatMap((provider) =>
    provider.settings.map((setting) => setting.name),
  );

/** The plain (non-credential) ones among them: ids, the issuer, the label, the tenant. */
export const PLAIN_SIGN_IN_SETTINGS: readonly string[] =
  SIGN_IN_PROVIDER_LIST.flatMap((provider) =>
    provider.settings
      .filter((setting) => setting.plain)
      .map((setting) => setting.name),
  );

/**
 * The family: any name of the shape `<ID>_SIGNIN_<FIELD>`. Reserved for the
 * catalog above, whether or not an entry reads the name today, so no
 * registered provider row and no app manifest can ever take one.
 */
export const SIGN_IN_SETTING_PATTERN =
  /^[A-Z][A-Z0-9_]*_SIGNIN_(CLIENT_ID|CLIENT_SECRET|ISSUER|LABEL|TENANT)$/;

export function isSignInSettingName(name: string): boolean {
  return SIGN_IN_SETTING_PATTERN.test(name);
}

/** The provider a setting belongs to, if one reads it. */
export function signInProviderOfSetting(name: string): SignInProvider | null {
  for (const provider of SIGN_IN_PROVIDER_LIST) {
    if (provider.settings.some((setting) => setting.name === name)) {
      return provider;
    }
  }
  return null;
}

/** Whether a provider is on, off, or half set up, from which names are set. */
export type SignInProviderStatus = "on" | "off" | "incomplete";

export interface SignInProviderState {
  readonly id: SignInProviderId;
  readonly status: SignInProviderStatus;
  /** The required settings not set (empty when on or off). */
  readonly missing: readonly string[];
  /** The settings set, required or not. */
  readonly set: readonly string[];
}

/**
 * A provider's state from which of its settings exist: on when every
 * required one is set, off when none at all is, incomplete in between (the
 * Gateway refuses to half-configure a sign-in: the provider is off and the
 * problem is reported).
 */
export function signInProviderState(
  provider: SignInProvider,
  isSet: (name: string) => boolean,
): SignInProviderState {
  const set = provider.settings
    .filter((setting) => isSet(setting.name))
    .map((setting) => setting.name);
  const unset = provider.settings
    .filter((setting) => setting.required && !isSet(setting.name))
    .map((setting) => setting.name);
  const status: SignInProviderStatus =
    unset.length === 0 ? "on" : set.length === 0 ? "off" : "incomplete";
  // `missing` names what a half-set provider still needs; a provider nobody
  // started setting up isn't missing anything, it is off.
  return {
    id: provider.id,
    status,
    missing: status === "incomplete" ? unset : [],
    set,
  };
}
