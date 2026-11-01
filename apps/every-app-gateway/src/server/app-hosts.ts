/**
 * Where a gateway's apps live.
 *
 * A deployed gateway carries APP_BASE_DOMAIN (the CLI patches it in from
 * the install record): every app is one label below it, a Workers Custom
 * Domain on the gateway Worker, `<appId>.<base>` for the install's own
 * organization and `<appId>-<orgKey>.<base>` for any other (the names come
 * from `@every-app/perimeter/registry`), and the session cookie is scoped to
 * it. It is the gateway's own host for now: the mobile shell scopes its copy
 * of the session cookie to the gateway host, and apps find their way home by
 * dropping their first label.
 *
 * Third-party apps (customer code in the hosted gateway's dispatch
 * namespace) live elsewhere: one label below THIRD_PARTY_DOMAIN, a separate
 * registrable domain the session cookie never covers, with a session per
 * host (@every-app/perimeter's hostRoutes.ts and hostSession.ts).
 */
import type { HostProfile } from "@every-app/perimeter";
import { platformPolicy } from "@/server/platform-policy";

interface HostEnv {
  APP_BASE_DOMAIN?: string;
}

interface ThirdPartyHostEnv extends HostEnv {
  GATEWAY_URL?: string;
  GATEWAY_DEPLOYMENT_MODE?: string;
  THIRD_PARTY_DOMAIN?: string;
}

const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** APP_BASE_DOMAIN, lowercased, or null when unset or invalid (local dev). */
export function appBaseDomain(env: HostEnv): string | null {
  const base = env.APP_BASE_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
  return base && DNS_NAME_PATTERN.test(base) ? base : null;
}

/**
 * The last two labels: no registrable domain is shorter, so two names that
 * differ here are on different registrable domains whatever the public
 * suffix list says (names that share them may still be: then we refuse).
 */
function lastTwoLabels(name: string): string {
  return name.split(".").slice(-2).join(".");
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * THIRD_PARTY_DOMAIN, lowercased, or null: always on a self-hosted gateway,
 * and wherever it is unset, invalid, or could share a site with the
 * gateway's own host or APP_BASE_DOMAIN (the session cookie's domain).
 * Customer code on the same site as the control plane would be "same-site"
 * to it, so the cookie's SameSite protection would not apply; null leaves
 * third-party apps with no host to open them on.
 */
export function thirdPartyDomain(env: ThirdPartyHostEnv): string | null {
  if (!platformPolicy(env).hosted) return null;
  const domain = env.THIRD_PARTY_DOMAIN?.trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain || !DNS_NAME_PATTERN.test(domain)) return null;
  const gateway = hostnameOf(env.GATEWAY_URL);
  if (!gateway) return null;
  const site = lastTwoLabels(domain);
  for (const own of [gateway, appBaseDomain(env)]) {
    if (own && lastTwoLabels(own) === site) return null;
  }
  return domain;
}

/** The host classes this gateway serves (hostRoutes.ts). */
export function hostProfile(
  env: ThirdPartyHostEnv,
  gatewayHost: string | null,
): HostProfile {
  return {
    gatewayHost,
    thirdPartyDomain: gatewayHost ? thirdPartyDomain(env) : null,
  };
}
