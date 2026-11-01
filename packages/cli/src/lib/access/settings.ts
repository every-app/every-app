/**
 * The Gateway's Access settings: the three names `access on` sets on the
 * Worker (the team domain and the two AUD tags), and whether they are all
 * there, which is what "Cloudflare Access is on" means to the Gateway. The
 * values can't be read back from a Worker; the team domain comes from the
 * record `access on` keeps in the Gateway's D1 (lib/access/record.ts).
 */
import type { AccessDrift } from "./plan";

/** The Gateway settings the outer ring runs on. */
export const ACCESS_SETTINGS = [
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CLOUDFLARE_ACCESS_APPS_AUD",
  "CLOUDFLARE_ACCESS_AUD",
] as const;

/** Whether Cloudflare Access is in front of the Gateway, which team's, and whether it is in step. */
export interface AccessState {
  /** All three settings are on the Gateway Worker. */
  on: boolean;
  /** The team domain `access on` last wrote, when it recorded one. */
  teamDomain: string | null;
  /**
   * With Access on: how the live applications differ from what this
   * release wants (lib/access/plan.ts `accessDrift`) and whether the
   * recorded settings still name the applications found; null when Access
   * is off, or when Zero Trust couldn't be read (`driftUnread` says why).
   */
  drift: (AccessDrift & { settings: boolean }) | null;
  /** Why the drift wasn't read: a login without the Access permissions (`permission`), or cf's refusal. */
  driftUnread: { permission: boolean; error: string } | null;
}

/** Whether the Worker's secret names include every Access setting. */
function accessSettingsOn(secretNames: readonly string[]): boolean {
  return ACCESS_SETTINGS.every((name) => secretNames.includes(name));
}

/**
 * The Access state as `status` reports it, from the Gateway Worker's secret
 * names (listed once by the caller, for every setting it checks) and the
 * record `access on` wrote (lib/access/record.ts): nothing is asked of Zero
 * Trust (that is `access show`'s job).
 */
export function accessStateOf(
  secretNames: readonly string[],
  record: { teamDomain: string } | null,
): Pick<AccessState, "on" | "teamDomain"> {
  return { on: accessSettingsOn(secretNames), teamDomain: record?.teamDomain ?? null };
}
