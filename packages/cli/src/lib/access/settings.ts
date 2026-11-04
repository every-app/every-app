/**
 * The Gateway's Access settings: the three names `access on` sets on the
 * Worker (the team domain and the two AUD tags). All three there is what
 * "Cloudflare Access is on" means to the Gateway; their values can't be
 * read back from a Worker.
 */

/** The Gateway settings the outer ring runs on. */
export const ACCESS_SETTINGS = [
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CLOUDFLARE_ACCESS_APPS_AUD",
  "CLOUDFLARE_ACCESS_AUD",
] as const;

/** Whether Cloudflare Access is in front of the Gateway, as `status` reports it. */
export interface AccessState {
  /** All three settings are on the Gateway Worker. */
  on: boolean;
}

/** The Access state from the Gateway Worker's secret names: nothing is asked of Zero Trust (that is `access show`'s job). */
export function accessStateOf(secretNames: readonly string[]): AccessState {
  return { on: ACCESS_SETTINGS.every((name) => secretNames.includes(name)) };
}

/** What Cloudflare Access lets through for an app, as one comparable string. */
export function publicSurfaceKey(
  manifest: { public?: unknown; publicAssets?: unknown } | null | undefined,
): string {
  return JSON.stringify([manifest?.public ?? [], manifest?.publicAssets ?? []]);
}
