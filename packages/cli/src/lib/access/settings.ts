/**
 * The Gateway's Access settings: the three names `access on` sets on the
 * Worker (the team domain and the two AUD tags), and whether they are all
 * there, which is what "Cloudflare Access is on" means to the Gateway. The
 * values can't be read back from a Worker; the team domain comes from the
 * record `access on` keeps in the Gateway's D1 (lib/access/record.ts).
 */
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { readAccessSettingsRecord } from "./record";

/** The Gateway settings the outer ring runs on. */
export const ACCESS_SETTINGS = [
  "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
  "CLOUDFLARE_ACCESS_APPS_AUD",
  "CLOUDFLARE_ACCESS_AUD",
] as const;

/** Whether Cloudflare Access is in front of the Gateway, and which team's. */
export interface AccessState {
  /** All three settings are on the Gateway Worker. */
  on: boolean;
  /** The team domain `access on` last wrote, when it recorded one. */
  teamDomain: string | null;
}

/** Whether the Worker's secret names include every Access setting. */
function accessSettingsOn(secretNames: readonly string[]): boolean {
  return ACCESS_SETTINGS.every((name) => secretNames.includes(name));
}

/**
 * The Access state as `status` reports it, from the Gateway Worker's secret
 * names and the record alone: nothing is asked of Zero Trust (that is
 * `access show`'s job).
 */
export async function readAccessState(cf: CfRunner, db: D1Database): Promise<AccessState> {
  const [names, record] = await Promise.all([
    listWorkerSecrets(cf, GATEWAY_WORKER_NAME),
    readAccessSettingsRecord(db),
  ]);
  return { on: accessSettingsOn(names), teamDomain: record?.teamDomain ?? null };
}
