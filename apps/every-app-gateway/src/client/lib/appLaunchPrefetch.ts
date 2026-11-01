import { appStatus } from "@/client/lib/appStatus";
import type { UserAccessApp } from "@/types/app";

/**
 * Warming an app before the click. Opening an app is a navigation to
 * https://<hostname>/ through the gateway Worker and then the app's own
 * Worker, and each of those is cold on the first visit (tens of
 * milliseconds for the gateway, up to a second for a big app). The
 * browser can start that work while the pointer rests on the card:
 *
 * - Chrome (121+) reads a `<script type="speculationrules">` listing the
 *   apps' URLs with `"eagerness": "moderate"`, and prefetches the document
 *   when a link to one of them is hovered for ~200 ms or pressed. The
 *   prefetch is the same credentialed same-site GET the click makes (the
 *   gateway and the apps share everyapp.team), so the click lands on warm
 *   isolates and, often, an already-fetched page.
 * - Every browser gets `<link rel="preconnect">` for the host on hover,
 *   focus or touch: DNS, TCP and TLS are done before the click.
 *
 * Only apps that open are listed: an app that needs setup, is deploying or
 * is a provider has no page to warm. Only first-party apps are listed for
 * the prefetch (isSameSite): a third-party host is another site, where
 * Chrome would prefetch without cookies and discard the result. The
 * preconnect on hover applies to every app link.
 */

/** The last two labels: the platform's own rule for "the same site" (server/app-hosts.ts). */
function lastTwoLabels(hostname: string): string {
  return hostname.toLowerCase().split(".").slice(-2).join(".");
}

/**
 * Whether an app's host is on the launcher's site. The gateway and its
 * first-party apps share one registrable domain (and the session cookie),
 * so Chrome prefetches them with credentials; a third-party app lives on a
 * separate domain by construction, where a prefetch would go without
 * cookies and be thrown away, so it is not listed.
 */
export function isSameSite(hostname: string, site: string): boolean {
  const host = hostname.toLowerCase();
  const page = site.toLowerCase();
  return (
    host === page ||
    host.endsWith(`.${page}`) ||
    lastTwoLabels(host) === lastTwoLabels(page)
  );
}

/**
 * The hostnames of the apps the launcher opens on its own site (`site`, the
 * page's hostname), each once.
 */
export function openableHosts(
  apps: readonly Pick<
    UserAccessApp,
    "hostname" | "status" | "setup" | "tier"
  >[],
  site: string,
): string[] {
  const hosts = new Set<string>();
  for (const app of apps) {
    if (
      app.hostname &&
      appStatus(app).opens &&
      isSameSite(app.hostname, site)
    ) {
      hosts.add(app.hostname);
    }
  }
  return [...hosts];
}

/**
 * The speculation rules JSON for the given hosts: a list-source prefetch
 * of each host's root, at moderate eagerness (hover or pointerdown).
 */
export function speculationRulesFor(hosts: readonly string[]): string {
  const urls = [...new Set(hosts)].map((host) => `https://${host}/`);
  return JSON.stringify({
    prefetch: [{ source: "list", urls, eagerness: "moderate" }],
  });
}

/**
 * Browsers close an unused preconnected socket after about ten seconds, so
 * a hover older than that asks for a fresh one.
 */
const PRECONNECT_FRESH_MS = 10_000;
const preconnected = new Map<string, { link: HTMLLinkElement; at: number }>();

/**
 * Open the connection to an app's host ahead of the navigation, once per
 * host per ten seconds. No `crossorigin`: the click is a navigation, not a
 * CORS fetch, so the credentialed connection is the one to reuse.
 */
export function preconnectTo(hostname: string, now = Date.now()): void {
  const previous = preconnected.get(hostname);
  if (previous && now - previous.at < PRECONNECT_FRESH_MS) return;
  previous?.link.remove();
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = `https://${hostname}`;
  document.head.appendChild(link);
  preconnected.set(hostname, { link, at: now });
}
