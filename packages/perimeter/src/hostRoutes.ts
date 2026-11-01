/**
 * Which class of host a request arrived on, decided before any registry
 * lookup or credential read.
 *
 *  - `control_plane`: the gateway's own host (launcher, auth, admin).
 *  - `first_party`: every other host the gateway answers with the shared
 *    Better Auth session: `<appId>.<APP_BASE_DOMAIN>` (the install's own and
 *    the hosted gateway's shared apps) and `<appId>-<orgKey>.<APP_BASE_DOMAIN>`
 *    (an organization's own apps). They are found in the registry by full
 *    hostname, as before, and only reach Workers the gateway's own account
 *    deployed over their service bindings.
 *  - `third_party`: `<appId>-<orgKey>.<THIRD_PARTY_DOMAIN>`, one label below
 *    a separate registrable domain, where customer code in the dispatch
 *    namespace answers. The shared session cookie is never scoped there, and
 *    never honoured there: each host has its own session (hostSession.ts).
 *  - `not_found`: under the third-party domain but not one app label (the
 *    apex, or deeper names): a 404 without a lookup.
 *
 * A self-hosted gateway has no third-party domain, so its profile has only
 * the first two classes and every host but its own is looked up in the
 * registry exactly as before.
 */
import type { RegisteredApp } from "./registry";

export interface HostProfile {
  /** The gateway's own host (from GATEWAY_URL), or null when unknown. */
  gatewayHost: string | null;
  /**
   * The registrable domain third-party apps live one label below, or null
   * (always, on a self-hosted gateway).
   */
  thirdPartyDomain: string | null;
}

export type HostRoute =
  | { kind: "control_plane" }
  | { kind: "first_party" }
  | { kind: "third_party" }
  | { kind: "not_found" };

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Classify a lowercased Host header (port kept, as received). */
export function routeHost(host: string, profile: HostProfile): HostRoute {
  if (!host || host === profile.gatewayHost) return { kind: "control_plane" };
  const domain = profile.thirdPartyDomain;
  if (domain && (host === domain || host.endsWith(`.${domain}`))) {
    const label = host.slice(0, -(domain.length + 1));
    return DNS_LABEL.test(label)
      ? { kind: "third_party" }
      : { kind: "not_found" };
  }
  return { kind: "first_party" };
}

/**
 * Whether a host of this class may serve the registry row found for it:
 * customer code (the `dispatch` tier, an organization's own) only on a
 * third-party host, and the gateway's own account's Workers (service
 * bindings, shared or an organization's) only on a first-party host, so a
 * request carrying the shared session never reaches customer code and a
 * per-host session never opens a first-party app. A row on the wrong class
 * is a row the gateway can't route.
 */
export function hostAdmitsApp(
  route: HostRoute,
  app: Pick<RegisteredApp, "tier" | "scope">,
): boolean {
  switch (route.kind) {
    case "first_party":
      return app.tier === "service_binding";
    case "third_party":
      return app.tier === "dispatch" && app.scope === "org";
    default:
      return false;
  }
}
