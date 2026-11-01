/**
 * The sign-in providers' settings, read from the Worker's environment: the
 * catalog in packages/sdk/src/internal/signInProviders.ts says which names
 * each provider reads; this says which providers are on.
 *
 * Like the Cloudflare Access settings (../cloudflare-access/config.ts),
 * every setting is a Worker secret, never the admin UI: a stolen admin
 * session can't add a way in. A provider is on only with every required
 * setting present; a half-set provider is off, and the problem is logged
 * once per isolate and shown in Manage workspace → Sign-in, so nothing is
 * ever half-configured.
 */
import { logEvent } from "@every-app/perimeter";
import {
  SIGN_IN_PROVIDER_LIST,
  signInProviderState,
  type SignInProvider,
  type SignInProviderId,
  type SignInProviderState,
} from "@every-app/sdk/internal";

/** The button text's length limit (OIDC_SIGNIN_LABEL). */
const MAX_LABEL_LENGTH = 40;
/** A Microsoft tenant: a GUID, or one of the login.microsoftonline.com words. */
const TENANT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|common|organizations|consumers)$/i;

export interface SignInProviderConfig {
  readonly id: SignInProviderId;
  /** "Continue with <label>". */
  readonly label: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** `oidc` only: the issuer, with discovery at `<issuer>/.well-known/openid-configuration`. */
  readonly issuer?: string;
  /** `microsoft` only: the tenant sign-in is pinned to, or `common`. */
  readonly tenant?: string;
}

export interface SignInProvidersConfig {
  /** The providers that are on, in catalog order. */
  readonly providers: readonly SignInProviderConfig[];
  /** Every catalog provider's state, for listings. */
  readonly states: readonly SignInProviderState[];
  /** What was wrong with the settings, for the logs and the listing. */
  readonly problems: readonly string[];
}

type SignInProvidersEnv = Record<string, unknown>;

interface ReadOptions {
  /**
   * Accept http://localhost and 127.0.0.1 issuers (a mock provider in local
   * development); production builds take https only.
   */
  allowLoopback: boolean;
}

function setting(env: SignInProvidersEnv, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * An OIDC issuer: an https URL (http on loopback where allowed) with no
 * credentials, query or fragment, kept without a trailing slash so it
 * compares equal to the `iss` tokens carry.
 */
export function normalizeIssuer(
  value: string,
  options: ReadOptions,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const loopback = isLoopback(url.hostname.toLowerCase());
  if (url.protocol === "https:" && !loopback) {
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  if (
    options.allowLoopback &&
    loopback &&
    (url.protocol === "http:" || url.protocol === "https:")
  ) {
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  return null;
}

function readProvider(
  spec: SignInProvider,
  env: SignInProvidersEnv,
  options: ReadOptions,
  problems: string[],
): SignInProviderConfig | null {
  const state = signInProviderState(spec, (name) => setting(env, name) !== "");
  if (state.status === "off") return null;
  if (state.status === "incomplete") {
    problems.push(
      `Sign in with ${spec.label} needs ${state.missing.join(" and ")}; it is off.`,
    );
    return null;
  }
  const value = (role: SignInProvider["settings"][number]["role"]) => {
    const found = spec.settings.find((entry) => entry.role === role);
    return found ? setting(env, found.name) : "";
  };
  const clientId = value("clientId");
  const clientSecret = value("clientSecret");
  if (spec.id === "oidc") {
    const issuerSetting = spec.settings.find(
      (entry) => entry.role === "issuer",
    )!;
    const issuer = normalizeIssuer(value("issuer"), options);
    if (!issuer) {
      problems.push(
        `${issuerSetting.name} must be an https URL (the issuer, which serves /.well-known/openid-configuration); SSO sign-in is off.`,
      );
      return null;
    }
    const label = value("label").slice(0, MAX_LABEL_LENGTH) || spec.label;
    return { id: spec.id, label, clientId, clientSecret, issuer };
  }
  if (spec.id === "microsoft") {
    const tenantSetting = spec.settings.find(
      (entry) => entry.role === "tenant",
    )!;
    const tenant = value("tenant");
    if (tenant && !TENANT.test(tenant)) {
      problems.push(
        `${tenantSetting.name} must be a Directory (tenant) ID, or common, organizations or consumers; Microsoft sign-in is off.`,
      );
      return null;
    }
    return {
      id: spec.id,
      label: spec.label,
      clientId,
      clientSecret,
      tenant: tenant ? tenant.toLowerCase() : "common",
    };
  }
  return { id: spec.id, label: spec.label, clientId, clientSecret };
}

/** Read the sign-in providers' settings (cheap; call per use). */
export function readSignInProviders(
  env: SignInProvidersEnv,
  options: ReadOptions,
): SignInProvidersConfig {
  const problems: string[] = [];
  const providers: SignInProviderConfig[] = [];
  const states: SignInProviderState[] = [];
  for (const spec of SIGN_IN_PROVIDER_LIST) {
    const config = readProvider(spec, env, options, problems);
    const state = signInProviderState(
      spec,
      (name) => setting(env, name) !== "",
    );
    // A provider whose settings are all there but one is malformed is off
    // too: say so in the state, not only in the log.
    states.push(
      state.status === "on" && !config
        ? { ...state, status: "incomplete" }
        : state,
    );
    if (config) providers.push(config);
  }
  return { providers, states, problems };
}

const reported = new Set<string>();

/** Log each settings problem once per isolate. */
export function reportSignInProviderProblems(
  config: SignInProvidersConfig,
): void {
  for (const problem of config.problems) {
    if (reported.has(problem)) continue;
    reported.add(problem);
    logEvent("signin.config_problem", { problem }, "warn");
  }
}

/** Forget which problems were logged (tests). */
export function resetSignInProviderProblemsForTests(): void {
  reported.clear();
}

/** The ids of the providers that are on. */
export function configuredSignInProviderIds(
  config: SignInProvidersConfig,
): ReadonlySet<string> {
  return new Set(config.providers.map((provider) => provider.id));
}
