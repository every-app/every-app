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
import { EveryAppError } from "@/lib/errors";
import { replaceFlag } from "./rerun";

export enum DevMode {
  Stub = "stub",
  Mirror = "mirror",
}

export const DEV_MODE_ENV = "EVERYAPP_DEV_MODE";
export const DEFAULT_MIRROR_BASE_HOST = "everyapp.localhost";

/** Flag wins over env; env over the `stub` default. Unknown values throw. */
export function resolveDevMode(
  flag: string | undefined,
  env: string | undefined,
): DevMode {
  const raw = flag ?? env ?? DevMode.Stub;
  const mode = Object.values(DevMode).find((value) => value === raw.toLowerCase());
  if (mode) return mode;
  throw new EveryAppError(
    "INVALID_DEV_MODE",
    [
      `${flag === undefined ? DEV_MODE_ENV : "--mode"} must be stub or mirror, not "${raw}"`,
      "stub signs you in as a seeded dev user; mirror uses real login through a local Gateway.",
    ].join("\n"),
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
 * Mirror mode needs the session cookie to ride from the Gateway's base host
 * to an app's subdomain, which requires the cookie be scoped to a parent
 * domain: impossible on a single-label base like `localhost`.
 */
export function checkMirrorBaseHost(baseHost: string): void {
  if (baseHostLabelCount(baseHost) >= 2) return;
  throw new EveryAppError(
    "MIRROR_BASE_HOST",
    [
      `Mirror mode needs a two-label base host, like ${DEFAULT_MIRROR_BASE_HOST}`,
      `The session cookie must cross from the Gateway to the app's subdomain; "${baseHost}" has one label.`,
      `Open apps at http://<app>.${DEFAULT_MIRROR_BASE_HOST}:<port> through portless or an /etc/hosts entry.`,
    ].join("\n"),
    {
      rerun: replaceFlag("--base-host", DEFAULT_MIRROR_BASE_HOST),
      data: {
        baseHost,
        fix: `on the local Gateway, set EVERYAPP_DEV_COOKIE_DOMAIN=${DEFAULT_MIRROR_BASE_HOST} and GATEWAY_URL=http://${DEFAULT_MIRROR_BASE_HOST}:<port>`,
      },
    },
  );
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
