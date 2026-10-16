/**
 * The one seam between the gateway and a sub-app.
 *
 * Two tiers. `service_binding`: each registered app is a private Worker
 * exposed to the gateway as a service binding named `APP__<worker_name>` (the
 * self-hosted install, and the hosted gateway's first-party apps).
 * `dispatch`: the app is a Worker in the hosted gateway's Workers for
 * Platforms dispatch namespace, reached through the `DISPATCHER` binding with
 * per-invocation limits and the app's egress allowlist handed to the
 * gateway's outbound Worker. `getAppFetcher` is the *single* place that knows
 * how an app is invoked; callers pass the registered app and never branch on
 * its tier.
 */
import { isRegistryWorkerName } from "./manifest/manifest";

/** Minimal shape of a thing we can `.fetch()` a Request through. */
export interface AppFetcher {
  fetch(request: Request): Promise<Response>;
}

/** Per-invocation ceilings on a dispatched Worker. */
export interface DispatchLimits {
  cpuMs: number;
  subrequests: number;
}

export interface AppFetcherTarget {
  appId: string;
  organizationId: string;
  /** Service-binding / script name, e.g. `every-acme-todo`. */
  workerName: string;
  tier: "service_binding" | "dispatch";
  /** Dispatch only; {@link DEFAULT_DISPATCH_LIMITS} when absent. */
  limits?: DispatchLimits;
  /**
   * Dispatch only: the hostnames the app's Worker may fetch. Absent means
   * none: every outbound fetch is denied.
   */
  egress?: readonly string[];
}

/**
 * Why an app can't be reached. All of them answer 503: none is the app's
 * own failure, and none may fall through to another way of reaching it.
 */
export type AppUnreachableReason =
  "no_binding" | "no_dispatcher" | "invalid_worker_name" | "worker_not_found";

export class AppUnreachableError extends Error {
  constructor(
    message: string,
    readonly reason: AppUnreachableReason = "no_binding",
  ) {
    super(message);
    this.name = "AppUnreachableError";
  }
}

/**
 * The dispatch namespace binding. Optional on purpose: only a hosted gateway
 * whose account has the namespace declares it; without it every dispatch app
 * is unreachable.
 */
const DISPATCHER_BINDING = "DISPATCHER";

/**
 * The outbound parameter the gateway's outbound Worker reads the calling
 * app from. The dispatch namespace binding must forward it
 * (`outbound.parameters = ["everyapp"]`).
 */
export const OUTBOUND_PARAMETER = "everyapp";

/** What the outbound Worker learns about the app whose fetch it judges. */
export interface OutboundParameters {
  appId: string;
  organizationId: string;
  workerName: string;
  egress: string[];
}

/**
 * Generous enough for a server-rendered page with a few database calls,
 * low enough that one org's runaway Worker can't burn the account's budget.
 */
const DEFAULT_DISPATCH_LIMITS: Readonly<DispatchLimits> = Object.freeze({
  cpuMs: 5_000,
  subrequests: 200,
});

/**
 * Structural copy of Cloudflare's `DispatchNamespace` (the perimeter has no
 * Workers types): `get(name, args, { limits, outbound })`, where `outbound`
 * carries the parameters the binding forwards to its outbound Worker.
 */
interface DispatchNamespaceLike {
  get(
    name: string,
    args?: Record<string, unknown>,
    options?: {
      limits?: { cpuMs?: number; subRequests?: number };
      outbound?: Record<string, unknown>;
    },
  ): AppFetcher;
}

function appServiceBindingName(workerName: string): string {
  return `APP__${workerName}`;
}

function isDispatchNamespace(value: unknown): value is DispatchNamespaceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DispatchNamespaceLike).get === "function"
  );
}

// Org keys are up to 12 of [a-z0-9] (no hyphen), so `every-<orgKey>-<appId>`
// splits one way only.
const ORG_KEY_PATTERN = /^[a-z0-9]{1,12}$/;

/**
 * Whether the Worker name is the one the registry's naming rule gives this
 * app, `every-<orgKey>-<appId>`: the registry can then never dispatch to a
 * script it didn't name (the gateway's own, another app's).
 */
function isDispatchableWorkerName(app: AppFetcherTarget): boolean {
  const prefix = "every-";
  const suffix = `-${app.appId}`;
  if (
    !app.workerName.startsWith(prefix) ||
    !app.workerName.endsWith(suffix) ||
    app.workerName.length <= prefix.length + suffix.length
  ) {
    return false;
  }
  const orgKey = app.workerName.slice(
    prefix.length,
    app.workerName.length - suffix.length,
  );
  return (
    ORG_KEY_PATTERN.test(orgKey) &&
    isRegistryWorkerName({
      appId: app.appId,
      orgKey,
      workerName: app.workerName,
    })
  );
}

/**
 * The namespace throws "Worker not found…" (from `get` or the first fetch)
 * for a script it doesn't hold: an app whose upload hasn't landed, or was
 * removed. That is unreachable, not an app error; anything else is the app's.
 */
function unreachableIfNotFound(error: unknown, workerName: string): unknown {
  if (error instanceof Error && error.message.startsWith("Worker not found")) {
    return new AppUnreachableError(
      `The dispatch namespace has no Worker "${workerName}".`,
      "worker_not_found",
    );
  }
  return error;
}

function dispatchFetcher(
  env: Record<string, unknown>,
  app: AppFetcherTarget,
): AppFetcher {
  const dispatcher = env[DISPATCHER_BINDING];
  if (!isDispatchNamespace(dispatcher)) {
    throw new AppUnreachableError(
      `No dispatch namespace binding "${DISPATCHER_BINDING}" for worker "${app.workerName}". Only a hosted gateway with a Workers for Platforms namespace reaches dispatch apps.`,
      "no_dispatcher",
    );
  }
  if (!isDispatchableWorkerName(app)) {
    throw new AppUnreachableError(
      `Worker "${app.workerName}" is not app "${app.appId}"'s registry Worker; refusing to dispatch to it.`,
      "invalid_worker_name",
    );
  }
  const limits = app.limits ?? DEFAULT_DISPATCH_LIMITS;
  const parameters: OutboundParameters = {
    appId: app.appId,
    organizationId: app.organizationId,
    workerName: app.workerName,
    egress: [...(app.egress ?? [])],
  };
  let worker: AppFetcher;
  try {
    worker = dispatcher.get(
      app.workerName,
      {},
      {
        limits: { cpuMs: limits.cpuMs, subRequests: limits.subrequests },
        outbound: { [OUTBOUND_PARAMETER]: parameters },
      },
    );
  } catch (error) {
    throw unreachableIfNotFound(error, app.workerName);
  }
  return {
    async fetch(request) {
      try {
        return await worker.fetch(request);
      } catch (error) {
        throw unreachableIfNotFound(error, app.workerName);
      }
    },
  };
}

/**
 * Resolve the fetcher for an app. `env` is the worker env; service bindings
 * appear on it keyed by `APP__<worker_name>`, the dispatch namespace as
 * {@link DISPATCHER_BINDING}.
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
  if (app.tier === "dispatch") return dispatchFetcher(env, app);
  // Never reached through the types; a tier from anywhere else fails closed.
  throw new AppUnreachableError(
    `Tier "${String(app.tier)}" is not a way to reach an app.`,
  );
}
