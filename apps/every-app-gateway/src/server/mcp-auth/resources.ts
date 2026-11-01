/**
 * The protected resources the gateway's OAuth server issues tokens for
 * (docs/design/native-sign-in.md §5): `${GATEWAY_URL}/mcp` for AI apps,
 * plus the origin of every active first-party app host, for native apps
 * (a desktop or phone client) that sign in to one app as the member.
 *
 * The list is read from the apps registry and cached per isolate: re-read
 * at most once a minute, and once more (rate-limited) when a request names
 * a resource the current list doesn't know, so a just-deployed app's first
 * sign-in works without waiting. A deleted or disabled app's origin leaves
 * the list on the next read, and the authorization server then refuses its
 * tokens (`validateToken` for a resource that is not listed answers null).
 *
 * Dispatch-tier apps on third-party hosts are not resources (B8: their own
 * session model); neither are provider (MCP) apps, which have no host.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { logEvent } from "@every-app/perimeter";
import { db } from "@/db";
import { apps, orgSettings } from "@/db/schema";

/** How long a list is trusted before the registry is read again. */
const RESOURCES_TTL_MS = 60_000;
/**
 * How often an unknown resource may trigger an early re-read: a client
 * naming resources that don't exist must not become a registry read per
 * request.
 */
const UNKNOWN_RESOURCE_REREAD_MS = 10_000;

/** The scheme app hosts are served on: the issuer's (`https:`, or `http:` on a local gateway). */
export type ResourceScheme = "https:" | "http:";

/**
 * The resource (RFC 8707) of a first-party app host: its origin, on the
 * issuer's scheme (https; http only where the gateway itself is an http
 * issuer on localhost, for development) and with no port: app hosts are
 * named by hostname alone in the registry.
 */
export function appResourceOrigin(
  hostname: string,
  scheme: ResourceScheme = "https:",
): string {
  return `${scheme}//${hostname.toLowerCase()}`;
}

/**
 * The hostname an app resource names, or null when `resource` isn't the
 * shape of one: exactly `<scheme>//<host>` (an empty path counts as `/`,
 * RFC 3986 §6.2.3, which the library also accepts), nothing else.
 */
export function appResourceHostname(
  resource: string,
  scheme: ResourceScheme = "https:",
): string | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (
    url.protocol !== scheme ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
  return url.hostname;
}

/** Where linked dev resources live under the issuer (docs/design/linked-dev.md §4.1). */
export const LINKED_DEV_PATH = "/linked-dev";
const APP_SLUG = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The resource (RFC 8707) of linked dev for one app: the Gateway's
 * services for that app, as the member, through `/linked-dev/<app id>`
 * on the issuer. Its token opens no app host and not `/mcp`.
 */
export function devResource(issuer: string, appSlug: string): string {
  return `${issuer}${LINKED_DEV_PATH}/${appSlug.toLowerCase()}`;
}

/**
 * The app id a linked dev resource names, or null when `resource` isn't
 * one: exactly `${issuer}/linked-dev/<app id>`, nothing else.
 */
export function devResourceAppSlug(
  resource: string,
  issuer: string,
): string | null {
  const prefix = `${issuer}${LINKED_DEV_PATH}/`;
  if (!resource.startsWith(prefix)) return null;
  const slug = resource.slice(prefix.length);
  return APP_SLUG.test(slug) ? slug : null;
}

type Cached = {
  scheme: ResourceScheme;
  issuer: string | null;
  origins: readonly string[];
  readAt: number;
  unknownReadAt: number;
};

let cached: Cached | undefined;

/** RFC 8252 §7.3 loopback: `localhost`, 127.0.0.0/8 and `::1`. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return ipv4 !== null && ipv4.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Whether the library would take `hostname` as a resource on `scheme`:
 * https anywhere; http on a loopback host only. On a development gateway
 * (an http issuer on localhost) the seeded apps on public hostnames are
 * not resources, and must not take the whole OAuth server down with them.
 */
export function isResourceHostname(
  hostname: string,
  scheme: ResourceScheme,
): boolean {
  if (!/^[a-z0-9.:\[\]-]+$/i.test(hostname)) return false;
  return scheme === "https:" || isLoopbackHostname(hostname);
}

/**
 * The linked dev resource of every active first-party app whose
 * organization turned linked dev on (`org_settings.linked_dev`), so a
 * request naming one on a gateway that didn't opt in is `invalid_target`.
 */
async function readDevResources(issuer: string): Promise<string[]> {
  const rows = await db
    .select({ appSlug: apps.appSlug })
    .from(apps)
    .innerJoin(orgSettings, eq(orgSettings.organizationId, apps.organizationId))
    .where(
      and(
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
        eq(orgSettings.linkedDev, true),
      ),
    );
  return [
    ...new Set(
      rows
        .filter((row) => APP_SLUG.test(row.appSlug))
        .map((row) => devResource(issuer, row.appSlug)),
    ),
  ].sort();
}

/** The origins of every active first-party app host, from the registry. */
async function readAppResources(scheme: ResourceScheme): Promise<string[]> {
  const rows = await db
    .select({ hostname: apps.hostname })
    .from(apps)
    .where(
      and(
        eq(apps.status, "active"),
        eq(apps.tier, "service_binding"),
        isNotNull(apps.hostname),
      ),
    );
  const dropped = rows.filter(
    (row) => !isResourceHostname(row.hostname!, scheme),
  );
  if (dropped.length) {
    logEvent(
      "mcp.oauth.resources_skipped",
      {
        scheme,
        hostnames: dropped.map((row) => row.hostname),
        reason: "http is a resource on a loopback host only",
      },
      "warn",
    );
  }
  return [
    ...new Set(
      rows
        .filter((row) => isResourceHostname(row.hostname!, scheme))
        .map((row) => appResourceOrigin(row.hostname!, scheme)),
    ),
  ].sort();
}

/**
 * The current app resources: the cached list, re-read when it is older
 * than a minute, or when `needed` names a resource the list doesn't have
 * (at most every ten seconds). A failed read keeps the previous list (an
 * empty one on a fresh isolate: OAuth then serves `/mcp` alone until the
 * registry answers), so a registry outage never takes `/mcp` down. With
 * `issuer`, the linked dev resources are read beside the app origins.
 */
export async function currentAppResources(
  scheme: ResourceScheme,
  options: {
    needed?: string | null;
    now?: number;
    issuer?: string;
  } = {},
): Promise<readonly string[]> {
  const now = options.now ?? Date.now();
  const issuer = options.issuer ?? null;
  const stale =
    !cached ||
    cached.scheme !== scheme ||
    cached.issuer !== issuer ||
    now - cached.readAt >= RESOURCES_TTL_MS;
  const unknown =
    cached !== undefined &&
    typeof options.needed === "string" &&
    (appResourceHostname(options.needed, scheme) !== null ||
      (issuer !== null &&
        devResourceAppSlug(options.needed, issuer) !== null)) &&
    !cached.origins.includes(options.needed.toLowerCase()) &&
    now - cached.unknownReadAt >= UNKNOWN_RESOURCE_REREAD_MS;
  if (!stale && !unknown) return cached!.origins;
  try {
    const origins = [
      ...(await readAppResources(scheme)),
      ...(issuer ? await readDevResources(issuer) : []),
    ];
    cached = {
      scheme,
      issuer,
      origins,
      readAt: now,
      unknownReadAt: unknown ? now : 0,
    };
  } catch (error) {
    logEvent(
      "mcp.oauth.resources_unreadable",
      { message: error instanceof Error ? error.message : String(error) },
      "error",
    );
    // Not for a whole minute: the next request tries the registry again.
    cached = {
      scheme,
      issuer,
      origins:
        cached?.scheme === scheme && cached.issuer === issuer
          ? cached.origins
          : [],
      readAt: now - RESOURCES_TTL_MS + UNKNOWN_RESOURCE_REREAD_MS,
      unknownReadAt: now,
    };
  }
  return cached.origins;
}

export function resetAppResourcesForTests(): void {
  cached = undefined;
}
