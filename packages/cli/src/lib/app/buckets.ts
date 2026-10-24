/**
 * The R2 buckets an app's Workers bind, made when missing. A Worker may
 * bind a bucket the manifest declares (`resources.r2`: `R2` is named after
 * the Worker, any other binding `<worker>--<binding>`, by the registration)
 * or one named by hand in cloudflare.config.ts (the three launch apps bind
 * `bindings.r2({ name: worker.name })`); cf's prebuilt deploy creates
 * neither, and the upload fails with `[10085] R2 bucket '<name>' not found`
 * (seen on a fresh account on 2026-10-24). So after the Build Output is
 * installed, and before anything is uploaded, the deploy makes each bucket
 * that isn't there. Buckets are named, never recorded as the app's
 * (lib/app/ownership.ts): one that exists is bound as it is, so a redeploy
 * keeps its objects, and `delete --purge` leaves it.
 */
import { isCfError } from "@/lib/cf/errors";
import { createR2Bucket, findR2Bucket } from "@/lib/cf/r2";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";

/**
 * Make every bucket in `names` that doesn't exist; the names created, in
 * order. An account that never enabled R2 stops the deploy with
 * R2_NOT_ENABLED, naming what to do in the dashboard.
 */
export async function ensureR2Buckets({
  cf,
  names,
  appId,
  out,
}: {
  cf: CfRunner;
  names: readonly string[];
  appId: string;
  out: EventSink;
}): Promise<string[]> {
  const created: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    try {
      if (await findR2Bucket(cf, name)) continue;
      await createR2Bucket(cf, name);
    } catch (error) {
      // Made by another deploy between the lookup and the create: it's there.
      if (isCfError(error, "already_exists")) continue;
      if (isCfError(error, "r2_not_enabled")) {
        throw new EveryAppError(
          "R2_NOT_ENABLED",
          `R2 isn't enabled in this Cloudflare account, and ${appId} needs an R2 bucket (${name})\nEnable it once in the dashboard: R2 Object Storage → Get started (free until something is stored).`,
          { fix: "enable R2 in the Cloudflare dashboard (R2 Object Storage)", rerun: thisCommand() },
        );
      }
      throw error;
    }
    created.push(name);
    out.emit({
      type: "progress",
      step: "app.build",
      message: `Created R2 bucket "${name}".`,
      data: { bucket: name },
    });
  }
  return created;
}
