import { workerNameFor } from "@every-app/perimeter/manifest";
import { DEV_USER, type RegisteredApp } from "@every-app/perimeter/dev";
import type { EveryAppCliManifest } from "@/lib/generateWranglerConfig";

export function registerDevApp(manifest: EveryAppCliManifest): RegisteredApp {
  return {
    appId: manifest.id,
    hostname: `${manifest.id}.localhost`,
    workerName: workerNameFor(manifest.id),
    tier: "service_binding",
    organizationId: DEV_USER.orgId,
    status: "active",
    manifest: manifest as RegisteredApp["manifest"],
  };
}
