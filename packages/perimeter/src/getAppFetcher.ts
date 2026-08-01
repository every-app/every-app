/**
 * The one seam between the gateway and a sub-app.
 *
 * The current self-hosted tier uses `service_binding`: each registered app is a private
 * worker exposed to the gateway as a service binding named `APP__<worker_name>`.
 * The dispatch-namespace (Workers for Platforms) tier slots in here later —
 * `getAppFetcher` is the *single* place that knows how an app is invoked, so
 * adding it never touches callers.
 */

/** Minimal shape of a thing we can `.fetch()` a Request through. */
export interface AppFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface AppFetcherTarget {
  /** Service-binding / script name, e.g. `every-todo-app`. */
  workerName: string;
  /** 'service_binding' now; 'dispatch' reserved for the hosted tier. */
  tier: "service_binding" | "dispatch";
}

export class AppUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppUnreachableError";
  }
}

function appServiceBindingName(workerName: string): string {
  return `APP__${workerName}`;
}

/**
 * Resolve the fetcher for an app. `env` is the worker env; service bindings
 * appear on it keyed by `APP__<worker_name>`.
 */
export function getAppFetcher(
  env: Record<string, unknown>,
  app: AppFetcherTarget,
): AppFetcher {
  if (app.tier === "service_binding") {
    const bindingName = appServiceBindingName(app.workerName);
    const binding = env[bindingName];
    if (!binding || typeof (binding as AppFetcher).fetch !== "function") {
      throw new AppUnreachableError(
        `No service binding "${bindingName}" for worker "${app.workerName}". The gateway must be redeployed with bindings reconstructed from the registry.`,
      );
    }
    return binding as AppFetcher;
  }
  // Hosted tier is deferred. Kept as an
  // explicit, contained failure so callers never silently fall through.
  throw new AppUnreachableError(
    `Tier "${app.tier}" is not supported yet (dispatch namespaces are deferred).`,
  );
}
