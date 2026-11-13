/**
 * `env.EVERYAPP_MANIFEST`, for a Worker built with an SDK that still
 * declares it (docs/design/2026-11-worker-manifest.md).
 *
 * The Gateway's registry is the manifest's one home, and a Worker built
 * with today's SDK holds no copy. One built before (SDK 0.3.3 and earlier)
 * declares the manifest as a JSON variable and reads it at run time, and a
 * Cloudflare variable holds 5 KB at most (error 10054 at the upload). So an
 * installer fills the binding only for a build that declares it, through
 * {@link workerManifest}: the manifest as written when it fits, else
 * without the text written for whoever sets the app up (`why`, `how`,
 * `docs`, a feature's `steps`). A build that declares it with a manifest
 * that fits neither way is refused before anything is created.
 *
 * All of this goes when no installed release declares the binding.
 */

/** The binding an older `everyAppWorker()` declares the manifest as. */
export const WORKER_MANIFEST_BINDING = "EVERYAPP_MANIFEST";

/**
 * The most the binding may weigh, as compact UTF-8 JSON, which is what
 * Cloudflare measures (a 7,083-byte manifest was refused as "7.1 kB",
 * against a limit of "5.1 kB": 5 KiB, 5,120 bytes). The rest is margin.
 */
export const WORKER_MANIFEST_MAX_BYTES = 5000;

/** What a need (`EveryAppSettingNeed`), a secret or a setting says to whoever sets it. */
const SETUP_TEXT = ["why", "how", "docs"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function without(value: unknown, keys: readonly string[]): unknown {
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function each(list: unknown, keys: readonly string[]): unknown {
  return Array.isArray(list) ? list.map((entry) => without(entry, keys)) : list;
}

/** `manifest` without its setup text, by where the manifest keeps it: never by key alone, since ids are keys too. */
function withoutSetupText(manifest: Json): Json {
  const result: Json = { ...manifest };
  for (const key of ["providers", "secrets", "settings"]) {
    if (key in result) result[key] = each(result[key], SETUP_TEXT);
  }
  if (isObject(result["capabilities"])) {
    result["capabilities"] = Object.fromEntries(
      Object.entries(result["capabilities"]).map(([id, entry]) => [
        id,
        without(entry, SETUP_TEXT),
      ]),
    );
  }
  if (isObject(result["features"])) {
    result["features"] = Object.fromEntries(
      Object.entries(result["features"]).map(([id, feature]) => {
        if (!isObject(feature)) return [id, feature];
        const kept = without(feature, ["why", "steps"]) as Json;
        for (const key of ["secrets", "settings"]) {
          if (key in kept) kept[key] = each(kept[key], SETUP_TEXT);
        }
        return [id, kept];
      }),
    );
  }
  if (isObject(result["ai"]) && isObject(result["ai"]["chat"])) {
    // `chat: { why }` says the same as `chat: true` once the reason is gone.
    result["ai"] = { ...result["ai"], chat: true };
  }
  if (isObject(result["events"])) {
    result["events"] = without(result["events"], ["why"]);
  }
  return result;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * What an installer writes as `env.EVERYAPP_MANIFEST` for `manifest`, in a
 * build that declares it: the
 * manifest itself when it fits one Cloudflare variable, else the manifest
 * without its setup text; null when neither fits (or it isn't an object).
 */
export function workerManifest<T>(manifest: T): T | null {
  if (!isObject(manifest)) return null;
  if (bytes(manifest) <= WORKER_MANIFEST_MAX_BYTES) return manifest;
  const reduced = withoutSetupText(manifest);
  return bytes(reduced) <= WORKER_MANIFEST_MAX_BYTES ? (reduced as T) : null;
}

/** Why a build that declares the binding can't be installed with `manifest`, as a sentence; null when it can. */
export function workerManifestProblem(manifest: unknown): string | null {
  if (!isObject(manifest) || workerManifest(manifest)) return null;
  const size = bytes(withoutSetupText(manifest)).toLocaleString("en-US");
  const limit = WORKER_MANIFEST_MAX_BYTES.toLocaleString("en-US");
  return `this build was made with an SDK that puts the manifest in the app's Worker, where it is ${size} bytes as JSON even without its setup text (why, how, docs, steps), and one Cloudflare variable holds ${limit} at most; rebuild the app with a newer @every-app/sdk, which doesn't`;
}
