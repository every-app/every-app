/**
 * Activating an app: the CLI uploads an app's Worker, marks its row
 * `binding` and redeploys the gateway with a service binding to it. The
 * first request that reaches the app on a gateway version holding that
 * binding makes it `active` (ADR-0003). An isolate still on the previous
 * version has no such binding and keeps answering "deploying", which is
 * exactly the rollout window.
 *
 * Only a self-hosted gateway activates apps on its own; any other
 * `GATEWAY_DEPLOYMENT_MODE` (unset included) leaves them deploying.
 */
import { logEvent, type RegisteredApp } from "@every-app/perimeter";
import { appBindingName } from "@every-app/perimeter/manifest";
import { AppRepository } from "@/server/repositories/AppRepository";
import { resolveDeploymentMode } from "@/server/deployment-mode";

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Whether this gateway version can reach an app's Worker: it has the
 * service binding, and a request through it gets any HTTP response.
 */
export async function probeAppBinding(
  env: object,
  app: { workerName: string; hostname: string },
): Promise<boolean> {
  const binding = (env as Record<string, unknown>)[
    appBindingName(app.workerName)
  ] as ServiceBinding | undefined;
  if (typeof binding?.fetch !== "function") return false;
  try {
    await binding.fetch(
      new Request(`https://${app.hostname}/__everyapp/health`),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a `binding` app `active` once this isolate reaches its Worker. True
 * when the app is now active and the request may be served.
 */
export async function activateApp(
  env: { GATEWAY_DEPLOYMENT_MODE?: string },
  app: RegisteredApp,
): Promise<boolean> {
  if (resolveDeploymentMode(env.GATEWAY_DEPLOYMENT_MODE) !== "self_hosted") {
    return false;
  }
  if (!app.rowId || !(await probeAppBinding(env, app))) return false;
  if (!(await AppRepository.activate(app.rowId, app.organizationId))) {
    // Deleted or disabled since the request looked it up.
    return false;
  }
  logEvent("app.activated", { app: app.appId, org: app.organizationId });
  return true;
}
