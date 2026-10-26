/**
 * The provider specs an app bundles: `.everyapp/providers/<id>.json` in its
 * directory (what `everyapp provider add` writes there, and `provider show
 * <id> --save`), committed with the app so whoever deploys or installs it
 * gets the providers it needs registered on their Gateway. `everyapp dev`
 * reads the same files (the SDK's devProviders.ts); `everyapp release`
 * carries them in release.json as `providers`, and `everyapp deploy` and
 * `install` register them after one confirmation (commands/deploy/steps/
 * bundledProviders.ts). A spec names settings and never holds a value, so
 * the files are safe to commit and to ship.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { DEV_PROVIDERS_DIR } from "@every-app/sdk/internal";
import { isNotFoundError } from "@/lib/file-operations";

/** One bundled spec: where it came from, and its JSON (or its text when it isn't JSON). */
export interface BundledProviderSpec {
  /** `.everyapp/providers/stripe.json`, or `release.json#providers[0]` for a release's. */
  file: string;
  spec: unknown;
}

/** The specs under `dir`'s `.everyapp/providers`, in name order; none without the directory. */
export async function readBundledProviderSpecs(dir: string): Promise<BundledProviderSpec[]> {
  const root = path.join(dir, DEV_PROVIDERS_DIR);
  let names: string[];
  try {
    names = (await fs.readdir(root)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const specs: BundledProviderSpec[] = [];
  for (const name of names) {
    const file = `${DEV_PROVIDERS_DIR}/${name}`;
    const text = await fs.readFile(path.join(root, name), "utf8");
    let spec: unknown;
    try {
      spec = JSON.parse(text);
    } catch {
      spec = text;
    }
    specs.push({ file, spec });
  }
  return specs;
}

/** A release's `providers` as bundled specs, each named by its place in release.json. */
export function releasedProviderSpecs(providers: readonly unknown[] | undefined): BundledProviderSpec[] {
  return (providers ?? []).map((spec, index) => ({ file: `release.json#providers[${index}]`, spec }));
}

/**
 * JSON with its object keys sorted at every level, so two specs that say
 * the same thing compare equal however they were written.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
