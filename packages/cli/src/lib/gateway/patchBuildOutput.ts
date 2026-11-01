/**
 * Turn the gateway release's Build Output into this install's gateway: its
 * resource ids, a service binding per bound app, its domains, and the
 * release stamp, then validate the result with `@cloudflare/config`'s own
 * Build Output schema before cf ever sees it.
 *
 * The gateway host and every bound app's host are Workers Custom Domains on
 * the gateway, the full list on every deploy (cf publishes them as a whole:
 * a host left out is removed), and APP_BASE_DOMAIN tells the gateway where
 * apps live.
 */
import { DEFAULT_WORKER, WORKERS_DIR } from "@/lib/app/buildOutput";
import { isOneLabelBelow } from "@/lib/domains/hostnames";
import { EveryAppError } from "@/lib/errors";
import { validateWorkerBuildOutput } from "@every-app/perimeter/install";
import {
  APP_BINDING_PREFIX,
  appBindingName,
  DEFAULT_GATEWAY_NAMES,
  type GatewayNames,
} from "@every-app/perimeter/manifest";
import { EVERYAPP_OBSERVABILITY } from "@every-app/sdk/cloudflare";
import fs from "node:fs/promises";
import path from "node:path";

const GATEWAY_WORKER_DIR = path.join(WORKERS_DIR, DEFAULT_WORKER);
export const GATEWAY_WORKER_CONFIG = path.join(GATEWAY_WORKER_DIR, "worker.config.json");
const BUNDLE_DIR = path.join(GATEWAY_WORKER_DIR, "bundle");

interface GatewayPatch {
  /**
   * The Gateway's names (manifest/gatewayNames.ts): its Worker, its D1
   * and its activation queue replace the release's, which are built as
   * the default's; EVERYAPP_GATEWAY_NAME tells the Worker which it is.
   */
  names?: GatewayNames;
  d1Id: string;
  oauthKvId: string;
  release: { version: string; sha256: string };
  gatewayHost: string;
  /** Where app hosts live. */
  appBaseDomain: string;
  /** Workers to bind as APP__<worker>. */
  appWorkers: readonly string[];
  /** App hosts to publish as Custom Domains. */
  appHosts: readonly string[];
}

/**
 * Every hostname the gateway is published under: its own host first, then
 * each app host, sorted.
 */
export function gatewayDomains(
  patch: Pick<GatewayPatch, "gatewayHost" | "appHosts">,
): string[] {
  return [
    patch.gatewayHost,
    ...[...new Set(patch.appHosts)]
      .filter((host) => host !== patch.gatewayHost)
      .sort(),
  ];
}

type WorkerConfig = Record<string, unknown> & {
  env?: Record<string, Record<string, unknown>>;
  domains?: string[];
  triggers?: Array<Record<string, unknown>>;
  workersDev?: boolean;
  previewUrls?: boolean;
  observability?: unknown;
  manifest?: {
    type: string;
    mainModule: string;
    modules?: Record<string, { type: string }>;
  };
};

/**
 * Patch the Build Output in `releaseDir` (a private copy of the release)
 * in place, and return the patched config.
 */
export async function patchGatewayBuildOutput(releaseDir: string, patch: GatewayPatch): Promise<WorkerConfig> {
  const configPath = path.join(releaseDir, GATEWAY_WORKER_CONFIG);
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as WorkerConfig;
  const env = { ...(config.env ?? {}) };
  const names = patch.names ?? DEFAULT_GATEWAY_NAMES;

  // The release is built as the default Gateway; a named one takes its own
  // Worker and queue names, and tells the Worker which it is.
  config["name"] = names.worker;
  for (const trigger of config.triggers ?? []) {
    if (trigger["type"] === "queue" && trigger["name"] === DEFAULT_GATEWAY_NAMES.activationQueue) {
      trigger["name"] = names.activationQueue;
    }
  }
  env["EVERYAPP_GATEWAY_NAME"] = { type: "text", value: names.name ?? "" };

  for (const name of Object.keys(env)) {
    if (name.startsWith(APP_BINDING_PREFIX)) delete env[name];
  }
  // The gateway never used its KV namespace; deploys stop binding it.
  delete env["KV"];
  env["DB"] = { type: "d1", name: names.d1, id: patch.d1Id };
  env["OAUTH_KV"] = { type: "kv", id: patch.oauthKvId };
  env["EVERYAPP_RELEASE"] = { type: "json", value: patch.release };
  env["CF_VERSION_METADATA"] = { type: "version-metadata" };
  for (const worker of [...new Set(patch.appWorkers)].sort()) {
    env[appBindingName(worker)] = { type: "worker", worker };
  }
  config.env = env;

  // The gateway scopes its session cookie to APP_BASE_DOMAIN, and apps
  // find it by dropping their first label (apps/every-app-gateway's
  // server/app-hosts.ts): it must be the gateway's own host. One above
  // it would hand the cookie to every other name in the company's zone.
  if (patch.gatewayHost !== patch.appBaseDomain) {
    throw new EveryAppError(
      "INVALID_APP_BASE_DOMAIN",
      `Apps live one label below the gateway host ${patch.gatewayHost}, so APP_BASE_DOMAIN must be ${patch.gatewayHost}, not ${patch.appBaseDomain}.`,
    );
  }
  // Apps are published one by one; a stray host would take over a name
  // in the zone the registry has no business with.
  const stray = patch.appHosts.filter(
    (host) => !isOneLabelBelow(host, patch.appBaseDomain),
  );
  if (stray.length > 0) {
    throw new EveryAppError(
      "INVALID_APP_HOST",
      `Refusing to publish ${stray.join(", ")} on the gateway: app hosts are one label below ${patch.appBaseDomain}.`,
    );
  }
  env["APP_BASE_DOMAIN"] = { type: "text", value: patch.appBaseDomain };
  config.domains = gatewayDomains(patch);
  // No route: a host the gateway serves is one of its Custom Domains.
  const otherTriggers = (config.triggers ?? []).filter(
    (trigger) => trigger["type"] !== "fetch",
  );
  if (otherTriggers.length > 0) config.triggers = otherTriggers;
  else delete config.triggers;
  config.workersDev = false;
  config.previewUrls = false;
  config.observability ??= structuredClone(EVERYAPP_OBSERVABILITY);

  // cf uploads source maps only as listed modules; list every one.
  if (config.manifest) {
    const modules = { ...(config.manifest.modules ?? {}) };
    for (const map of await listSourceMaps(path.join(releaseDir, BUNDLE_DIR))) {
      modules[map] = { type: "sourcemap" };
    }
    config.manifest = { ...config.manifest, modules };
  }

  validateWorkerConfig(config, { requireDomain: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/**
 * Check a Build Output Worker config with the schema cf itself reads it
 * with, and that nothing still waits for a deploy-time value.
 */
export function validateWorkerConfig(
  config: unknown,
  { requireDomain = false }: { requireDomain?: boolean } = {},
): void {
  try {
    validateWorkerBuildOutput(config, { requireDomain });
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
}

/** Every `.map` file under `bundleDir`, relative to it with `/` separators. */
export async function listSourceMaps(bundleDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(bundleDir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) =>
      path
        .relative(bundleDir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}
