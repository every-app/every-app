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
 */

interface HostEnv {
  APP_BASE_DOMAIN?: string;
}

const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** APP_BASE_DOMAIN, lowercased, or null when unset or invalid (local dev). */
export function appBaseDomain(env: HostEnv): string | null {
  const base = env.APP_BASE_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
  return base && DNS_NAME_PATTERN.test(base) ? base : null;
}
