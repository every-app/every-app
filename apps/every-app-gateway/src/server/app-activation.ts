/**
 * Activating an app: the CLI uploads an app's Worker, marks its row
 * `binding` and redeploys the gateway with a service binding to it. The
 * first request that reaches the app on a gateway version holding that
 * binding makes it `active` (ADR-0003). An isolate still on the previous
 * version has no such binding and keeps answering "deploying", which is
 * exactly the rollout window.
 *
 * Self-hosted and hosted gateways activate apps on their own (both reach
 * their apps over service bindings: platformPolicy's bindingActivation);
 * an invalid `GATEWAY_DEPLOYMENT_MODE` (unset included) leaves them
 * deploying.
 */
import {
  getAppFetcher,
  logEvent,
  type RegisteredApp,
} from "@every-app/perimeter";
import { AppRepository } from "@/server/repositories/AppRepository";
import { platformPolicy } from "@/server/platform-policy";

/**
 * Whether this gateway version can reach an app's Worker through the one
 * seam (its service binding, or the dispatch namespace), and a request
 * through it gets any HTTP response.
 */
export async function probeApp(
  env: object,
  app: RegisteredApp,
): Promise<boolean> {
  try {
    await getAppFetcher(env as Record<string, unknown>, app).fetch(
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
  if (!platformPolicy(env).bindingActivation) return false;
  if (!app.rowId || !(await probeApp(env, app))) return false;
  if (!(await AppRepository.activate(app.rowId, app.organizationId))) {
    // Deleted or disabled since the request looked it up.
    return false;
  }
  logEvent("app.activated", { app: app.appId, org: app.organizationId });
  return true;
}
