/**
 * Dev-mode resolution and host validation for `everyapp dev`.
 *
 * Two modes (the founder's "control plane vs. stub" knob):
 *  - stub   (default): seeded dev user, in-memory registry, minimal launcher.
 *             Zero setup; works on bare `localhost:8787`.
 *  - mirror: real Better Auth session resolved from a SEPARATELY-running local
 *             gateway, real launcher/login forwarded to it. Requires a
 *             two-label base host so the session cookie crosses the
 *             gateway->app subdomain boundary.
 */
export type DevMode = "stub" | "mirror";

export const DEV_MODE_ENV = "EVERYAPP_DEV_MODE";

export class DevModeError extends Error {}

/** Flag wins over env; env over the `stub` default. Unknown values throw. */
export function resolveDevMode(
  flag: string | undefined,
  env: string | undefined,
): DevMode {
  const raw = (flag ?? env ?? "stub").toLowerCase();
  if (raw === "stub" || raw === "mirror") return raw;
  throw new DevModeError(
    `Invalid dev mode "${raw}" — expected "stub" or "mirror".`,
  );
}

/**
 * Count the DNS labels in a base host, ignoring any port. `localhost` -> 1,
 * `everyapp.localhost` -> 2, `fix-ui.everyapp.localhost` -> 3.
 */
export function baseHostLabelCount(baseHost: string): number {
  const hostname = baseHost.split(":")[0] ?? baseHost;
  if (hostname.length === 0) return 0;
  return hostname.split(".").filter((l) => l.length > 0).length;
}

/**
 * mirror mode needs the session cookie to ride from the gateway base host to a
 * sub-app subdomain, which requires the cookie be scoped to a parent domain —
 * impossible on a single-label base like `localhost`. Returns a guidance
 * message when the base host is unusable, or null when it's fine.
 */
export function checkMirrorBaseHost(baseHost: string): string | null {
  if (baseHostLabelCount(baseHost) >= 2) return null;
  return [
    `mirror mode needs a two-label base host so the session cookie can cross`,
    `the gateway->app subdomain boundary. You're on "${baseHost}" (one label).`,
    ``,
    `Pass --baseHost everyapp.localhost and open`,
    `  http://<app>.everyapp.localhost:<port>`,
    `via portless (recommended) or an /etc/hosts entry, and set the gateway's`,
    `EVERYAPP_DEV_COOKIE_DOMAIN=everyapp.localhost and`,
    `GATEWAY_URL=http://everyapp.localhost:<port>.`,
  ].join("\n");
}

const stripPort = (host: string): string => host.split(":")[0] ?? host;

type HostClass =
  | { kind: "launcher" }
  | { kind: "app"; appLabel: string }
  | { kind: "invalid" };

/**
 * Classify an incoming Host against a known mirror base host. `parseHost`
 * alone can't tell the two-label base host (`everyapp.localhost`, which looks
 * like app "everyapp" on base "localhost") from a real app, so mirror mode
 * resolves it against the explicit base host:
 *  - host === baseHost              -> the launcher / control plane
 *  - host === <label>.baseHost      -> app `<label>`
 *  - anything else                  -> invalid (wrong base host)
 */
export function classifyHost(host: string, baseHost: string): HostClass {
  const h = stripPort(host).toLowerCase();
  const base = stripPort(baseHost).toLowerCase();
  if (h === base) return { kind: "launcher" };
  if (h.endsWith(`.${base}`)) {
    const appLabel = h.slice(0, -(base.length + 1));
    if (appLabel.length > 0 && !appLabel.includes(".")) {
      return { kind: "app", appLabel };
    }
  }
  return { kind: "invalid" };
}
