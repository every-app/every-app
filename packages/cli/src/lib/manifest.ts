import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import {
  ManifestError,
  validateManifestStrict,
  type EveryAppManifest,
} from "@every-app/perimeter/manifest";

// The shared strict manifest schema covers every CLI field (including the
// dev command string), so the CLI adds nothing on top.
export type EveryAppCliManifest = EveryAppManifest;

export async function loadEveryAppManifest(
  cwd: string,
): Promise<EveryAppCliManifest> {
  return loadEveryAppManifestFile(
    path.join(cwd, "everyapp.config.ts"),
    "No everyapp.config.ts found in the current directory — run this command from an app root.",
  );
}

/**
 * The manifest of the app in `cwd`, or null when there is no
 * everyapp.config.ts there (a command that works outside an app directory
 * too, like `secret`). One that is there but invalid still throws.
 */
export async function loadEveryAppManifestIfPresent(
  cwd: string,
): Promise<EveryAppCliManifest | null> {
  try {
    await fs.access(path.join(cwd, "everyapp.config.ts"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return loadEveryAppManifest(cwd);
}

/**
 * An app's manifest from its file (`register --manifest`), validated as a
 * deploy validates the app's own.
 */
export async function loadEveryAppManifestFile(
  manifestPath: string,
  missing = `No manifest at ${manifestPath}.`,
): Promise<EveryAppCliManifest> {
  try {
    await fs.access(manifestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ManifestError(missing);
    }
    throw error;
  }

  const jiti = createJiti(pathToFileURL(manifestPath).href);
  const raw = await jiti.import(manifestPath, { default: true });
  return validateManifestStrict(raw);
}

// An absent `migrations` field means drizzle against the first D1 binding, on
// both the deploy and dev-preflight paths. Diverging would silently skip the
// preflight for every app that doesn't spell the field out — which is all of
// the example apps.
export function resolveMigrationBinding(
  d1Bindings: readonly string[],
  migrations: EveryAppManifest["migrations"],
): string {
  const migrationBinding = migrations?.binding ?? d1Bindings[0]!;
  if (!d1Bindings.includes(migrationBinding)) {
    throw new Error(
      `Manifest migrations binding "${migrationBinding}" is not declared in resources.d1.`,
    );
  }
  return migrationBinding;
}
