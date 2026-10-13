/**
 * Turn the gateway release's Build Output into this install's gateway: its
 * resource ids, a service binding per bound app, its domain and route, and
 * the release stamp, then validate the result with `@cloudflare/config`'s
 * own Build Output schema before cf ever sees it.
 *
 * Routing for now: the gateway host is a Workers Custom Domain, and app
 * hosts (`<app>-<org>.<gateway host>`) reach the gateway through a
 * `*.<gateway host>/*` route over the wildcard DNS record the operator adds.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { OutputWorkerSchema } from "@cloudflare/config";
import { EVERYAPP_OBSERVABILITY } from "@every-app/sdk/cloudflare";
import {
  APP_BINDING_PREFIX,
  appBindingName,
} from "@every-app/perimeter/manifest";
import { EveryAppError } from "@/lib/errors";

export const GATEWAY_WORKER_CONFIG = path.join(
  ".cloudflare",
  "output",
  "v0",
  "workers",
  "default",
  "worker.config.json",
);
const BUNDLE_DIR = path.join(".cloudflare", "output", "v0", "workers", "default", "bundle");
const PATCH_PLACEHOLDER = "__EVERYAPP_PATCH__";
const GATEWAY_D1_NAME = "every-app-gateway";

interface GatewayPatch {
  d1Id: string;
  oauthKvId: string;
  release: { version: string; sha256: string };
  gatewayHost: string;
  zoneId: string;
  /** Workers to bind as APP__<worker>. */
  appWorkers: readonly string[];
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
export async function patchGatewayBuildOutput(
  releaseDir: string,
  patch: GatewayPatch,
): Promise<WorkerConfig> {
  const configPath = path.join(releaseDir, GATEWAY_WORKER_CONFIG);
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as WorkerConfig;
  const env = { ...(config.env ?? {}) };

  for (const name of Object.keys(env)) {
    if (name.startsWith(APP_BINDING_PREFIX)) delete env[name];
  }
  // The gateway never used its KV namespace; deploys stop binding it.
  delete env["KV"];
  env["DB"] = { type: "d1", name: GATEWAY_D1_NAME, id: patch.d1Id };
  env["OAUTH_KV"] = { type: "kv", id: patch.oauthKvId };
  env["EVERYAPP_RELEASE"] = { type: "json", value: patch.release };
  env["CF_VERSION_METADATA"] = { type: "version-metadata" };
  for (const worker of [...new Set(patch.appWorkers)].sort()) {
    env[appBindingName(worker)] = { type: "worker", worker };
  }
  config.env = env;

  config.domains = [patch.gatewayHost];
  config.triggers = [
    ...(config.triggers ?? []).filter((trigger) => trigger["type"] !== "fetch"),
    { type: "fetch", pattern: `*.${patch.gatewayHost}/*`, zone: patch.zoneId },
  ];
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
  const parsed = OutputWorkerSchema.safeParse(config);
  if (!parsed.success) {
    throw new EveryAppError(
      "INVALID_BUILD_OUTPUT",
      `The patched Worker config isn't valid Build Output: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  if (JSON.stringify(config).includes(PATCH_PLACEHOLDER)) {
    throw new EveryAppError(
      "INVALID_BUILD_OUTPUT",
      "The Worker config still has a deploy-time placeholder.",
    );
  }
  if (requireDomain && !parsed.data.domains?.length) {
    throw new EveryAppError(
      "INVALID_BUILD_OUTPUT",
      "The gateway has no domain to deploy to.",
    );
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
