/**
 * Where a gateway's apps live.
 *
 * A gateway deployed with per-app Workers Custom Domains carries
 * APP_BASE_DOMAIN (the CLI patches it in from the install record): every
 * app is one label below it, `<appId>.<base>` for the install's own
 * organization and `<appId>-<orgKey>.<base>` for any other, and the session
 * cookie is scoped to it. It is the gateway's own host for now: the mobile
 * shell scopes its copy of the session cookie to the gateway host, and apps
 * find their way home by dropping their first label.
 *
 * Gateways served through a `*.<host>` route (installs from before
 * per-app domains, until the operator switches them) have no
 * APP_BASE_DOMAIN and keep `<appId>-<orgSlug>.<gateway host>`.
 */

interface HostEnv {
  APP_BASE_DOMAIN?: string;
  GATEWAY_URL?: string;
}

const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** APP_BASE_DOMAIN, lowercased, or null when the gateway has none (route mode). */
export function appBaseDomain(env: HostEnv): string | null {
  const base = env.APP_BASE_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
  return base && DNS_NAME_PATTERN.test(base) ? base : null;
}

/** The gateway's own host, from GATEWAY_URL; null when unset or invalid. */
export function gatewayHostOf(env: HostEnv): string | null {
  if (!env.GATEWAY_URL) return null;
  try {
    return new URL(env.GATEWAY_URL).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The domain app hosts sit under: APP_BASE_DOMAIN, else the gateway host. */
export function appHostParent(env: HostEnv): string | null {
  return appBaseDomain(env) ?? gatewayHostOf(env);
}
