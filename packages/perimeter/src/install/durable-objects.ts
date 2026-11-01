import type { Manifest as EveryAppCliManifest } from "@every-app/perimeter/manifest";
import type { RegistrationPlan } from "@every-app/perimeter/registry";
import { InstallationError as EveryAppError } from "./error";
export function checkDurableObjects(
  plan: Pick<RegistrationPlan, "previousManifest">,
  manifest: EveryAppCliManifest,
  allowDelete: boolean,
): string[] {
  const current = new Map(
    (manifest.resources?.durableObjects ?? []).map((d) => [
      d.className,
      d.worker,
    ]),
  );
  for (const durableObject of plan.previousManifest?.resources
    ?.durableObjects ?? []) {
    const className = String(durableObject.className);
    const before = durableObject.worker
      ? String(durableObject.worker)
      : undefined;
    // Cloudflare moves a class's data between Workers only by a transfer,
    // which the deploy never makes; and a helper Worker gets no tombstones.
    if (current.has(className) && current.get(className) !== before) {
      throw new EveryAppError(
        "DURABLE_OBJECT_MOVED",
        `${className} can't move to another Worker\nA Durable Object's data can't follow it.`,
        { fix: "give the class a new name in everyapp.config.ts" },
      );
    }
    if (!current.has(className) && before) {
      // Its own code: --allow-delete-durable-object-data doesn't cover it.
      throw new EveryAppError(
        "HELPER_DURABLE_OBJECT_REMOVED",
        `The helper Worker ${before} still defines ${className}\nRemoving a helper Worker's Durable Object class isn't supported yet.`,
        { fix: `keep declaring ${className} in everyapp.config.ts` },
      );
    }
  }
  const removed = (plan.previousManifest?.resources?.durableObjects ?? [])
    .map((d) => String(d.className))
    .filter((className) => !current.has(className));
  if (removed.length > 0 && !allowDelete) {
    const one = removed.length === 1;
    throw new EveryAppError(
      "DURABLE_OBJECT_REMOVED",
      `Deploying would delete ${one ? `${removed[0]}'s data` : `the data of ${removed.join(", ")}`} for good\neveryapp.config.ts no longer declares the Durable Object class${one ? "" : "es"} ${removed.join(", ")}.`,
    );
  }
  return removed;
}
