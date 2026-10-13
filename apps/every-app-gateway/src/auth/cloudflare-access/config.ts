/**
 * Cloudflare Access sign-in settings, read from the Worker's environment.
 *
 * Auth configuration lives in secrets, never in the admin UI: a stolen admin
 * session can't add a sign-in method or change who it lets in. Every setting
 * is optional, and a malformed one turns its feature off (with a warning in
 * the logs) rather than half-configuring it.
 *
 *  - OIDC sign-in ("Continue with <label>"): Access for SaaS as an OpenID
 *    Connect provider. CLOUDFLARE_ACCESS_OIDC_ISSUER, _CLIENT_ID,
 *    _CLIENT_SECRET, and optionally _LABEL.
 *  - Outer ring: Access in front of the gateway's hostnames. The gateway
 *    verifies the `Cf-Access-Jwt-Assertion` Access adds and signs that
 *    person in. CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD (the
 *    Access application on the gateway's own host: only its assertions sign
 *    people in), and CLOUDFLARE_ACCESS_APPS_AUD for a separate application
 *    on the apps' hosts (its assertions only vouch for a session there).
 *  - Membership: CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS lets people with those
 *    email domains join without an invitation; CLOUDFLARE_ACCESS_OUTER_RING_
 *    AUTO_JOIN=everyone lets in everyone the outer ring admits.
 *  - EMAIL_PASSWORD_SIGN_IN=false turns password sign-in off, but only while
 *    an Access sign-in method is configured, so it can't lock everyone out.
 *
 * See docs/runbooks/cloudflare-access.md.
 */
import { logEvent } from "@every-app/perimeter";

/** The Better Auth provider id (and account `providerId`) for Access. */
export const ACCESS_PROVIDER_ID = "cloudflare-access";

const DEFAULT_LABEL = "Cloudflare Access";
const MAX_LABEL_LENGTH = 40;

export interface AccessEnv {
  CLOUDFLARE_ACCESS_OIDC_ISSUER?: string;
  CLOUDFLARE_ACCESS_OIDC_CLIENT_ID?: string;
  CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET?: string;
  CLOUDFLARE_ACCESS_OIDC_LABEL?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_APPS_AUD?: string;
  CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS?: string;
  CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN?: string;
  EMAIL_PASSWORD_SIGN_IN?: string;
}

export interface AccessOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUrl: string;
}

export interface AccessOuterRingConfig {
  /** The team domain's origin: the `iss` of its tokens. */
  issuer: string;
  /**
   * AUD tags whose assertions sign people in: the Access application on the
   * gateway's own host (CLOUDFLARE_ACCESS_AUD).
   */
  signInAudiences: string[];
  /**
   * Those and the apps' application (CLOUDFLARE_ACCESS_APPS_AUD): an
   * assertion for any of them vouches for the session it comes with.
   */
  audiences: string[];
  certsUrl: string;
  /** Everyone the outer ring lets in may join as a member. */
  autoJoinEveryone: boolean;
}

export interface AccessConfig {
  oidc: AccessOidcConfig | null;
  outerRing: AccessOuterRingConfig | null;
  /** Email domains whose people join without an invitation. */
  autoJoinDomains: string[];
  /** False only when the operator turned it off and Access sign-in works. */
  passwordSignIn: boolean;
  /** What was wrong with the settings, for the logs. */
  problems: string[];
}

interface ReadOptions {
  /**
   * Accept http(s)://localhost and 127.0.0.1 URLs (a mock Access in local
   * development); production builds take *.cloudflareaccess.com only.
   */
  allowLoopback: boolean;
}

const ON_VALUES = new Set(["true", "1", "on", "yes"]);
const OFF_VALUES = new Set(["false", "0", "off", "no"]);

function setting(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * A URL on a Cloudflare Access team domain (`<team>.cloudflareaccess.com`,
 * https only), or a loopback one where allowed; null otherwise.
 */
function accessUrl(value: string, options: ReadOptions): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol === "https:" &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(
      hostname,
    )
  ) {
    return url;
  }
  if (
    options.allowLoopback &&
    isLoopback(hostname) &&
    (url.protocol === "http:" || url.protocol === "https:")
  ) {
    return url;
  }
  return null;
}

function readOidc(
  env: AccessEnv,
  options: ReadOptions,
  problems: string[],
): AccessOidcConfig | null {
  const issuerSetting = setting(env.CLOUDFLARE_ACCESS_OIDC_ISSUER);
  const clientId = setting(env.CLOUDFLARE_ACCESS_OIDC_CLIENT_ID);
  const clientSecret = setting(env.CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET);
  if (!issuerSetting && !clientId && !clientSecret) return null;
  if (!issuerSetting || !clientId || !clientSecret) {
    problems.push(
      "OIDC sign-in needs CLOUDFLARE_ACCESS_OIDC_ISSUER, CLOUDFLARE_ACCESS_OIDC_CLIENT_ID and CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET; it is off.",
    );
    return null;
  }

  const url = accessUrl(issuerSetting, options);
  if (!url) {
    problems.push(
      "CLOUDFLARE_ACCESS_OIDC_ISSUER must be https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>; OIDC sign-in is off.",
    );
    return null;
  }
  const issuer = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  // On a real team domain the issuer path ends in the client id: catch a
  // secret pasted from another Access application.
  if (
    !isLoopback(url.hostname) &&
    issuer !== `${url.origin}/cdn-cgi/access/sso/oidc/${clientId}`
  ) {
    problems.push(
      "CLOUDFLARE_ACCESS_OIDC_ISSUER isn't the issuer of CLOUDFLARE_ACCESS_OIDC_CLIENT_ID (it should end in /cdn-cgi/access/sso/oidc/<client id>); OIDC sign-in is off.",
    );
    return null;
  }

  const label =
    setting(env.CLOUDFLARE_ACCESS_OIDC_LABEL).slice(0, MAX_LABEL_LENGTH) ||
    DEFAULT_LABEL;
  return {
    issuer,
    clientId,
    clientSecret,
    label,
    authorizationEndpoint: `${issuer}/authorization`,
    tokenEndpoint: `${issuer}/token`,
    jwksUrl: `${issuer}/jwks`,
  };
}

/** Comma or space separated AUD tags, or null if one isn't an AUD tag. */
function audienceList(value: string): string[] | null {
  const audiences = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  return audiences.every((aud) => /^[A-Za-z0-9._:-]{1,256}$/.test(aud))
    ? audiences
    : null;
}

function readOuterRing(
  env: AccessEnv,
  options: ReadOptions,
  problems: string[],
): AccessOuterRingConfig | null {
  const teamDomain = setting(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  const audSetting = setting(env.CLOUDFLARE_ACCESS_AUD);
  const appsAudSetting = setting(env.CLOUDFLARE_ACCESS_APPS_AUD);
  const autoJoin = setting(env.CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN);
  if (!teamDomain && !audSetting) {
    for (const [name, value] of [
      ["CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN", autoJoin],
      ["CLOUDFLARE_ACCESS_APPS_AUD", appsAudSetting],
    ] as const) {
      if (value) {
        problems.push(
          `${name} is set but the outer ring isn't (CLOUDFLARE_ACCESS_TEAM_DOMAIN, CLOUDFLARE_ACCESS_AUD); it does nothing.`,
        );
      }
    }
    return null;
  }
  if (!teamDomain || !audSetting) {
    problems.push(
      "The outer ring needs both CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD; it is off.",
    );
    return null;
  }

  const url = accessUrl(
    /^[a-z]+:\/\//i.test(teamDomain) ? teamDomain : `https://${teamDomain}`,
    options,
  );
  if (!url || (url.pathname !== "/" && url.pathname !== "")) {
    problems.push(
      "CLOUDFLARE_ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com; the outer ring is off.",
    );
    return null;
  }

  const signInAudiences = audienceList(audSetting);
  if (!signInAudiences?.length) {
    problems.push(
      "CLOUDFLARE_ACCESS_AUD must be the AUD tag of the Access application on the gateway's host (several: comma separated); the outer ring is off.",
    );
    return null;
  }
  const appAudiences = audienceList(appsAudSetting);
  if (!appAudiences) {
    problems.push(
      "CLOUDFLARE_ACCESS_APPS_AUD must be the AUD tag of the Access application on the apps' hosts (several: comma separated); the outer ring is off.",
    );
    return null;
  }

  let autoJoinEveryone = false;
  if (autoJoin.toLowerCase() === "everyone") {
    autoJoinEveryone = true;
  } else if (autoJoin) {
    problems.push(
      'CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN takes only "everyone"; it is off.',
    );
  }

  return {
    issuer: url.origin,
    signInAudiences,
    audiences: [...new Set([...signInAudiences, ...appAudiences])],
    certsUrl: `${url.origin}/cdn-cgi/access/certs`,
    autoJoinEveryone,
  };
}

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

function readAutoJoinDomains(env: AccessEnv, problems: string[]): string[] {
  const domains = new Set<string>();
  for (const entry of setting(env.CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS).split(
    /[\s,]+/,
  )) {
    const domain = entry.trim().toLowerCase().replace(/^@/, "");
    if (!domain) continue;
    if (DOMAIN.test(domain)) {
      domains.add(domain);
    } else {
      problems.push(
        `CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS: "${domain.slice(0, 64)}" isn't an email domain (like example.com); skipped.`,
      );
    }
  }
  return [...domains];
}

function readPasswordSignIn(
  env: AccessEnv,
  accessConfigured: boolean,
  problems: string[],
): boolean {
  const value = setting(env.EMAIL_PASSWORD_SIGN_IN).toLowerCase();
  if (!value || ON_VALUES.has(value)) return true;
  if (!OFF_VALUES.has(value)) {
    problems.push(
      'EMAIL_PASSWORD_SIGN_IN is neither on nor off, so password sign-in stays on. Use "false".',
    );
    return true;
  }
  if (!accessConfigured) {
    problems.push(
      "EMAIL_PASSWORD_SIGN_IN=false is ignored: no Cloudflare Access sign-in is configured, so turning passwords off would lock everyone out.",
    );
    return true;
  }
  return false;
}

/** Read the Access sign-in settings (cheap; call per use). */
export function readAccessConfig(
  env: AccessEnv,
  options: ReadOptions,
): AccessConfig {
  const problems: string[] = [];
  const oidc = readOidc(env, options, problems);
  const outerRing = readOuterRing(env, options, problems);
  const autoJoinDomains = readAutoJoinDomains(env, problems);
  const passwordSignIn = readPasswordSignIn(
    env,
    Boolean(oidc || outerRing),
    problems,
  );
  return { oidc, outerRing, autoJoinDomains, passwordSignIn, problems };
}

const reported = new Set<string>();

/** Log each settings problem once per isolate. */
export function reportAccessConfigProblems(config: AccessConfig): void {
  for (const problem of config.problems) {
    if (reported.has(problem)) continue;
    reported.add(problem);
    logEvent("access.config_problem", { problem }, "warn");
  }
}

/** Whether people can sign in with Cloudflare Access at all. */
export function isAccessSignInConfigured(config: AccessConfig): boolean {
  return Boolean(config.oidc || config.outerRing);
}
