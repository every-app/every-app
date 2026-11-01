/**
 * Dev-mode resolution and host validation for `everyapp dev`.
 *
 * Three modes:
 *  - stub   (default): seeded dev user, in-memory registry, minimal launcher.
 *             Zero setup; works on bare `localhost:8787`.
 *  - mirror: real Better Auth session resolved from a SEPARATELY-running local
 *             gateway, real launcher/login forwarded to it. Requires a
 *             two-label base host so the session cookie crosses the
 *             gateway->app subdomain boundary.
 *  - linked: the real Gateway (`--gateway https://…`, docs/design/linked-dev.md):
 *             you are the owner or admin whose token the CLI holds, and the
 *             app's AI, capability, email, members and event calls go through
 *             that Gateway; data stays local. `--gateway` with a URL that isn't
 *             this machine selects it.
 */
import net from "node:net";
import { EveryAppError } from "@/lib/errors";
import { replaceFlag } from "./rerun";

export enum DevMode {
  Stub = "stub",
  Mirror = "mirror",
  Linked = "linked",
}

export const DEV_MODE_ENV = "EVERYAPP_DEV_MODE";
export const DEFAULT_MIRROR_BASE_HOST = "everyapp.localhost";

/**
 * Flag wins over env; env over the `stub` default, except that `--gateway`
 * naming a Gateway that isn't this machine (an https URL, or http on a
 * name other than localhost) selects `linked` when no mode is given.
 * Unknown values throw.
 */
export function resolveDevMode(
  flag: string | undefined,
  env: string | undefined,
  gateway?: string,
): DevMode {
  const raw = flag ?? env ?? (gateway && !isLoopbackGatewayUrl(gateway) ? DevMode.Linked : DevMode.Stub);
  const mode = Object.values(DevMode).find((value) => value === raw.toLowerCase());
  if (mode) return mode;
  throw new EveryAppError(
    "INVALID_DEV_MODE",
    [
      `${flag === undefined ? DEV_MODE_ENV : "--mode"} must be stub, mirror or linked, not "${raw}"`,
      "stub signs you in as a seeded dev user; mirror uses real login through a local Gateway; linked uses a real Gateway's services as you (--gateway https://…).",
    ].join("\n"),
  );
}

/** Whether a Gateway URL names this machine (`localhost`, `127.0.0.1`, `::1`): mirror's local Gateway, not a linked one. */
function isLoopbackGatewayUrl(gateway: string): boolean {
  try {
    const { hostname } = new URL(gateway);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
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

/**
 * Whether a Host names this machine: `localhost` and names under it, a
 * loopback or any other IP literal (the LAN address when `--host 0.0.0.0`
 * binds there), or the mirror base host and its subdomains. Any other DNS
 * name is a page's DNS-rebinding trick: a name the attacker owns, pointed at
 * 127.0.0.1 once the page has loaded, so the page reads and writes the app
 * as the seeded owner. The dev gateway answers such a Host 421.
 */
export function isDevHost(host: string, baseHost?: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${host.trim().toLowerCase()}`).hostname;
  } catch {
    return false;
  }
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (net.isIP(hostname.replace(/^\[|\]$/g, ""))) return true;
  if (baseHost) {
    const base = stripPort(baseHost).trim().toLowerCase();
    if (base && (hostname === base || hostname.endsWith(`.${base}`))) return true;
  }
  return false;
}

/**
 * Whether a request came from a web page rather than a terminal or a
 * script. Browsers send `Origin`, `Referer` or Fetch Metadata on every
 * cross-site POST they make, including the simple ones that skip the
 * preflight; curl and scripts send none unless told to. The dev cron
 * trigger takes the terminal's POST only.
 */
export function isBrowserRequest(headers: {
  origin?: string | string[] | undefined;
  referer?: string | string[] | undefined;
  "sec-fetch-mode"?: string | string[] | undefined;
  "sec-fetch-site"?: string | string[] | undefined;
}): boolean {
  return (
    headers.origin !== undefined ||
    headers.referer !== undefined ||
    headers["sec-fetch-mode"] !== undefined ||
    headers["sec-fetch-site"] !== undefined
  );
}
