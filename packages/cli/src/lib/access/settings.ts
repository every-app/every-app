/**
 * The Gateway's Access settings: the three names `access on` sets on the
 * Worker (the team domain and the two AUD tags). All three there is what
 * "Cloudflare Access is on" means to the Gateway; their values can't be
 * read back from a Worker.
 */

import { listWorkerSecrets } from "@/lib/cf/secrets";
import type { CfRunner } from "@/lib/cf/runner";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";

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

/**
 * Behind Cloudflare Access, an app's public routes (bearer ones included)
 * are let through by `access on` alone. When a deploy or a
 * delete changed them and the Gateway has its Access settings, say to run it
 * again; a Gateway whose settings can't be listed is left unsaid.
 */
export async function warnIfAccessNeedsRerun(
  { cf, out, worker }: { cf: CfRunner; out: EventSink; worker: string },
  {
    appId,
    previous,
    next,
    message,
  }: {
    appId: string;
    previous: Parameters<typeof publicSurfaceKey>[0];
    next: Parameters<typeof publicSurfaceKey>[0];
    /** The warning's words, the first line its headline. */
    message: string;
  },
): Promise<void> {
  if (publicSurfaceKey(previous) === publicSurfaceKey(next)) return;
  const names = await listWorkerSecrets(cf, worker).catch(() => null);
  if (!names || !accessStateOf(names).on) return;
  out.emit({
    type: "warning",
    code: "ACCESS_RERUN_NEEDED",
    step: "app.access",
    message,
    data: { appId, rerun: `${CLI} access on` },
  });
}
